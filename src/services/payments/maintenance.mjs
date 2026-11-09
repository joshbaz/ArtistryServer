import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { getRates } from './charges.mjs';
import { notifyStaff } from '../studio/notifications.mjs';

/**
 * Studio › Finance › System maintenance (Finance and Super Admin): what the
 * maintenance charge has earned, what's been paid out, and what's waiting.
 *
 * PesaPal can't send money out, so a payout is sent by hand (MoMo or bank)
 * and recorded here with its reference. Earned is counted from completed
 * payments only: a refunded one drops out, so a refund after a payout can
 * leave the balance below zero until later payments make it up.
 */

const MONTHS = 6;
// Kampala is UTC+3 all year: months turn at its midnight.
const KAMPALA = 3 * 3600 * 1000;
const monthKey = (date) => new Date(date.getTime() + KAMPALA).toISOString().slice(0, 7);
const monthStart = (now, offset) => {
    const k = new Date(now.getTime() + KAMPALA);
    return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + offset, 1) - KAMPALA);
};

// Which part of the site a payment came from.
const SOURCE = { votes: 'votes', vip: 'vip', subscription: 'plans', renewal: 'plans', ppv: 'rentals', ticket: 'tickets' };

const changed = () => {
    invalidate('admin', ['admin', 'maintenance']);
    invalidate('admin', ['admin', 'overview']);
};

/** Each person's part of an amount, by their percent; the last takes the rounding. */
export const split = (amountUGX, recipients) => {
    let left = amountUGX;
    return recipients.map((r, i) => {
        const part = i === recipients.length - 1 ? left : Math.floor((amountUGX * r.percent) / 100);
        left -= part;
        return { name: r.name, amountUGX: part };
    });
};

const earnedSum = async (where = {}) =>
    (await prisma.paymentOrder.aggregate({ where: { status: 'completed', maintenanceUGX: { gt: 0 }, ...where }, _sum: { maintenanceUGX: true } }))._sum.maintenanceUGX ?? 0;
const paidSum = async () => (await prisma.maintenancePayout.aggregate({ _sum: { amountUGX: true } }))._sum.amountUGX ?? 0;

/** Earned less paid out. */
export const balance = async () => {
    const [earned, paid] = await Promise.all([earnedSum(), paidSum()]);
    return earned - paid;
};

/** Whether the balance has reached the payout threshold, for the Overview. */
export const payoutDue = async () => {
    const [{ payoutThresholdUGX }, left] = await Promise.all([getRates(), balance()]);
    return left >= payoutThresholdUGX;
};

const toPayout = (p) => ({
    id: p.id,
    amountUGX: p.amountUGX,
    shares: p.shares,
    method: p.method,
    reference: p.reference,
    note: p.note,
    paidAt: p.paidAt.toISOString(),
    recordedByName: p.recordedByName,
});

export const getSummary = async () => {
    const now = new Date();
    const from = monthStart(now, -(MONTHS - 1));
    const [rates, earned, paidOut, thisMonth, lastMonth, recent, payouts] = await Promise.all([
        getRates(),
        earnedSum(),
        paidSum(),
        earnedSum({ completedAt: { gte: monthStart(now, 0) } }),
        earnedSum({ completedAt: { gte: monthStart(now, -1), lt: monthStart(now, 0) } }),
        prisma.paymentOrder.findMany({ where: { status: 'completed', maintenanceUGX: { gt: 0 }, completedAt: { gte: from } }, select: { kind: true, maintenanceUGX: true, completedAt: true } }),
        prisma.maintenancePayout.findMany({ orderBy: { paidAt: 'desc' }, take: 200 }),
    ]);
    const months = Array.from({ length: MONTHS }, (_, i) => ({ month: monthKey(monthStart(now, i - (MONTHS - 1))), votes: 0, vip: 0, plans: 0, rentals: 0, tickets: 0 }));
    const byKey = new Map(months.map((m) => [m.month, m]));
    for (const o of recent) {
        const m = byKey.get(monthKey(o.completedAt));
        if (m && SOURCE[o.kind]) m[SOURCE[o.kind]] += o.maintenanceUGX;
    }
    const left = earned - paidOut;
    return {
        rates,
        balanceUGX: left,
        shares: split(Math.max(0, left), rates.recipients),
        due: left >= rates.payoutThresholdUGX,
        earned: { thisMonthUGX: thisMonth, lastMonthUGX: lastMonth, allTimeUGX: earned },
        paidOutUGX: paidOut,
        months,
        payouts: payouts.map(toPayout),
    };
};

/** Completed payments that carried the charge, newest first: the record to check against PesaPal's statement. */
export const listEarnings = async () => {
    const rows = await prisma.paymentOrder.findMany({
        where: { status: { in: ['completed', 'reversed'] }, maintenanceUGX: { gt: 0 } },
        orderBy: { completedAt: 'desc' },
        take: 2000,
        select: { id: true, reference: true, module: true, kind: true, itemName: true, amountUGX: true, maintenanceUGX: true, pesapalFeeUGX: true, totalUGX: true, maintenancePercent: true, status: true, method: true, completedAt: true, createdAt: true },
    });
    return rows.map((o) => ({
        ...o,
        method: o.method || 'PesaPal',
        status: o.status === 'reversed' ? 'refunded' : 'paid',
        paidAt: (o.completedAt ?? o.createdAt).toISOString(),
        completedAt: undefined,
        createdAt: undefined,
    }));
};

/** Record money sent to the developers. It can't be more than the balance. */
export const recordPayout = async ({ amountUGX, method, reference, note, paidAt }, by) => {
    const [rates, left] = await Promise.all([getRates(), balance()]);
    if (amountUGX > left) throw new AppError(`That's more than the balance (UGX ${Math.max(0, left).toLocaleString('en')}).`, 409, { details: { fieldErrors: { amountUGX: ['More than the balance.'] } } });
    const row = await prisma.maintenancePayout.create({
        data: { amountUGX, shares: split(amountUGX, rates.recipients), method, reference, note: note ?? '', paidAt: paidAt ? new Date(paidAt) : new Date(), recordedBy: by.id, recordedByName: by.name },
    });
    changed();
    return toPayout(row);
};

/**
 * After a payment completes: if it took the balance over the threshold, tell
 * whoever chose that email. Once per crossing, never throws.
 * @param {number} addedUGX the maintenance the payment just added
 */
export const afterEarning = async (addedUGX) => {
    if (!addedUGX) return;
    try {
        changed();
        const [{ payoutThresholdUGX }, now] = await Promise.all([getRates(), balance()]);
        if (now >= payoutThresholdUGX && now - addedUGX < payoutThresholdUGX) {
            await notifyStaff('maintenance-due', {
                subject: 'System maintenance payout due',
                heading: 'The system maintenance balance has reached its payout amount',
                lines: [`It's UGX ${now.toLocaleString('en')} now. Send it to the developers, then record the payout with its reference.`],
                path: '/studio/maintenance',
            });
        }
    } catch (error) {
        console.error('Maintenance threshold check failed:', error.message);
    }
};
