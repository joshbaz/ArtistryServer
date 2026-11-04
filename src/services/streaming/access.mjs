import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * Who may watch what on the stream site and the app. A free title is for
 * everyone; a subscription title for a member whose plan is paid up; a
 * pay-per-view title for a member who rented it (24 hours from first play).
 * Plans and rentals are only ever granted by a completed PesaPal payment
 * (payments/orders.mjs), in the same transaction that marks it paid.
 */

/** How long each plan interval lasts. */
export const PLAN_DAYS = { month: 30, quarter: 91, year: 365 };
const DAY = 24 * 3600 * 1000;
export const RENTAL_HOURS = 24;
// A rental not yet started stays waiting this long.
const RENTAL_START_DAYS = 30;
// A plan that ran out this recently still shows to Finance, as past due.
const PAST_DUE_DAYS = 30;

const isActive = (sub, now = Date.now()) => Boolean(sub && sub.currentPeriodEnd.getTime() > now);

/**
 * The member's plan, as their account shows it, or null when they have none
 * paid up. It stays `active` to the end of what's paid, cancelled or not (the
 * stream site and the app open titles on `active`); cancelAtPeriodEnd says it won't be renewed.
 */
const toSubscription = (sub) =>
    isActive(sub) ? { planId: sub.planId, status: 'active', renewsAt: sub.currentPeriodEnd.toISOString(), cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null;

const activeRentals = (memberId, now = new Date()) => prisma.streamRental.findMany({ where: { memberId, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });

/** → { subscription, purchases: titleIds rented and still watchable, rentals: [{ titleId, expiresAt, started }] } */
export const getAccess = async (memberId) => {
    const [sub, rentals] = await Promise.all([prisma.streamSubscription.findUnique({ where: { memberId } }), activeRentals(memberId)]);
    return {
        subscription: toSubscription(sub),
        purchases: [...new Set(rentals.map((r) => r.titleId))],
        rentals: rentals.map((r) => ({ titleId: r.titleId, expiresAt: r.expiresAt.toISOString(), started: Boolean(r.firstPlayedAt) })),
    };
};

export const hasActivePlan = async (memberId) => isActive(await prisma.streamSubscription.findUnique({ where: { memberId } }));

export const activeRental = async (memberId, titleId) =>
    prisma.streamRental.findFirst({ where: { memberId, titleId, expiresAt: { gt: new Date() } }, orderBy: { expiresAt: 'desc' } });

/**
 * Whether this member may play this title now (`title` as stored). A
 * rental's 24 hours start on its first play, here.
 */
export const mayWatch = async (memberId, title) => {
    if (title.accessTier === 'free') return true;
    if (!memberId) return false;
    if (title.accessTier === 'subscription') return hasActivePlan(memberId);
    const rental = await activeRental(memberId, title.id);
    if (!rental) return false;
    if (!rental.firstPlayedAt) {
        const now = new Date();
        await prisma.streamRental.updateMany({ where: { id: rental.id, firstPlayedAt: null }, data: { firstPlayedAt: now, expiresAt: new Date(now.getTime() + RENTAL_HOURS * 3600 * 1000) } });
    }
    return true;
};

/* Granting and taking back, inside the payment's transaction (`tx`) */

/** A paid plan: its days go on top of what's left, or start now. Changing plan takes the new one. */
export const grantPlan = async (tx, order, method) => {
    const now = new Date();
    const sub = await tx.streamSubscription.findUnique({ where: { memberId: order.memberId } });
    const from = isActive(sub) ? sub.currentPeriodEnd : now;
    const currentPeriodEnd = new Date(from.getTime() + order.periodDays * DAY);
    const data = { planId: order.planId, currentPeriodEnd, cancelAtPeriodEnd: false, method: method ?? '', lastOrderId: order.id };
    await tx.streamSubscription.upsert({ where: { memberId: order.memberId }, create: { memberId: order.memberId, startedAt: now, ...data }, update: isActive(sub) ? data : { ...data, startedAt: now } });
};

/** A refunded plan payment takes its days back off. */
export const revokePlan = async (tx, order) => {
    const sub = await tx.streamSubscription.findUnique({ where: { memberId: order.memberId } });
    if (!sub) return;
    await tx.streamSubscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() - order.periodDays * DAY) } });
};

export const grantRental = (tx, order) =>
    // firstPlayedAt written out: on MongoDB a `null` filter doesn't match a missing field, and mayWatch looks for null.
    tx.streamRental.create({ data: { memberId: order.memberId, titleId: order.titleId, orderId: order.id, firstPlayedAt: null, expiresAt: new Date(Date.now() + RENTAL_START_DAYS * DAY) } });

export const revokeRental = (tx, order) => tx.streamRental.deleteMany({ where: { orderId: order.id } });

/* The member's own plan */

/** Stop (or restart) the reminders to renew. Access runs to the end of what's paid either way. */
export const setCancelAtPeriodEnd = async (memberId, cancel) => {
    const sub = await prisma.streamSubscription.findUnique({ where: { memberId } });
    if (!isActive(sub)) throw new AppError("There's no active plan.", 409, { code: 'no_plan' });
    await prisma.streamSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: cancel } });
    return getAccess(memberId);
};

/* Finance */

/** Studio › Streaming › Subscribers: paid-up plans, and ones that ran out in the last month (past due). */
export const listSubscribers = async () => {
    const now = Date.now();
    const subs = await prisma.streamSubscription.findMany({ where: { currentPeriodEnd: { gt: new Date(now - PAST_DUE_DAYS * DAY) } }, orderBy: { currentPeriodEnd: 'desc' } });
    const members = await prisma.member.findMany({ where: { id: { in: subs.map((s) => s.memberId) } }, select: { id: true, name: true, email: true } });
    const byId = new Map(members.map((m) => [m.id, m]));
    return subs
        .filter((s) => byId.has(s.memberId))
        .map((s) => ({
            id: s.id,
            name: byId.get(s.memberId).name || 'Member',
            email: byId.get(s.memberId).email ?? '',
            planId: s.planId,
            status: !isActive(s, now) ? 'past_due' : s.cancelAtPeriodEnd ? 'cancelled' : 'active',
            method: s.method || 'PesaPal',
            renewsAt: s.currentPeriodEnd.toISOString(),
        }));
};
