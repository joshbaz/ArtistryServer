import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { includedInPlan } from './pricing.mjs';

/**
 * Who may watch what on the stream site and the app. A free title is for
 * everyone; a subscription title for a member whose plan is paid up; a
 * pay-per-view title for a member who rented it (24 hours from payment),
 * or for a subscriber once it reaches its standard price (pricing.mjs).
 * Plans and rentals are only ever granted by a completed PesaPal payment
 * (payments/orders.mjs), in the same transaction that marks it paid.
 */

const DAY = 24 * 3600 * 1000;
/** How long a rental lasts, from payment. */
export const RENTAL_HOURS = 24;
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

/** → { subscription, purchases: titleIds rented and still watchable, rentals: [{ titleId, expiresAt }] } */
export const getAccess = async (memberId) => {
    const [sub, rentals] = await Promise.all([prisma.streamSubscription.findUnique({ where: { memberId } }), activeRentals(memberId)]);
    return {
        subscription: toSubscription(sub),
        purchases: [...new Set(rentals.map((r) => r.titleId))],
        rentals: rentals.map((r) => ({ titleId: r.titleId, expiresAt: r.expiresAt.toISOString() })),
    };
};

export const hasActivePlan = async (memberId) => isActive(await prisma.streamSubscription.findUnique({ where: { memberId } }));

export const activeRental = async (memberId, titleId) =>
    prisma.streamRental.findFirst({ where: { memberId, titleId, expiresAt: { gt: new Date() } }, orderBy: { expiresAt: 'desc' } });

/**
 * Whether this member may play this title now (`title` as stored): false, or
 * until when (a rental's end; null when open-ended). A rental plays from
 * payment, before the premiere too: that's early access.
 */
export const watchableUntil = async (memberId, title) => {
    if (title.accessTier === 'free') return null;
    if (!memberId) return false;
    if (title.accessTier === 'subscription') return (await hasActivePlan(memberId)) ? null : false;
    const rental = await activeRental(memberId, title.id);
    if (rental) return rental.expiresAt;
    return includedInPlan(title) && (await hasActivePlan(memberId)) ? null : false;
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

/** A paid rental: RENTAL_HOURS from the payment (`paidAt`). */
export const grantRental = (tx, order, paidAt = new Date()) =>
    tx.streamRental.create({ data: { memberId: order.memberId, titleId: order.titleId, orderId: order.id, expiresAt: new Date(paidAt.getTime() + RENTAL_HOURS * 3600 * 1000) } });

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
