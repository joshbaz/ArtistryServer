import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { recordChange } from '../system/audit.mjs';
import { checkPeriod, periodsById } from './billingPeriods.mjs';

/**
 * Subscription plans (Studio › Streaming › Subscriptions). The stream site
 * sells the active ones; the app's store products point at a plan's id, so
 * the id is made once from the first name and never changes. Every field can
 * be edited at any time; a new price or period applies to payments from then
 * on (each order keeps its own price and days).
 */

const notFound = () => new AppError('Plan not found.', 404);

const toPlan = (p) => ({
    id: p.id,
    name: p.name,
    priceUGX: p.priceUGX,
    interval: p.interval,
    benefits: p.benefits,
    active: p.active,
    highlight: p.highlight,
});

/** With its billing period's { name, days }, so a period added in the Studio reads right everywhere. */
const withPeriods = async (rows) => {
    const periods = await periodsById();
    return rows.map((p) => ({ ...toPlan(p), period: periods.get(p.interval) ?? null }));
};
const ORDER = [{ position: 'asc' }, { createdAt: 'asc' }];

const changed = (id) => invalidateSite('plans', { id });

// One plan is "most popular" at a time.
const clearOtherHighlights = (id) => prisma.streamPlan.updateMany({ where: { id: { not: id }, highlight: true }, data: { highlight: false } });

/* Public */

export const listPlans = async () => withPeriods(await prisma.streamPlan.findMany({ where: { active: true }, orderBy: ORDER }));

/* Studio */

export const listAllPlans = async () => withPeriods(await prisma.streamPlan.findMany({ orderBy: ORDER }));

export const createPlan = async (data, by) => {
    await checkPeriod(data.interval);
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
    const last = await prisma.streamPlan.findFirst({ orderBy: { position: 'desc' }, select: { position: true } });
    for (let n = 1; n < 50; n += 1) {
        const id = `plan_${slug}${n === 1 ? '' : `-${n}`}`.slice(0, 60);
        try {
            const row = await prisma.streamPlan.create({ data: { ...data, id, position: (last?.position ?? 0) + 1 } });
            if (row.highlight) await clearOtherHighlights(id);
            recordChange(by, 'plan', id, null, toPlan(row));
            changed(id);
            return (await withPeriods([row]))[0];
        } catch (error) {
            if (error.code !== 'P2002') throw error;
        }
    }
    throw new AppError('Give the plan a different name.', 409);
};

export const updatePlan = async (id, patch, by) => {
    const current = await prisma.streamPlan.findUnique({ where: { id } });
    if (!current) throw notFound();
    if (patch.interval) await checkPeriod(patch.interval, { current: current.interval });
    const row = await prisma.streamPlan.update({ where: { id }, data: patch });
    if (patch.highlight) await clearOtherHighlights(id);
    recordChange(by, 'plan', id, toPlan(current), toPlan(row));
    changed(id);
    return (await withPeriods([row]))[0];
};

/**
 * A plan members are still on is archived (taken off sale), not deleted, so
 * their account keeps showing it; one nobody's on goes.
 */
export const deletePlan = async (id, by) => {
    const current = await prisma.streamPlan.findUnique({ where: { id } });
    if (!current) return;
    const subscribers = await prisma.streamSubscription.count({ where: { planId: id, currentPeriodEnd: { gt: new Date() } } });
    if (subscribers) {
        const row = await prisma.streamPlan.update({ where: { id }, data: { active: false, highlight: false } });
        recordChange(by, 'plan', id, toPlan(current), toPlan(row));
    } else {
        await prisma.streamPlan.delete({ where: { id } });
        recordChange(by, 'plan', id, toPlan(current), null);
    }
    changed(id);
};

/** Who's subscribed: plans come only from payments (access.mjs). */
export { listSubscribers } from './access.mjs';
