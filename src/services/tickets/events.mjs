import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { recordChange } from '../system/audit.mjs';
import { dropFiles, storeImages } from '../streaming/media.mjs';

/**
 * Tickets the Studio posts (Website › Tickets) and the pages that sell them
 * (docs/20-ticketing-backend-handoff.md). An event has one or more ticket
 * types, each with a price and a number of seats.
 *
 * Seats are counted on the type itself (`taken`: sold and held), and only
 * ever changed by reserveSeats and releaseSeats, which compare-and-set it:
 * two buyers can never both get the last seat, and `taken` never passes
 * `seats`.
 */

export const DEFAULT_MAX_PER_ORDER = 10;
const iso = (d) => (d ? d.toISOString() : null);
const notFound = () => new AppError('We could not find that ticket.', 404);
const fieldError = (field, message, status = 422) => new AppError(message, status, { details: { fieldErrors: { [field]: [message] } } });

export const maxPerOrderOf = (event) => event.maxPerOrder || DEFAULT_MAX_PER_ORDER;

/** "upcoming" before its sales start, "ended" after they end, else "open", on the server's clock. */
export const windowOf = (type, now = Date.now()) => {
    if (type.onSaleFrom && now < type.onSaleFrom.getTime()) return 'upcoming';
    if (type.onSaleUntil && now >= type.onSaleUntil.getTime()) return 'ended';
    return 'open';
};

const typesOf = (eventIds) => prisma.ticketType.findMany({ where: { eventId: { in: eventIds } }, orderBy: { position: 'asc' } });

/** Tickets sold (valid or used, never void) per event and type: "eventId|typeKey" → n. */
const soldCounts = async (eventIds) => {
    const rows = await prisma.ticket.groupBy({ by: ['eventId', 'typeKey'], where: { eventId: { in: eventIds }, status: { in: ['valid', 'used'] } }, _count: { _all: true } });
    return new Map(rows.map((r) => [`${r.eventId}|${r.typeKey}`, r._count._all]));
};

const studioType = (t, sold) => ({
    id: t.key,
    name: t.name,
    priceUGX: t.priceUGX,
    seats: t.seats,
    sold,
    perk: t.perk,
    onSaleFrom: iso(t.onSaleFrom),
    onSaleUntil: iso(t.onSaleUntil),
});

const base = (e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    image: e.image,
    startsAt: iso(e.startsAt),
    venue: e.venue,
    organizer: e.organizer,
    category: e.category,
    maxPerOrder: maxPerOrderOf(e),
    terms: e.terms,
    questions: e.questions ?? [],
});

/** As the Studio reads it: every field, and how many of each type are sold. */
const toStudio = (e, types, sold) => ({
    ...base(e),
    maxPerOrder: e.maxPerOrder ?? null,
    status: e.status,
    types: types.map((t) => studioType(t, sold.get(`${e.id}|${t.key}`) ?? 0)),
    createdAt: iso(e.createdAt),
});

/** As the website reads it: seats left instead of capacity, and what can be bought right now. */
const toPublic = (e, types, now = Date.now()) => {
    const shown = types.map((t) => {
        const seatsLeft = Math.max(0, t.seats - t.taken);
        return { id: t.key, name: t.name, priceUGX: t.priceUGX, perk: t.perk, seatsLeft, soldOut: seatsLeft === 0, window: windowOf(t, now), onSaleFrom: iso(t.onSaleFrom), onSaleUntil: iso(t.onSaleUntil) };
    });
    const buyable = shown.filter((t) => t.window === 'open' && !t.soldOut);
    const prices = (buyable.length ? buyable : shown).map((t) => t.priceUGX);
    return {
        ...base(e),
        status: e.status,
        types: shown,
        soldOut: shown.length > 0 && shown.every((t) => t.soldOut),
        fromUGX: prices.length ? Math.min(...prices) : 0,
    };
};

const byEvent = (types) => {
    const map = new Map();
    for (const t of types) map.set(t.eventId, [...(map.get(t.eventId) ?? []), t]);
    return map;
};

/* Public */

