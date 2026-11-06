import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { recordChange } from '../system/audit.mjs';

/**
 * Billing periods (Studio › Streaming › Subscriptions): Weekly, Monthly,
 * Every 3 months, Yearly, or any the Studio adds. A plan's `interval` is a
 * period's id. A plan order copies the period's days when it's made
 * (orders.mjs), so editing a period never changes what members already paid for.
 */

const notFound = () => new AppError('Billing period not found.', 404);
const DAY_FALLBACK = 30;

/** The four every install starts with; their ids are what plans already use. */
const SEED = [
    { id: 'week', name: 'Weekly', days: 7 },
    { id: 'month', name: 'Monthly', days: 30 },
    { id: 'quarter', name: 'Every 3 months', days: 91 },
    { id: 'year', name: 'Yearly', days: 365 },
];

const toPeriod = (p) => ({ id: p.id, name: p.name, days: p.days, active: p.active });
const nameKey = (name) => name.trim().toLowerCase();
const changed = (id) => invalidateSite('plans', { id });

let seeded = false;
/** Adds the four starting periods the first time any are read. Never touches one that exists. */
const ensureSeed = async () => {
    if (seeded) return;
    if (!(await prisma.streamBillingPeriod.count())) {
        for (const [position, p] of SEED.entries()) {
            await prisma.streamBillingPeriod.create({ data: { ...p, nameKey: nameKey(p.name), active: true, position } }).catch((error) => {
                if (error.code !== 'P2002') throw error;
            });
        }
    }
    seeded = true;
};

const all = async () => {
    await ensureSeed();
    return prisma.streamBillingPeriod.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
};

export const listPeriods = async () => (await all()).map(toPeriod);

/** id → { name, days }, for the plans the stream site and the app read. */
export const periodsById = async () => new Map((await all()).map((p) => [p.id, { name: p.name, days: p.days }]));

/** The days a plan on this period adds, at the moment of the order. */
export const periodDays = async (id) => (await periodsById()).get(id)?.days ?? DAY_FALLBACK;

/** A plan may only use a period that exists and is switched on (or the one it already had). */
export const checkPeriod = async (id, { current } = {}) => {
    await ensureSeed();
    const period = await prisma.streamBillingPeriod.findUnique({ where: { id } });
    if (!period || (!period.active && id !== current)) {
        throw new AppError('Choose how often it renews.', 422, { details: { fieldErrors: { interval: ['Choose how often it renews.'] } } });
    }
};

const nameTaken = () => new AppError('There is already a period with that name.', 409, { details: { fieldErrors: { name: ['There is already a period with that name.'] } } });

export const createPeriod = async (data, by) => {
    await ensureSeed();
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'period';
    const last = await prisma.streamBillingPeriod.findFirst({ orderBy: { position: 'desc' }, select: { position: true } });
    if (await prisma.streamBillingPeriod.findUnique({ where: { nameKey: nameKey(data.name) } })) throw nameTaken();
    for (let n = 1; n < 50; n += 1) {
        const id = `${slug}${n === 1 ? '' : `-${n}`}`.slice(0, 60);
        try {
            const row = await prisma.streamBillingPeriod.create({ data: { ...data, id, nameKey: nameKey(data.name), position: (last?.position ?? 0) + 1 } });
            recordChange(by, 'billing-period', id, null, toPeriod(row));
            changed(id);
            return toPeriod(row);
        } catch (error) {
            if (error.code !== 'P2002') throw error;
            if (error.meta?.target?.includes?.('nameKey')) throw nameTaken();
        }
    }
    throw nameTaken();
};

export const updatePeriod = async (id, patch, by) => {
    await ensureSeed();
    const current = await prisma.streamBillingPeriod.findUnique({ where: { id } });
    if (!current) throw notFound();
    const data = { ...patch, ...(patch.name ? { nameKey: nameKey(patch.name) } : {}) };
    let row;
    try {
        row = await prisma.streamBillingPeriod.update({ where: { id }, data });
    } catch (error) {
        if (error.code === 'P2002') throw nameTaken();
        throw error;
    }
    recordChange(by, 'billing-period', id, toPeriod(current), toPeriod(row));
    changed(id);
    return toPeriod(row);
};

/** 409 in_use while any plan is on it: switch it off instead. */
export const deletePeriod = async (id, by) => {
    const current = await prisma.streamBillingPeriod.findUnique({ where: { id } });
    if (!current) return;
    const plans = await prisma.streamPlan.count({ where: { interval: id } });
    if (plans) throw new AppError('A plan uses this period. Switch it off instead.', 409, { code: 'in_use' });
    await prisma.streamBillingPeriod.delete({ where: { id } });
    recordChange(by, 'billing-period', id, toPeriod(current), null);
    changed(id);
};
