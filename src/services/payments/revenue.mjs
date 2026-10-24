import prisma from '../../utils/db.mjs';

/**
 * What payments add up to, for the voting views and the organiser portal.
 * Only completed orders count: pending and failed payments earn nothing.
 * Kept apart from orders.mjs so the campaign views can read it without a
 * circular import.
 */

const empty = () => ({ votesUGX: 0, vipUGX: 0, orders: 0, vipVoters: 0, paidVotes: 0 });

/**
 * Revenue per campaign.
 * @param {string[]} campaignIds
 * @returns {Promise<Map<string, { votesUGX: number, vipUGX: number, orders: number, vipVoters: number, paidVotes: number }>>}
 */
export const revenueByCampaign = async (campaignIds) => {
    const out = new Map(campaignIds.map((id) => [id, empty()]));
    if (!campaignIds.length) return out;
    const rows = await prisma.paymentOrder.groupBy({
        by: ['campaignId', 'kind'],
        where: { module: 'voting', status: 'completed', campaignId: { in: campaignIds } },
        _sum: { amountUGX: true, votes: true },
        _count: { _all: true },
    });
    for (const r of rows) {
        const t = out.get(r.campaignId);
        if (!t) continue;
        t.orders += r._count._all;
        if (r.kind === 'vip') {
            t.vipUGX += r._sum.amountUGX ?? 0;
            t.vipVoters += r._count._all;
        } else {
            t.votesUGX += r._sum.amountUGX ?? 0;
            t.paidVotes += r._sum.votes ?? 0;
        }
    }
    return out;
};

/** Voting payments still waiting for PesaPal. */
export const pendingVotingPayments = () => prisma.paymentOrder.count({ where: { module: 'voting', status: 'pending' } });

/** Whether anyone has paid, or started paying, for a campaign: such a campaign can't be deleted. */
export const campaignHasOrders = async (campaignId) => Boolean(await prisma.paymentOrder.count({ where: { campaignId, status: { in: ['pending', 'completed', 'reversed'] } } }));

/** Completed orders for some campaigns, newest first. No payer details are kept, so none are returned. */
export const completedOrdersFor = (campaignIds) =>
    prisma.paymentOrder.findMany({ where: { module: 'voting', status: 'completed', campaignId: { in: campaignIds } }, orderBy: { createdAt: 'desc' } });