/** Events on sale (a Closed one keeps its page but isn't listed). */
export const listOnSale = async () => {
    const events = await prisma.ticketEvent.findMany({ where: { status: 'On sale' }, orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }] });
    const types = byEvent(await typesOf(events.map((e) => e.id)));
    const now = Date.now();
    return events.map((e) => toPublic(e, types.get(e.id) ?? [], now));
};

/** One ticket page: a draft or an unknown id is a 404. */
export const getPublicEvent = async (id) => {
    const e = await prisma.ticketEvent.findUnique({ where: { id } });
    if (!e || e.status === 'Draft') throw notFound();
    return toPublic(e, await typesOf([e.id]));
};

/* Studio */

export const listEvents = async () => {
    const events = await prisma.ticketEvent.findMany({ orderBy: { createdAt: 'desc' } });
    const ids = events.map((e) => e.id);
    const [types, sold] = await Promise.all([typesOf(ids), soldCounts(ids)]);
    const grouped = byEvent(types);
    return events.map((e) => toStudio(e, grouped.get(e.id) ?? [], sold));
};

const studioView = async (e) => toStudio(e, await typesOf([e.id]), await soldCounts([e.id]));

export const getEvent = async (id) => {
    const e = await prisma.ticketEvent.findUnique({ where: { id } });
    if (!e) throw notFound();
    return e;
};

const changed = (id) => invalidateSite('tickets', { id });

const newKey = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const toDate = (v) => (v ? new Date(v) : null);

/** Questions keep the ids the Studio gave them, so answers stay matched up; new ones get one. */
const toQuestions = (questions) => {
    const seen = new Set();
    return questions.map((q) => {
        let id = q.id && !seen.has(q.id) ? q.id : newKey('q');
        while (seen.has(id)) id = newKey('q');
        seen.add(id);
        return { ...q, id };
    });
};

/** What the audit log keeps for an event: what changes money and seats. */
const auditView = (e, types) => ({ status: e.status, types: types.map((t) => ({ id: t.key, name: t.name, priceUGX: t.priceUGX, seats: t.seats })) });

/**
 * The event's types as sent (the whole list): each one updated, added, or
 * removed. A type can't drop below the seats it has sold or holds, and one
 * with any taken can't be removed. A new price only reaches new orders:
 * each order keeps the prices it was made at.
 */
const saveTypes = async (eventId, sent) => {
    const current = await prisma.ticketType.findMany({ where: { eventId } });
    const byKey = new Map(current.map((t) => [t.key, t]));
    const keys = new Set();
    const rows = sent.map((t, position) => {
        let key = t.id && !keys.has(t.id) ? t.id : newKey('tt');
        while (keys.has(key)) key = newKey('tt');
        keys.add(key);
        return { ...t, key, position };
    });
    for (const t of rows) {
        const old = byKey.get(t.key);
        if (old && t.seats < old.taken) throw fieldError('types', `${t.name} has ${old.taken} seats sold or held, so it can't have fewer than that.`);
    }
    const removed = current.filter((t) => !keys.has(t.key));
    const busy = removed.find((t) => t.taken > 0);
    if (busy) throw new AppError(`${busy.name} has sold tickets, so it can't be removed. Set its seats to what's sold instead.`, 409, { code: 'type_has_sales' });

    for (const t of rows) {
        const data = { name: t.name, priceUGX: t.priceUGX, seats: t.seats, perk: t.perk ?? '', onSaleFrom: toDate(t.onSaleFrom), onSaleUntil: toDate(t.onSaleUntil), position: t.position };
        const old = byKey.get(t.key);
        if (old) {
            // Seats only if nothing was taken since they were checked above.
            const { count } = await prisma.ticketType.updateMany({ where: { id: old.id, taken: { lte: t.seats } }, data });
            if (!count) throw fieldError('types', `${t.name} sold more seats just now. Check its seats and save again.`, 409);
        } else {
            await prisma.ticketType.create({ data: { ...data, eventId, key: t.key } });
        }
    }
    if (removed.length) await prisma.ticketType.deleteMany({ where: { id: { in: removed.map((t) => t.id) }, taken: 0 } });
};

const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ticket';

