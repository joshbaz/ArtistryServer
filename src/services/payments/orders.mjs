import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateMember, invalidateSite } from '../../utils/sockets.js';
import { openForVotes } from '../voting/campaigns.mjs';
import { activePass, grantPass, revokePassFor } from '../voting/vip.mjs';
import { takeTodaysVote } from '../voting/freeVotes.mjs';
import { getStatus, submitOrder } from './pesapal.mjs';
import { orderCharges, totalOf } from './charges.mjs';
import { afterEarning } from './maintenance.mjs';
import { activeRental, grantPlan, grantRental, hasActivePlan, revokePlan, revokeRental } from '../streaming/access.mjs';
import { getPublicTitle } from '../streaming/titles.mjs';
import { periodDays } from '../streaming/billingPeriods.mjs';
import { includedInPlan, ppvStage } from '../streaming/pricing.mjs';
import { HOLD_MS, checkFreeLimit, fulfil, priceTicketOrder, releaseHold, releaseSeats, reserveSeats, voidOrderTickets } from '../tickets/checkout.mjs';
import { issueTickets, toIssued } from '../tickets/tickets.mjs';
import { sendTicketsEmail } from '../tickets/email.mjs';
import { ticketsChanged } from '../tickets/events.mjs';
import { notifyStaff } from '../studio/notifications.mjs';

/**
 * Checkout orders (10-voting.md, decision 3). An order is made here, paid on
 * PesaPal's page, and moves on from pending only on PesaPal's word: its IPN,
 * or our own status check when the payer comes back to the site. The votes
 * (or a streaming plan's days, or a rental) are added in the same transaction
 * that marks the order completed, so they can never be added twice, however
 * many times PesaPal or the payer asks.
 */

export const MAX_VOTES = 10_000;
// A payer coming back asks often; PesaPal is asked at most this often per order.
const RECHECK_MS = 3_000;
// Checkouts nobody finished are closed after this.
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

const notFound = () => new AppError('We could not find that payment.', 404);

