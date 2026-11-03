import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';

/**
 * Subscription plans (Studio › Streaming › Subscriptions). The stream site
 * sells the active ones; the app's store products point at a plan's id, so
 * the id is made once from the first name and never changes.
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

const changed = (id) => invalidateSite('plans', { id });

// One plan is "most popular" at a time.
const clearOtherHighlights = (id) => prisma.streamPlan.updateMany({ where: { id: { not: id }, highlight: true }, data: { highlight: false } });

/* Public */

export const listPlans = async () => (await prisma.streamPlan.findMany({ where: { active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] })).map(toPlan);

/* Studio */

export const listAllPlans = async () => (await prisma.streamPlan.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] })).map(toPlan);

export const createPlan = async (data) => {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
    const last = await prisma.streamPlan.findFirst({ orderBy: { position: 'desc' }, select: { position: true } });
    for (let n = 1; n < 50; n += 1) {
        const id = `plan_${slug}${n === 1 ? '' : `-${n}`}`.slice(0, 60);
        try {
            const row = await prisma.streamPlan.create({ data: { ...data, id, position: (last?.position ?? 0) + 1 } });
            if (row.highlight) await clearOtherHighlights(id);
            changed(id);
            return toPlan(row);
        } catch (error) {
            if (error.code !== 'P2002') throw error;
        }
    }
    throw new AppError('Give the plan a different name.', 409);
};

export const updatePlan = async (id, patch) => {
    if (!(await prisma.streamPlan.findUnique({ where: { id } }))) throw notFound();
    const row = await prisma.streamPlan.update({ where: { id }, data: patch });
    if (patch.highlight) await clearOtherHighlights(id);
    changed(id);
    return toPlan(row);
};

export const deletePlan = async (id) => {
    const { count } = await prisma.streamPlan.deleteMany({ where: { id } });
    if (count) changed(id);
};

/**
 * Who's subscribed. Subscriptions come only from payments (PesaPal and the
 * app stores), which streaming doesn't take yet, so there are none to list.
 */
export const listSubscribers = async () => [];
