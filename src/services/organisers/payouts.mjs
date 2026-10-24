import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { studioViews } from '../voting/campaigns.mjs';

/**
 * An organiser's share of the money their campaigns took through the
 * platform (completed payments only; money taken before the platform isn't
 * ours to pay). They ask for it once voting has ended; the Studio pays by
 * mobile money or bank and marks it paid with the reference
 * (10-voting.md, decision 6).
 */

export const PAYOUT_METHODS = ['MTN MoMo', 'Airtel Money', 'Bank transfer'];

const toPayout = ({ paidBy: _by, requestedAt, paidAt, reference, ...p }) => ({
    ...p,
    requestedAt: requestedAt.toISOString(),
    paidAt: paidAt?.toISOString() ?? undefined,
    reference: reference ?? undefined,
});

const changed = () => invalidate('admin', ['admin', 'organizers']);

/** What one campaign owes its organiser, and whether they can ask for it now. */
const summaryFor = (view, organizer, payouts) => {
    const revenue = view.revenueFromVotesUGX + view.revenueFromVipUGX;
    const share = Math.floor((revenue * organizer.sharePercent) / 100);
    const mine = payouts.filter((p) => p.campaignId === view.id);
    const paid = mine.filter((p) => p.status === 'paid').reduce((t, p) => t + p.amountUGX, 0);
    const requested = mine.filter((p) => p.status === 'requested').reduce((t, p) => t + p.amountUGX, 0);
    const available = Math.max(0, share - paid - requested);
    const ended = view.status === 'finished' && view.publishStatus === 'published';
    const reason = !ended ? 'Payouts open when voting ends.' : requested > 0 ? 'A request is being processed.' : available === 0 ? 'Nothing left to pay out.' : undefined;
    return {
        campaignId: view.id,
        title: view.title,
        status: view.status,
        revenueUGX: revenue,
        sharePercent: organizer.sharePercent,
        shareUGX: share,
        paidUGX: paid,
        requestedUGX: requested,
        availableUGX: available,
        canRequest: !reason,
        reason,
    };
};

const summariesFor = async (organizer) => {
    const [campaigns, payouts] = await Promise.all([
        prisma.campaign.findMany({ where: { organizerId: organizer.id } }),
        prisma.payoutRequest.findMany({ where: { organizerId: organizer.id }, orderBy: { requestedAt: 'desc' } }),
    ]);
    const views = await studioViews(campaigns);
    return { summaries: views.map((v) => summaryFor(v, organizer, payouts)), payouts };
};

/** The organiser's payouts page. */
export const getMyPayouts = async (organizer) => {
    const { summaries, payouts } = await summariesFor(organizer);
    return { sharePercent: organizer.sharePercent, campaigns: summaries, requests: payouts.map(toPayout) };
};

/** Ask for everything a campaign still owes. The amount is worked out here, never taken from the page. */
export const requestPayout = async (organizer, { campaignId, method, accountName, accountNumber }) => {
    const { summaries } = await summariesFor(organizer);
    const summary = summaries.find((s) => s.campaignId === campaignId);
    if (!summary) throw new AppError('Campaign not found.', 404);
    if (!summary.canRequest) throw new AppError(summary.reason ?? "This campaign can't be paid out yet.", 409, { code: 'payout_unavailable' });
    const row = await prisma.payoutRequest.create({
        data: { organizerId: organizer.id, campaignId, amountUGX: summary.availableUGX, method, accountName, accountNumber },
    });
    changed();
    return toPayout(row);
};

/* Studio */

/** Open requests first, then newest first. */
export const listPayoutRequests = async () => {
    const rows = await prisma.payoutRequest.findMany({ orderBy: { requestedAt: 'desc' } });
    const [orgs, campaigns] = await Promise.all([
        prisma.organizer.findMany({ where: { id: { in: [...new Set(rows.map((p) => p.organizerId))] } }, select: { id: true, orgName: true } }),
        prisma.campaign.findMany({ where: { id: { in: [...new Set(rows.map((p) => p.campaignId))] } }, select: { id: true, title: true } }),
    ]);
    const orgNames = new Map(orgs.map((o) => [o.id, o.orgName]));
    const titles = new Map(campaigns.map((c) => [c.id, c.title]));
    return rows
        .map((p) => ({ ...toPayout(p), orgName: orgNames.get(p.organizerId) ?? 'Removed organiser', campaignTitle: titles.get(p.campaignId) ?? 'Removed campaign' }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'requested' ? -1 : 1));
};

/** After paying by mobile money or bank: the provider's reference closes it. Only an open request can be closed. */
export const markPaid = async (id, reference, { by }) => {
    const { count } = await prisma.payoutRequest.updateMany({
        where: { id, status: 'requested' },
        data: { status: 'paid', paidAt: new Date(), reference, paidBy: by },
    });
    if (!count) {
        const exists = await prisma.payoutRequest.findUnique({ where: { id }, select: { id: true } });
        throw exists ? new AppError('This payout is already marked paid.', 409) : new AppError('Payout request not found.', 404);
    }
    changed();
    return toPayout(await prisma.payoutRequest.findUnique({ where: { id } }));
};

/** How many requests each organiser has open, for the Studio's organiser list. */
export const openPayoutCounts = async () => {
    const rows = await prisma.payoutRequest.groupBy({ by: ['organizerId'], where: { status: 'requested' }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.organizerId, r._count._all]));
};
