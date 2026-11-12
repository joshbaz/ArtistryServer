import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { eventForSale, maxPerOrderOf, releaseSeats, reserveSeats, windowOf } from './events.mjs';
import { issueTickets } from './tickets.mjs';
import { badCode, codeFor, normalizeCode } from './accessCodes.mjs';

/**
 * Buying tickets (docs/20, sections 4 and 9), the parts payments/orders.mjs
 * calls: pricing an order from the stored types (never the page's amounts),
 * holding its seats while PesaPal is open, and making the tickets once it's paid.
 */

/** How long a checkout holds its seats. */
export const HOLD_MS = 10 * 60 * 1000;

/**
 * The order as the server prices it: the types bought (with their prices
 * now, which the order keeps), the total, and the answers checked against
 * the event's questions. Seats are checked when they're taken, not here.
 */
export const priceTicketOrder = async ({ eventId, items, answers = {} }) => {
    const { event, types } = await eventForSale(eventId);
    if (event.status !== 'On sale') throw new AppError('Tickets for this are not on sale.', 409, { code: 'not_on_sale' });

    const qty = new Map();
    const codes = new Map();
    for (const i of items) {
        qty.set(i.ticketTypeId, (qty.get(i.ticketTypeId) ?? 0) + i.qty);
        // One code per type in an order.
        if (i.accessCode && codes.has(i.ticketTypeId) && normalizeCode(codes.get(i.ticketTypeId)) !== normalizeCode(i.accessCode)) throw badCode();
        if (i.accessCode) codes.set(i.ticketTypeId, i.accessCode);
    }
    const count = [...qty.values()].reduce((n, q) => n + q, 0);
    const limit = maxPerOrderOf(event);
    if (count < 1) throw new AppError('Choose at least one ticket.', 422);
    if (count > limit) throw new AppError(`You can buy up to ${limit} tickets at a time.`, 422);

    const now = Date.now();
    const priced = [];
    for (const [typeId, n] of qty) {
        const type = types.find((t) => t.key === typeId);
        if (!type) throw new AppError('That ticket type is not available.', 422);
        if (windowOf(type, now) !== 'open') throw new AppError(`${type.name} tickets are not on sale right now.`, 409, { code: 'not_open' });
        // A restricted type needs a code for it with room for these tickets (taken for real with the seats).
        const code = type.restricted ? (await codeFor(event.id, typeId, codes.get(typeId), n)).code : null;
        priced.push({ typeId, name: type.name, qty: n, priceUGX: type.priceUGX, ...(code ? { accessCode: code } : {}) });
    }

    const kept = {};
    for (const q of event.questions ?? []) {
        const a = String(answers[q.id] ?? '').trim();
        if (q.required && !a) throw new AppError(`Please answer: ${q.label}`, 422);
        if (a.length > 120) throw new AppError(`Keep the answer to "${q.label}" under 120 characters.`, 422);
        if (a && q.kind === 'choice' && !q.options?.includes(a)) throw new AppError(`Choose one of the options for: ${q.label}`, 422);
        if (a && q.kind === 'agree' && a !== 'Yes') throw new AppError(`Please tick: ${q.label}`, 422);
        if (a) kept[q.id] = a;
    }
    return { event, priced, count, amountUGX: priced.reduce((sum, i) => sum + i.qty * i.priceUGX, 0), answers: kept };
};

/** Free tickets are the easiest to hoard: one email gets at most an order's worth per event. */
export const checkFreeLimit = async (event, email, count) => {
    const had = await prisma.ticket.count({ where: { eventId: event.id, email, amountUGX: 0, source: 'purchase', status: { not: 'void' } } });
    const limit = maxPerOrderOf(event);
    if (had + count > limit) throw new AppError(`One email can get up to ${limit} free tickets for this.${had ? ` You have ${had} already.` : ''}`, 409, { code: 'free_limit' });
};

export { reserveSeats, releaseSeats };

/** Lets go of a checkout's held seats, once (a failed, reversed or expired one). → whether it did. */
export const releaseHold = async (order) => {
    const { count } = await prisma.paymentOrder.updateMany({ where: { id: order.id, seatsHeld: true }, data: { seatsHeld: false } });
    if (count) await releaseSeats(order.ticketEventId, order.ticketItems ?? []);
    return count > 0;
};

/**
 * Inside the transaction that marks a ticket order paid: its held seats
 * become sold and its tickets are made, at the prices the order kept. If the
 * hold had expired, the seats are taken again; if they've gone meanwhile,
 * the order fails instead (→ null) and the payment is for Finance to refund.
 */
export const fulfil = async (tx, order) => {
    const { count: held } = await tx.paymentOrder.updateMany({ where: { id: order.id, seatsHeld: true }, data: { seatsHeld: false } });
    if (!held) {
        try {
            await reserveSeats(order.ticketEventId, order.ticketItems, tx);
        } catch (error) {
            if (error.code !== 'sold_out' && error.code !== 'bad_code') throw error;
            await tx.paymentOrder.update({ where: { id: order.id }, data: { status: 'failed', statusNote: error.code === 'bad_code' ? 'code_gone' : 'seats_gone' } });
            return null;
        }
    }
    return issueTickets(tx, {
        eventId: order.ticketEventId,
        items: order.ticketItems,
        buyerName: order.buyerName ?? '',
        email: order.buyerEmail ?? '',
        orderId: order.id,
        orderRef: order.reference,
        answers: order.ticketAnswers ?? null,
    });
};

/** A reversed payment: its tickets are void and their seats free again. → how many. */
export const voidOrderTickets = async (tx, order) => {
    const tickets = await tx.ticket.findMany({ where: { orderId: order.id, status: { in: ['valid', 'used'] } }, select: { id: true, typeKey: true, accessCode: true } });
    if (!tickets.length) return 0;
    await tx.ticket.updateMany({ where: { id: { in: tickets.map((t) => t.id) } }, data: { status: 'void' } });
    const byType = new Map();
    for (const t of tickets) {
        const k = `${t.typeKey}|${t.accessCode ?? ''}`;
        byType.set(k, { typeId: t.typeKey, qty: (byType.get(k)?.qty ?? 0) + 1, ...(t.accessCode ? { accessCode: t.accessCode } : {}) });
    }
    await releaseSeats(order.ticketEventId, [...byType.values()], tx);
    return tickets.length;
};
