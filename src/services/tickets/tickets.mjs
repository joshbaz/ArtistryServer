import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { recordChange } from '../system/audit.mjs';
import { getEvent, maxPerOrderOf, releaseSeats, reserveSeats, ticketsChanged } from './events.mjs';
import { emailTicketsNow, sendTicketsEmail } from './email.mjs';
import { isMailConfigured } from '../emails/zohoMail.js';

/**
 * Tickets: one per seat, made only once a payment is confirmed (or at once
 * for a free or complimentary one), each with a code the door scans. Who
 * bought is shown only in the Studio's sales list and the buyer's own order.
 */

const iso = (d) => (d ? d.toISOString() : null);

// No look-alikes (0/O, 1/I), so a code can be read out at the door.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => `TKT-${Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')}`;

/** `n` codes no ticket has yet, from a secure random source. */
const freshCodes = async (n, db) => {
    const codes = new Set();
    while (codes.size < n) {
        const batch = Array.from({ length: n - codes.size }, newCode).filter((c) => !codes.has(c));
        const taken = new Set((await db.ticket.findMany({ where: { code: { in: batch } }, select: { code: true } })).map((t) => t.code));
        for (const c of batch) if (!taken.has(c)) codes.add(c);
    }
    return [...codes];
};

/** One sold ticket as the Studio's sales list and check-in see it. No phone is kept. */
export const toSale = (t) => ({
    id: t.code,
    code: t.code,
    eventId: t.eventId,
    typeId: t.typeKey,
    typeName: t.typeName,
    buyerName: t.buyerName,
    email: t.email,
    phone: '',
    amountUGX: t.amountUGX,
    paidAt: iso(t.issuedAt),
    orderRef: t.orderRef,
    status: t.status,
    usedAt: iso(t.usedAt),
    source: t.source,
    ...(t.source === 'complimentary' ? { note: t.note, issuedBy: t.issuedBy } : {}),
    answers: t.answers ?? {},
    accessCode: t.accessCode ?? null,
});

/** What the buyer's page gets for each ticket. */
export const toIssued = (t) => ({ code: t.code, typeId: t.typeKey, typeName: t.typeName });

/**
 * Makes the tickets for these seats (already taken by reserveSeats).
 * @param {object} db - prisma, or a transaction
 * @param {{ eventId: string, items: { typeId: string, name: string, qty: number, priceUGX: number }[], buyerName: string, email: string, orderId?: string, orderRef: string, source?: string, note?: string, issuedBy?: string, answers?: object }} sale
 */
export const issueTickets = async (db, { eventId, items, buyerName, email, orderId = null, orderRef, source = 'purchase', note = '', issuedBy = '', answers = null }) => {
    const count = items.reduce((n, i) => n + i.qty, 0);
    const codes = await freshCodes(count, db);
    const rows = items.flatMap((i) => Array.from({ length: i.qty }, () => ({ eventId, typeKey: i.typeId, typeName: i.name, buyerName, email, amountUGX: i.priceUGX, orderId, orderRef, source, note, issuedBy, answers: answers ?? undefined, accessCode: i.accessCode ?? null, code: codes.pop() })));
    await db.ticket.createMany({ data: rows });
    // Every use of an access code is in the audit log.
    for (const i of items.filter((x) => x.accessCode)) recordChange(null, 'ticket-code-use', eventId, null, { code: i.accessCode, typeId: i.typeId, qty: i.qty, orderRef });
    return db.ticket.findMany({ where: { code: { in: rows.map((r) => r.code) } }, orderBy: { code: 'asc' } });
};

/* Studio */

/** Who bought, newest first. */
export const listSales = async (eventId) => {
    await getEvent(eventId);
    return (await prisma.ticket.findMany({ where: { eventId }, orderBy: { issuedAt: 'desc' }, take: 20_000 })).map(toSale);
};

/**
 * Complimentary tickets (a guest, cast, press): no payment, amount 0, the
 * same seat check and order limit as a purchase. `by` (the session) is who issued them.
 */
export const issueComplimentary = async (eventId, { typeId, qty, name, email, note }, by) => {
    const event = await getEvent(eventId);
    const type = await prisma.ticketType.findUnique({ where: { eventId_key: { eventId, key: typeId } } });
    if (!type) throw new AppError('That ticket type is not available.', 422);
    if (qty > maxPerOrderOf(event)) throw new AppError(`Issue 1 to ${maxPerOrderOf(event)} tickets at a time.`, 422);
    const items = [{ typeId, name: type.name, qty, priceUGX: 0 }];
    await reserveSeats(eventId, items).catch((error) => {
        if (error.code === 'sold_out') throw new AppError(`${type.name} has only ${Math.max(0, type.seats - type.taken)} seats left.`, 409, { code: 'sold_out' });
        throw error;
    });
    let tickets;
    try {
        const orderRef = `TKT-COMP-${Date.now().toString(36).toUpperCase()}`;
        tickets = await issueTickets(prisma, { eventId, items, buyerName: name, email: (email ?? '').toLowerCase(), orderRef, source: 'complimentary', note, issuedBy: by?.name ?? '' });
    } catch (error) {
        await releaseSeats(eventId, items);
        throw error;
    }
    recordChange(by, 'ticket-issue', eventId, null, { typeId, qty, name, note, codes: tickets.map((t) => t.code) });
    if (email) sendTicketsEmail({ event, tickets, to: email, buyerName: name, reference: tickets[0].orderRef, totalUGX: 0, complimentary: true });
    ticketsChanged(eventId);
    return tickets.map(toSale);
};

/**
 * Emails a ticket's whole order again (every ticket in it that isn't void),
 * with the PDF, to the address it was bought or issued with.
 */