export const createEvent = async ({ types, questions, ...input }, by) => {
    await storeImages(input, ['image']);
    const data = { ...input, startsAt: toDate(input.startsAt), questions: toQuestions(questions) };
    let event = null;
    for (let n = 1; n < 50 && !event; n += 1) {
        const id = `tkt_${slugOf(input.title)}${n === 1 ? '' : `-${n}`}`;
        event = await prisma.ticketEvent.create({ data: { ...data, id } }).catch((error) => {
            if (error.code !== 'P2002') throw error;
            return null;
        });
    }
    if (!event) throw new AppError('Give the ticket a different title.', 409);
    await saveTypes(event.id, types);
    const view = await studioView(event);
    recordChange(by, 'ticket-event', event.id, null, auditView(event, await typesOf([event.id])));
    changed(event.id);
    return view;
};

export const updateEvent = async (id, { types, questions, ...patch }, by) => {
    const current = await getEvent(id);
    const before = auditView(current, await typesOf([id]));
    await storeImages(patch, ['image']);
    if (types) await saveTypes(id, types);
    const data = { ...patch, ...('startsAt' in patch ? { startsAt: toDate(patch.startsAt) } : {}), ...(questions ? { questions: toQuestions(questions) } : {}) };
    const event = await prisma.ticketEvent.update({ where: { id }, data });
    if (current.image !== event.image) dropFiles([current.image]);
    recordChange(by, 'ticket-event', id, before, auditView(event, await typesOf([id])));
    changed(id);
    return studioView(event);
};

/** 409 has_sales once any ticket exists (or a checkout holds seats): close it instead. */
export const deleteEvent = async (id, by) => {
    const current = await prisma.ticketEvent.findUnique({ where: { id } });
    if (!current) return;
    const types = await typesOf([id]);
    if ((await prisma.ticket.count({ where: { eventId: id } })) || types.some((t) => t.taken > 0)) {
        throw new AppError('Tickets were sold for this. Close it instead of deleting it.', 409, { code: 'has_sales' });
    }
    await prisma.ticketType.deleteMany({ where: { eventId: id } });
    await prisma.ticketEvent.delete({ where: { id } });
    dropFiles([current.image]);
    recordChange(by, 'ticket-event', id, auditView(current, types), null);
    changed(id);
};

/* Seats */

const soldOut = (name) => new AppError(`${name} tickets are sold out or have too few left.`, 409, { code: 'sold_out' });

/**
 * Takes `qty` seats of each type, all or nothing: → the types, as they were.
 * Each take is a compare-and-set on `taken`, retried a few times when
 * another buyer got in between, so the last seat goes to exactly one.
 * @param {{ typeId: string, qty: number }[]} items
 */
export const reserveSeats = async (eventId, items, db = prisma) => {
    const done = [];
    try {
        for (const item of items) {
            let taken = false;
            let type = null;
            for (let attempt = 0; attempt < 5 && !taken; attempt += 1) {
                type = await db.ticketType.findUnique({ where: { eventId_key: { eventId, key: item.typeId } } });
                if (!type) throw new AppError('That ticket type is not available.', 422);
                if (type.seats - type.taken < item.qty) throw soldOut(type.name);
                const { count } = await db.ticketType.updateMany({ where: { id: type.id, taken: type.taken, seats: type.seats }, data: { taken: { increment: item.qty } } });
                taken = count === 1;
            }
            if (!taken) throw soldOut(type.name);
            done.push(item);
        }
    } catch (error) {
        await releaseSeats(eventId, done, db);
        throw error;
    }
};

/** Gives seats back (a failed or expired checkout, a void ticket). */
export const releaseSeats = async (eventId, items, db = prisma) => {
    for (const item of items) {
        await db.ticketType.updateMany({ where: { eventId, key: item.typeId, taken: { gte: item.qty } }, data: { taken: { decrement: item.qty } } });
    }
};

/** The event and its types as stored, for pricing an order. */
export const eventForSale = async (id) => {
    const event = await prisma.ticketEvent.findUnique({ where: { id } });
    if (!event || event.status === 'Draft') throw notFound();
    return { event, types: await typesOf([id]) };
};

export const ticketsChanged = changed;