/** A reference PesaPal shows the payer: short, unique, and not guessable from the last one. */
const newReference = () => `A360-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** What the payer's page may know about their own order (a paid ticket order: its codes). */
const toPayerView = (o, tickets = null) => ({
    reference: o.reference,
    module: o.module,
    status: o.status,
    kind: o.kind,
    votes: o.votes,
    amountUGX: o.amountUGX,
    chargesUGX: totalOf(o) - o.amountUGX,
    totalUGX: totalOf(o),
    campaignId: o.campaignId,
    participantId: o.participantId,
    ...(o.module === 'streaming' ? { planId: o.planId ?? undefined, titleId: o.titleId ?? undefined, itemName: o.itemName ?? '' } : {}),
    ...(o.module === 'tickets' ? { eventId: o.ticketEventId, itemName: o.itemName ?? '', tickets: tickets ? tickets.map(toIssued) : [] } : {}),
});

const changed = (order) => {
    // Revenue and the activity feed on the Studio's overview, and the maintenance balance.
    invalidate('admin', ['admin', 'overview']);
    invalidate('admin', ['admin', 'maintenance']);
    if (order.module === 'tickets') {
        // Seats left on the ticket pages, and the Studio's sales list.
        ticketsChanged(order.ticketEventId);
        return;
    }
    if (order.module === 'streaming') {
        // The member's plan or rental on every device, and Finance's lists.
        invalidateMember(order.memberId);
        invalidate('admin', ['admin', 'stream-payments'], { id: order.id });
        invalidate('admin', ['admin', 'subscribers']);
        return;
    }
    invalidateSite('campaigns', { id: order.campaignId });
    invalidate('admin', ['admin', 'campaigns'], { id: order.campaignId });
};

/**
 * Start buying votes for a contestant. The price is the campaign's, worked
 * out here; the page only says how many. No sign-in needed: PesaPal knows the
 * payer. No payment details are ever kept: only PesaPal's references.
 * @returns {Promise<{ reference: string, redirectUrl: string }>}
 */
export const createVoteOrder = async ({ campaignId, participantId, votes, memberId }) => {
    const { campaign, contestant } = await openForVotes(campaignId, participantId);
    return checkout(
        // A buyer who happens to be signed in is noted, for the Studio's vote list; nobody has to be.
        { kind: 'votes', campaignId, participantId, votes, amountUGX: votes * campaign.votePriceUGX, memberId: memberId ?? null },
        `${votes} vote${votes === 1 ? '' : 's'} for ${contestant.fullName}, ${campaign.title}`,
    );
};

/**
 * Start buying a VIP pass for the signed-in voter (10-voting.md). The price
 * and the votes it adds at once (the campaign's VIP votes a day, for this
 * contestant) are the campaign's, fixed into the order now.
 * @returns {Promise<{ reference: string, redirectUrl: string }>}
 */
export const createVipOrder = async ({ campaignId, participantId, memberId }) => {
    const { campaign, contestant } = await openForVotes(campaignId, participantId);
    if (await activePass(campaignId, memberId)) throw new AppError("You're already a VIP voter in this campaign.", 409, { code: 'already_vip' });
    return checkout(
        { kind: 'vip', campaignId, participantId, memberId, votes: campaign.vipDailyVotes, amountUGX: campaign.vipPriceUGX },
        `VIP voter pass, ${campaign.title} (${campaign.vipDailyVotes} votes now for ${contestant.fullName})`,
    );
};

/**
 * Start paying for a streaming plan or a pay-per-view title, for the
 * signed-in member. Paying for a plan while one is running adds its days on
 * top (a renewal); a title already rented and still watchable can't be bought again.
 * @returns {Promise<{ reference: string, redirectUrl: string }>}
 */
export const createStreamOrder = async ({ kind, planId, titleId, expectedPriceUGX, memberId }) => {
    const back = { module: 'streaming', callbackUrl: `${env.STREAM_URL}/payment/return` };
    if (kind === 'subscription') {
        const plan = await prisma.streamPlan.findFirst({ where: { id: planId, active: true } });
        if (!plan) throw new AppError("That plan isn't available any more.", 404);
        const renewal = await hasActivePlan(memberId);
        return checkout(
            { kind: renewal ? 'renewal' : 'subscription', planId: plan.id, periodDays: await periodDays(plan.interval), memberId, amountUGX: plan.priceUGX, itemName: `${plan.name} plan` },
            `${plan.name} plan, The Artistry360 Stream`,
            back,
        );
    }
    const title = await getPublicTitle(titleId);
    if (title.access.tier !== 'ppv') throw new AppError(title.access.tier === 'free' ? 'This title is free to watch.' : 'This title comes with a plan, not on its own.', 409, { code: 'not_for_sale' });
    if (await activeRental(memberId, titleId)) throw new AppError('You already have this title. Press play to watch it.', 409, { code: 'already_rented' });
    // The price is the stage's at this moment, and the order keeps it: paying after the stage changes costs what was shown.
    const stored = { accessTier: 'ppv', priceUGX: title.access.priceUGX, ppv: title.access.ppv ?? null };
    const now = Date.now();
    if (includedInPlan(stored, now) && (await hasActivePlan(memberId))) {
        throw new AppError('This film comes with your plan. Press play to watch it.', 409, { code: 'included_in_plan' });
    }
    const { stage, priceUGX } = ppvStage(stored, now);
    if (expectedPriceUGX !== undefined && expectedPriceUGX !== priceUGX) {
        const { totalUGX } = await orderCharges(priceUGX);
        throw new AppError(`The price is now UGX ${priceUGX.toLocaleString('en-UG')}.`, 409, { code: 'price_changed', details: { stage, priceUGX, totalUGX } });
    }
    return checkout({ kind: 'ppv', titleId, memberId, amountUGX: priceUGX, ppvStage: stage, itemName: title.title }, `Watch: ${title.title}, The Artistry360 Stream`, back);
};

/**
 * Record the order with its charges on top of the price, then hand it to
 * PesaPal for the total; the payer goes to the page it answers with.
 */
const checkout = async (fields, description, { module = 'voting', callbackUrl } = {}) => {
    const order = await prisma.paymentOrder.create({
        data: {
            ...fields,
            ...(await orderCharges(fields.amountUGX)),
            reference: newReference(),
            module,
            // Written out: on MongoDB, Prisma's `field: null` filter doesn't match a missing field.
            completedAt: null,
        },
    });
    try {
        const { trackingId, redirectUrl } = await submitOrder({
            reference: order.reference,
            amountUGX: totalOf(order),
            description,
            // PesaPal adds ?OrderTrackingId=…&OrderMerchantReference=…. For voting, paid in the site's
            // PesaPal window, this small page tells the window it's done; paid in a full tab, it goes on
            // to the campaign page, which checks the order from those. The stream site's return page
            // checks the order the same way.
            callbackUrl: callbackUrl ?? `${env.APP_URL}/payment/return/${order.campaignId}`,
        });
        await prisma.paymentOrder.update({ where: { id: order.id }, data: { trackingId } });
        return { reference: order.reference, redirectUrl };
    } catch (error) {
        await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: 'failed', statusNote: 'provider_unreachable' } });
        if (order.seatsHeld) await releaseHold(order);
        error.orderRecorded = true;
        throw error;
    }
};

/**
 * Start buying tickets (docs/20, section 4). No sign-in: the buyer gives a
 * name, email and phone (the phone is used for nothing and not kept). The
 * server prices the order from the stored types and takes the seats at
 * once, holding them while PesaPal is open; the codes are made only when
 * PesaPal confirms. A free order (total 0) skips PesaPal: its tickets are
 * made and answered straight away.
 * @returns {Promise<{ reference: string, redirectUrl: string } | { reference: string, amountUGX: 0, tickets: object[] }>}
 */
export const createTicketOrder = async ({ eventId, items, buyer, answers }) => {
    const { event, priced, count, amountUGX, answers: kept } = await priceTicketOrder({ eventId, items, answers });
    const email = buyer.email.trim().toLowerCase();
    if (amountUGX === 0) await checkFreeLimit(event, email, count);
    await reserveSeats(event.id, priced);
    const fields = { kind: 'ticket', ticketEventId: event.id, ticketItems: priced, buyerName: buyer.name, buyerEmail: email, ticketAnswers: kept, amountUGX, itemName: event.title };

    if (amountUGX === 0) {
        let made;
        try {
            made = await prisma.$transaction(async (tx) => {
                const order = await tx.paymentOrder.create({
                    data: { ...fields, reference: newReference(), module: 'tickets', provider: 'free', status: 'completed', completedAt: new Date(), seatsHeld: false, maintenanceUGX: 0, pesapalFeeUGX: 0, totalUGX: 0 },
                });
                const tickets = await issueTickets(tx, { eventId: event.id, items: priced, buyerName: buyer.name, email, orderId: order.id, orderRef: order.reference, answers: kept });
                return { order, tickets };
            });
        } catch (error) {
            await releaseSeats(event.id, priced);
            throw error;
        }
        sendTicketsEmail({ event, tickets: made.tickets, to: email, buyerName: buyer.name, reference: made.order.reference, totalUGX: 0 });
        changed(made.order);
        return { reference: made.order.reference, amountUGX: 0, tickets: made.tickets.map(toIssued) };
    }

    try {
        return await checkout(
            { ...fields, seatsHeld: true, holdExpiresAt: new Date(Date.now() + HOLD_MS) },
            `${count} ticket${count === 1 ? '' : 's'}: ${event.title}`,
            { module: 'tickets', callbackUrl: `${env.APP_URL}/payment/return/tickets/${encodeURIComponent(event.id)}` },
        );
    } catch (error) {
        // No order was recorded, so nothing else holds these seats.
        if (!error.orderRecorded) await releaseSeats(event.id, priced);
        throw error;
    }
};

/**
 * Bring an order up to date with PesaPal. Each change of status happens once,
 * guarded by the status it changes from.
 * @param {object} order - A PaymentOrder row
 */
const settle = async (order) => {
    if (!order.trackingId || !['pending', 'completed'].includes(order.status)) return order;
    const now = new Date();
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { lastCheckedAt: now } });
    const paid = await getStatus(order.trackingId);

    if (paid.state === 'completed' && order.status === 'pending') {
        // Paid less, in another currency, or for another order: never add votes for it.
        if (paid.amount < totalOf(order) || paid.currency !== 'UGX' || paid.reference !== order.reference) {
            console.error(`Order ${order.reference}: PesaPal reports ${paid.amount} ${paid.currency} for ${paid.reference}; not counted`);
            await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed', statusNote: 'amount_mismatch', method: paid.method } });
            if (order.kind === 'ticket') await releaseHold(order);
            return prisma.paymentOrder.findUnique({ where: { id: order.id } });
        }
        let issued = null;
        const done = await prisma.$transaction(async (tx) => {
            const { count } = await tx.paymentOrder.updateMany({
                where: { id: order.id, status: 'pending' },
                data: { status: 'completed', completedAt: now, method: paid.method, confirmationCode: paid.confirmationCode },
            });
            if (count && order.kind === 'ticket') issued = await fulfil(tx, order);
            if (count && order.participantId && order.votes) {
                await tx.contestant.update({ where: { id: order.participantId }, data: { platformVotes: { increment: order.votes } } });
            }
            if (count && order.kind === 'vip' && order.memberId) await grantPass(tx, order, order.votes);
            if (count && order.module === 'streaming') {
                if (order.titleId) await grantRental(tx, order, now);
                else await grantPlan(tx, order, paid.method);
            }
            return count;
        });
        if (done && order.kind === 'ticket') {
            if (issued) {
                const event = await prisma.ticketEvent.findUnique({ where: { id: order.ticketEventId } });
                if (event) sendTicketsEmail({ event, tickets: issued, to: order.buyerEmail, buyerName: order.buyerName, reference: order.reference, totalUGX: totalOf(order) });
            } else {
                // Paid after the seats went to someone else: no tickets, and the money goes back by hand.
                console.error(`Ticket order ${order.reference} was paid after its seats were sold; refund it`);
                notifyStaff('ticket-refund', {
                    subject: `Refund a ticket payment: ${order.reference}`,
                    heading: 'A ticket payment arrived after its seats were sold',
                    lines: [`Order ${order.reference} (${order.itemName ?? 'tickets'}) was paid, but the seats had gone by then, so no tickets were issued. Refund it in PesaPal.`],
                    path: '/studio/tickets',
                });
            }
        }
        if (done) {
            // The VIP votes just added are today's: the voter's next one opens in 24 hours.
            if (order.kind === 'vip' && order.memberId) await takeTodaysVote(order.campaignId, order.memberId, now).catch(() => {});
            changed(order);
            // Not awaited: an email about the balance never holds up PesaPal's IPN.
            afterEarning(order.maintenanceUGX ?? 0);
        }
    } else if (paid.state === 'failed' && order.status === 'pending') {
        await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed', method: paid.method } });
        if (order.kind === 'ticket') await releaseHold(order);
        changed(order);
    } else if (paid.state === 'reversed') {
        // A refunded or charged-back payment takes its votes back with it.
        const undone = await prisma.$transaction(async (tx) => {
            const { count } = await tx.paymentOrder.updateMany({ where: { id: order.id, status: order.status }, data: { status: order.status === 'completed' ? 'reversed' : 'failed' } });
            if (count && order.status === 'completed' && order.participantId && order.votes) {
                await tx.contestant.update({ where: { id: order.participantId }, data: { platformVotes: { decrement: order.votes } } });
            }
            if (count && order.status === 'completed' && order.kind === 'vip') await revokePassFor(tx, order.id);
            if (count && order.status === 'completed' && order.kind === 'ticket') await voidOrderTickets(tx, order);
            if (count && order.status === 'completed' && order.module === 'streaming') {
                if (order.titleId) await revokeRental(tx, order);
                else await revokePlan(tx, order);
            }
            return count;
        });
        // Reversed before it completed: its held seats go back.
        if (undone && order.status === 'pending' && order.kind === 'ticket') await releaseHold(order);
        if (undone) changed(order);
    }
    return prisma.paymentOrder.findUnique({ where: { id: order.id } });
};

/**
 * The payer's own order, after PesaPal sent them back. A pending one is
 * checked with PesaPal first (at most every few seconds).
 * @param {string} reference
 */
export const getForPayer = async (reference) => {
    let order = await prisma.paymentOrder.findUnique({ where: { reference } });
    if (!order) throw notFound();
    const recent = order.lastCheckedAt && Date.now() - order.lastCheckedAt.getTime() < RECHECK_MS;
    if (order.status === 'pending' && !recent) {
        // PesaPal briefly unreachable: still pending, and the page asks again.
        order = await settle(order).catch(() => order);
    }
    const tickets = order.kind === 'ticket' && order.status === 'completed' ? await prisma.ticket.findMany({ where: { orderId: order.id }, orderBy: { code: 'asc' } }) : null;
    return toPayerView(order, tickets);
};

/**
 * PesaPal's IPN: it names an order whose status changed, and we ask PesaPal
 * what that change was (never trusting the call itself). The answer is what
 * PesaPal expects back; status 500 asks it to try again later.
 */
export const handleIpn = async ({ OrderTrackingId: trackingId, OrderMerchantReference: reference, OrderNotificationType: type }) => {
    const reply = (status) => ({ orderNotificationType: type ?? 'IPNCHANGE', orderTrackingId: trackingId ?? '', orderMerchantReference: reference ?? '', status });
    const order = reference ? await prisma.paymentOrder.findUnique({ where: { reference } }) : null;
    if (!order || !trackingId || order.trackingId !== trackingId) return reply(200);
    try {
        await settle(order);
        return reply(200);
    } catch (error) {
        console.error(`IPN for ${reference} failed:`, error.message);
        return reply(500);
    }
};

/**
 * Close checkouts nobody finished: each gets a last check with PesaPal,
 * and one still unpaid after a day is marked failed. Run by the scheduler.
 * @returns {Promise<number>} how many were closed
 */
export const expireStaleOrders = async () => {
    const stale = await prisma.paymentOrder.findMany({ where: { status: 'pending', createdAt: { lt: new Date(Date.now() - EXPIRE_AFTER_MS) } }, take: 100 });
    let closed = 0;
    for (const order of stale) {
        const now = order.trackingId ? await settle(order).catch(() => order) : order;
        if (now.status !== 'pending') continue;
        const { count } = await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed', statusNote: 'expired' } });
        if (count && order.kind === 'ticket') await releaseHold(order);
        closed += count;
    }
    return closed;
};

/**
 * Ticket checkouts whose hold has run out (docs/20, section 9): a last
 * check with PesaPal, then the seats go back on sale. The order itself stays
 * open a while: if PesaPal confirms later, the seats are taken again if
 * they're still free. Run by the scheduler every minute.
 * @returns {Promise<number>} how many holds were let go
 */
export const releaseExpiredHolds = async () => {
    const due = await prisma.paymentOrder.findMany({ where: { kind: 'ticket', status: 'pending', seatsHeld: true, holdExpiresAt: { lt: new Date() } }, take: 200 });
    let released = 0;
    for (const order of due) {
        const now = order.trackingId ? await settle(order).catch(() => order) : order;
        if (now.status === 'pending' && (await releaseHold(order))) {
            released += 1;
            changed(order);
        }
    }
    return released;
};

/**
 * Every voting payment for the Studio, newest first, with the campaign and
 * contestant it was for (Voting › Transactions).
 */
export const listVotingOrders = async () => {
    const orders = await prisma.paymentOrder.findMany({ where: { module: 'voting' }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const [campaigns, contestants] = await Promise.all([
        prisma.campaign.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.campaignId).filter(Boolean))] } }, select: { id: true, title: true } }),
        prisma.contestant.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.participantId).filter(Boolean))] } }, select: { id: true, fullName: true } }),
    ]);
    const titles = new Map(campaigns.map((c) => [c.id, c.title]));
    const names = new Map(contestants.map((c) => [c.id, c.fullName]));
    // The Studio also sees what was paid on top; organisers (toVoteOrderRow alone) see the price.
    return orders.map((o) => ({ ...toVoteOrderRow(titles, names)(o), chargesUGX: totalOf(o) - o.amountUGX, totalUGX: totalOf(o) }));
};

/** An order as the Studio's and the organiser's payment lists show it. */
export const toVoteOrderRow = (titles, names) => (o) => ({
    id: o.id,
    reference: o.reference,
    campaignId: o.campaignId,
    participantId: o.participantId ?? undefined,
    kind: o.kind,
    votes: o.votes,
    amountUGX: o.amountUGX,
    method: o.method || 'PesaPal',
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    campaignTitle: titles.get(o.campaignId) ?? 'Deleted campaign',
    contestantName: o.participantId ? names.get(o.participantId) ?? 'Removed contestant' : '',
});

/* Streaming */

const streamItemName = (o) => o.itemName || (o.titleId ? 'A title' : 'A plan');

/** Studio › Streaming › Transactions: every streaming payment, newest first, with who paid (their account email). */
export const listStreamingOrders = async () => {
    const orders = await prisma.paymentOrder.findMany({ where: { module: 'streaming' }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const members = await prisma.member.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.memberId).filter(Boolean))] } }, select: { id: true, name: true, email: true } });
    const byId = new Map(members.map((m) => [m.id, m]));
    return orders.map((o) => ({
        id: o.id,
        reference: o.reference,
        kind: o.kind,
        payerName: byId.get(o.memberId)?.name || (o.memberId ? 'Member' : 'Deleted account'),
        payerEmail: byId.get(o.memberId)?.email ?? '',
        planId: o.planId ?? undefined,
        titleId: o.titleId ?? undefined,
        amountUGX: o.amountUGX,
        chargesUGX: totalOf(o) - o.amountUGX,
        totalUGX: totalOf(o),
        method: o.method || 'PesaPal',
        // A refunded payment counts as not paid in the Studio's totals.
        status: o.status === 'reversed' ? 'failed' : o.status,
        createdAt: o.createdAt.toISOString(),
        itemName: streamItemName(o),
    }));
};

/** A member's own streaming receipts (Account › Payments): paid and refunded, newest first. */
export const listMemberPayments = async (memberId) => {
    const orders = await prisma.paymentOrder.findMany({ where: { memberId, module: 'streaming', status: { in: ['completed', 'reversed'] } }, orderBy: { createdAt: 'desc' }, take: 500 });
    return orders.map((o) => ({
        id: o.id,
        kind: o.titleId ? 'purchase' : 'subscription',
        planId: o.planId ?? undefined,
        titleId: o.titleId ?? undefined,
        description: o.titleId ? `Watch: ${streamItemName(o)} (24 hours)` : `${streamItemName(o)}${o.kind === 'renewal' ? ' (renewal)' : ''}`,
        // The receipt: the price, the charges on top, and what was paid.
        amountUGX: o.amountUGX,
        chargesUGX: totalOf(o) - o.amountUGX,
        totalUGX: totalOf(o),
        method: o.method || 'PesaPal',
        // Ours, the one the Studio's Transactions list shows, for support queries.
        reference: o.reference,
        status: o.status === 'reversed' ? 'refunded' : 'paid',
        paidAt: (o.completedAt ?? o.createdAt).toISOString(),
    }));
};

/**
 * The Studio's Check (Transactions, Finance): ask PesaPal about one payment
 * now, whatever its state. Paid: it completes, adding its votes, plan or
 * rental, in the same guarded transaction as the IPN. A checkout closed after
 * a day unpaid is opened again for the check, in case the money came late,
 * and closed again if PesaPal still says unpaid. Refunds are picked up too.
 * → { reference, status, changed, message }
 */
export const checkForStudio = async (reference) => {
    const before = await prisma.paymentOrder.findUnique({ where: { reference } });
    if (!before) throw notFound();
    if (!before.trackingId) throw new AppError("This payment never reached PesaPal, so there's nothing to check.", 409, { code: 'not_at_pesapal' });

    const expired = before.status === 'failed' && before.statusNote === 'expired';
    if (expired) await prisma.paymentOrder.updateMany({ where: { id: before.id, status: 'failed' }, data: { status: 'pending', statusNote: null } });

    let after;
    try {
        after = await settle(await prisma.paymentOrder.findUnique({ where: { id: before.id } }));
    } catch (error) {
        if (expired) await prisma.paymentOrder.updateMany({ where: { id: before.id, status: 'pending' }, data: { status: 'failed', statusNote: 'expired' } });
        console.error(`Check of ${reference} failed:`, error.message);
        throw new AppError("We couldn't reach PesaPal just now. Try again in a moment.", 502, { code: 'provider_unreachable' });
    }
    if (expired && after.status === 'pending') {
        await prisma.paymentOrder.updateMany({ where: { id: before.id, status: 'pending' }, data: { status: 'failed', statusNote: 'expired' } });
        after = await prisma.paymentOrder.findUnique({ where: { id: before.id } });
    }

    const what = after.module === 'streaming' ? (after.titleId ? 'The rental is on.' : "The plan's time was added.") : `${after.votes.toLocaleString('en')} vote${after.votes === 1 ? '' : 's'} added.`;
    const message = {
        completed: before.status === 'completed' ? 'Already paid. Nothing to add.' : `PesaPal confirms it's paid. ${what}`,
        pending: "PesaPal hasn't received this payment yet.",
        failed: before.status === 'failed' ? 'PesaPal still says this payment was not made.' : "PesaPal says this payment wasn't made.",
        reversed: 'PesaPal says this payment was refunded; what it added was taken back.',
    }[after.status];
    return { reference, status: after.status, changed: after.status !== before.status, message };
};