export const resendTickets = async (code, by) => {
    const ticket = await prisma.ticket.findUnique({ where: { code } });
    if (!ticket) throw new AppError('We could not find that ticket.', 404);
    if (!ticket.email) throw new AppError('This ticket has no email address to send it to.', 409, { code: 'no_email' });
    if (!isMailConfigured()) throw new AppError("Email isn't set up on the server yet, so nothing can be sent.", 409, { code: 'mail_off' });
    const [event, order, all] = await Promise.all([
        getEvent(ticket.eventId),
        ticket.orderId ? prisma.paymentOrder.findUnique({ where: { id: ticket.orderId }, select: { totalUGX: true, amountUGX: true } }) : null,
        prisma.ticket.findMany({ where: { orderRef: ticket.orderRef, status: { not: 'void' } }, orderBy: { code: 'asc' } }),
    ]);
    if (!all.length) throw new AppError('Every ticket in this order is void.', 409, { code: 'all_void' });
    try {
        await emailTicketsNow({ event, tickets: all, to: ticket.email, buyerName: ticket.buyerName, reference: ticket.orderRef, totalUGX: order?.totalUGX ?? order?.amountUGX ?? 0, complimentary: ticket.source === 'complimentary' });
    } catch (error) {
        console.error(`Resending ${ticket.orderRef} failed:`, error.message);
        throw new AppError("The email didn't go. Try again in a moment.", 502, { code: 'send_failed' });
    }
    recordChange(by, 'ticket-resend', code, null, { to: ticket.email, orderRef: ticket.orderRef, tickets: all.length });
    return { sent: all.length, to: ticket.email };
};

/** Voids a ticket (a refund, a lost or duplicate one): it fails check-in and frees its seat. Not once it's used. */
export const voidTicket = async (code, by) => {
    const ticket = await prisma.ticket.findUnique({ where: { code } });
    if (!ticket) throw new AppError('We could not find that ticket.', 404);
    if (ticket.status === 'used') throw new AppError('That ticket was already checked in.', 409, { code: 'already_used' });
    if (ticket.status === 'void') return toSale(ticket);
    const { count } = await prisma.ticket.updateMany({ where: { code, status: 'valid' }, data: { status: 'void' } });
    if (!count) return voidTicket(code, by);
    await releaseSeats(ticket.eventId, [{ typeId: ticket.typeKey, qty: 1, ...(ticket.accessCode ? { accessCode: ticket.accessCode } : {}) }]);
    recordChange(by, 'ticket-void', code, { status: ticket.status }, { status: 'void' });
    ticketsChanged(ticket.eventId);
    return toSale({ ...ticket, status: 'void' });
};

/**
 * At the door: "valid" marks it used, at once and only once (two phones
 * scanning together can't both get valid); "used" says when; "wrong_event"
 * is a real ticket for another event, left as it is; "invalid" is no such
 * code, or a void ticket.
 */
export const checkIn = async ({ code, eventId }, by) => {
    const ticket = await prisma.ticket.findUnique({ where: { code } });
    if (!ticket || ticket.status === 'void') return { result: 'invalid' };
    if (eventId && ticket.eventId !== eventId) {
        const event = await prisma.ticketEvent.findUnique({ where: { id: ticket.eventId }, select: { title: true } });
        return { result: 'wrong_event', ticket: toSale(ticket), eventTitle: event?.title ?? '' };
    }
    const now = new Date();
    const { count } = await prisma.ticket.updateMany({ where: { code, status: 'valid' }, data: { status: 'used', usedAt: now } });
    const after = await prisma.ticket.findUnique({ where: { code } });
    if (count) {
        recordChange(by, 'ticket-check-in', code, { status: 'valid' }, { status: 'used', usedAt: now.toISOString(), eventId: ticket.eventId });
        ticketsChanged(ticket.eventId);
        return { result: 'valid', ticket: toSale(after) };
    }
    return after.status === 'used' ? { result: 'used', ticket: toSale(after) } : { result: 'invalid' };
};

/** The door's offline list: names and codes only (no email, phone or answers). Every download is audited. */
export const guestList = async (eventId, by) => {
    await getEvent(eventId);
    const tickets = await prisma.ticket.findMany({ where: { eventId, status: { in: ['valid', 'used'] } }, select: { code: true, typeName: true, buyerName: true, status: true }, orderBy: { buyerName: 'asc' } });
    recordChange(by, 'ticket-guest-list', eventId, null, { downloadedAt: new Date().toISOString(), tickets: tickets.length });
    return tickets;
};

/**
 * Check-ins made offline, replayed oldest first. A ticket still valid is
 * marked used at the time it really happened (`at`, kept between the event's
 * creation and now); one someone else got in first stays as it was. Replaying
 * the same list changes nothing more.
 */
export const syncCheckIns = async ({ eventId, checkIns }, by) => {
    const event = await getEvent(eventId);
    const now = Date.now();
    const results = [];
    const admitted = [];
    for (const { code, at } of [...checkIns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const ticket = /^TKT-[A-Z0-9]{8}$/.test(code) ? await prisma.ticket.findUnique({ where: { code } }) : null;
        if (!ticket || ticket.status === 'void' || ticket.eventId !== eventId) {
            results.push({ code, result: 'invalid' });
            continue;
        }
        const when = new Date(Math.min(now, Math.max(event.createdAt.getTime(), Date.parse(at))));
        const { count } = await prisma.ticket.updateMany({ where: { code, status: 'valid' }, data: { status: 'used', usedAt: when } });
        if (count) admitted.push({ code, at: when.toISOString() });
        results.push({ code, result: count ? 'valid' : 'used' });
    }
    if (admitted.length) {
        recordChange(by, 'ticket-check-in', eventId, null, { offline: true, admitted });
        ticketsChanged(eventId);
    }
    return results;
};
