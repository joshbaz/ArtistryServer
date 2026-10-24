import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { openForVotes } from '../voting/campaigns.mjs';
import { getStatus, submitOrder } from './pesapal.mjs';

/**
 * Checkout orders (10-voting.md, decision 3). An order is made here, paid on
 * PesaPal's page, and moves on from pending only on PesaPal's word: its IPN,
 * or our own status check when the payer comes back to the site. The votes
 * are added in the same transaction that marks the order completed, so they
 * can never be added twice, however many times PesaPal or the payer asks.
 */

export const MAX_VOTES = 10_000;
// A payer coming back asks often; PesaPal is asked at most this often per order.
const RECHECK_MS = 3_000;
// Checkouts nobody finished are closed after this.
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

const notFound = () => new AppError('We could not find that payment.', 404);

/** A reference PesaPal shows the payer: short, unique, and not guessable from the last one. */
const newReference = () => `A360-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** What the payer's page may know about their own order. */
const toPayerView = (o) => ({
    reference: o.reference,
    status: o.status,
    kind: o.kind,
    votes: o.votes,
    amountUGX: o.amountUGX,
    campaignId: o.campaignId,
    participantId: o.participantId,
});

const changed = (order) => {
    invalidateSite('campaigns', { id: order.campaignId });
    invalidate('admin', ['admin', 'campaigns'], { id: order.campaignId });
};

/**
 * Start buying votes for a contestant. The price is the campaign's, worked
 * out here; the page only says how many. No sign-in: PesaPal knows the payer.
 * @returns {Promise<{ reference: string, redirectUrl: string }>}
 */
export const createVoteOrder = async ({ campaignId, participantId, votes }) => {
    const { campaign, contestant } = await openForVotes(campaignId, participantId);
    const order = await prisma.paymentOrder.create({
        data: {
            reference: newReference(),
            module: 'voting',
            kind: 'votes',
            campaignId,
            participantId,
            votes,
            amountUGX: votes * campaign.votePriceUGX,
            // Written out: on MongoDB, Prisma's `field: null` filter doesn't match a missing field.
            completedAt: null,
        },
    });
    try {
        const { trackingId, redirectUrl } = await submitOrder({
            reference: order.reference,
            amountUGX: order.amountUGX,
            description: `${votes} vote${votes === 1 ? '' : 's'} for ${contestant.fullName}, ${campaign.title}`,
            // PesaPal adds ?OrderTrackingId=…&OrderMerchantReference=…; the campaign page checks the order from those.
            callbackUrl: `${env.APP_URL}/voting/${campaignId}`,
        });
        await prisma.paymentOrder.update({ where: { id: order.id }, data: { trackingId } });
        return { reference: order.reference, redirectUrl };
    } catch (error) {
        await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: 'failed', statusNote: 'provider_unreachable' } });
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
        if (paid.amount < order.amountUGX || paid.currency !== 'UGX' || paid.reference !== order.reference) {
            console.error(`Order ${order.reference}: PesaPal reports ${paid.amount} ${paid.currency} for ${paid.reference}; not counted`);
            await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed', statusNote: 'amount_mismatch', method: paid.method } });
            return prisma.paymentOrder.findUnique({ where: { id: order.id } });
        }
        const done = await prisma.$transaction(async (tx) => {
            const { count } = await tx.paymentOrder.updateMany({
                where: { id: order.id, status: 'pending' },
                data: { status: 'completed', completedAt: now, method: paid.method, confirmationCode: paid.confirmationCode },
            });
            if (count && order.kind === 'votes' && order.participantId) {
                await tx.contestant.update({ where: { id: order.participantId }, data: { platformVotes: { increment: order.votes } } });
            }
            return count;
        });
        if (done) changed(order);
    } else if (paid.state === 'failed' && order.status === 'pending') {
        await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'pending' }, data: { status: 'failed', method: paid.method } });
        changed(order);
    } else if (paid.state === 'reversed') {
        // A refunded or charged-back payment takes its votes back with it.
        const undone = await prisma.$transaction(async (tx) => {
            const { count } = await tx.paymentOrder.updateMany({ where: { id: order.id, status: order.status }, data: { status: order.status === 'completed' ? 'reversed' : 'failed' } });
            if (count && order.status === 'completed' && order.kind === 'votes' && order.participantId) {
                await tx.contestant.update({ where: { id: order.participantId }, data: { platformVotes: { decrement: order.votes } } });
            }
            return count;
        });
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
    return toPayerView(order);
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
        closed += count;
    }
    return closed;
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
    return orders.map(toVoteOrderRow(titles, names));
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
