import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { campaignEndsAt, campaignPhase, campaignStartsAt, isDay } from './phase.mjs';
import { campaignHasOrders, pendingVotingPayments, revenueByCampaign } from '../payments/revenue.mjs';
import { recordChange } from '../system/audit.mjs';

/**
 * Voting campaigns (client/docs/10-voting.md). Every figure the clients show
 * (status, contestant count, vote totals, revenue, the winner) is worked out
 * here from the campaign and its contestants, never stored, so /voting and
 * the Studio always agree. The rules mirror the client's studioCampaignsApi.
 */

export const MIN_CONTESTANTS = 2;
// What a vote and VIP cost and give. The Studio may change them at any time: each order keeps the
// price and votes it was made with, and each VIP pass its daily votes, so a change only reaches new purchases.
const PRICE_FIELDS = ['votePriceUGX', 'vipPriceUGX', 'vipDailyVotes'];
const HOURS_48 = 48 * 60 * 60 * 1000;

const notFound = () => new AppError('Campaign not found.', 404);

/** A contestant as the clients see it: one `votes` figure, carried-over and platform votes together. */
export const toContestant = ({ id, campaignId, fullName, number, photo, bio, importedVotes, platformVotes }) => ({
    id, campaignId, fullName, number, photo, bio, votes: importedVotes + platformVotes,
});

/** Highest first; ties go to the lower number. */
const byVotes = (a, b) => b.votes - a.votes || a.number - b.number;

/** Each campaign's contestants, leaderboard order, in one query. */
const standingsFor = async (campaignIds) => {
    const rows = await prisma.contestant.findMany({ where: { campaignId: { in: campaignIds } } });
    const out = new Map(campaignIds.map((id) => [id, []]));
    for (const row of rows) out.get(row.campaignId)?.push(toContestant(row));
    for (const list of out.values()) list.sort(byVotes);
    return out;
};

const iso = (d) => (d ? d.toISOString() : null);

/** Each organiser's logo, for campaigns without their own. */
const organizerLogos = async (campaigns) => {
    const ids = [...new Set(campaigns.map((c) => c.organizerId).filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await prisma.organizer.findMany({ where: { id: { in: ids } }, select: { id: true, logo: true } });
    return new Map(rows.map((o) => [o.id, o.logo]));
};

/**
 * What /voting reads. Revenue, the organiser request and the take-down note
 * stay in the Studio.
 */
const toPublic = (c, board, now = new Date(), organizerLogo = '') => {
    const status = campaignPhase(c, now);
    return {
        id: c.id,
        title: c.title,
        description: c.description,
        startDate: c.startDate,
        endDate: c.endDate,
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        image: c.image,
        category: c.category,
        organizer: c.organizer,
        organizerBadge: c.organizerBadge,
        publishStatus: c.publishStatus,
        featured: c.featured,
        votePriceUGX: c.votePriceUGX,
        vipPriceUGX: c.vipPriceUGX,
        vipDailyVotes: c.vipDailyVotes,
        vipTicketPerk: c.vipTicketPerk,
        importedVotes: c.importedVotes,
        closedAt: iso(c.closedAt),
        // The campaign's own logo, else its organiser's.
        logo: c.logo || organizerLogo || '',
        prize: c.prize,
        rules: c.rules,
        status,
        participants: board.length,
        totalVotes: c.importedVotes + board.reduce((sum, p) => sum + p.votes, 0),
        // Decided by hand when the result came from elsewhere; otherwise the leader once it ends.
        winner: c.winner || (status === 'finished' ? board[0]?.fullName : undefined),
    };
};

const NO_REVENUE = { votesUGX: 0, vipUGX: 0, orders: 0, vipVoters: 0 };

/** What the Studio reads: everything, with revenue by source (completed payments, plus money taken before the platform). */
const toStudio = (c, board, now = new Date(), organizerLogo = '', money = NO_REVENUE) => ({
    ...toPublic(c, board, now, organizerLogo),
    importedRevenueUGX: c.importedRevenueUGX,
    requestId: c.requestId ?? undefined,
    organizerId: c.organizerId ?? undefined,
    takenDown: c.takenDown ? { at: iso(c.takenDown.at), reason: c.takenDown.reason } : null,
    revenueFromVotesUGX: money.votesUGX,
    revenueFromVipUGX: money.vipUGX,
    revenueUGX: c.importedRevenueUGX + money.votesUGX + money.vipUGX,
    orders: money.orders,
    vipVoters: money.vipVoters,
});

/**
 * The Studio's view of several campaigns at once (also the organiser portal's).
 * @param {object[]} campaigns - Campaign rows
 */
export const studioViews = async (campaigns) => {
    const ids = campaigns.map((c) => c.id);
    const [boards, logos, money] = await Promise.all([standingsFor(ids), organizerLogos(campaigns), revenueByCampaign(ids)]);
    const now = new Date();
    return campaigns.map((c) => toStudio(c, boards.get(c.id), now, logos.get(c.organizerId), money.get(c.id)));
};

export const studioView = async (c) => (await studioViews([c]))[0];

/** A campaign's contestants, leaderboard order. */
export const standingsOf = async (campaignId) => (await standingsFor([campaignId])).get(campaignId);

const findCampaign = async (id) => {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw notFound();
    return campaign;
};

/**
 * The rules every campaign write meets. `next` is the campaign as it would
 * be saved; `current` is what's stored now (none when creating).
 */
export const checkCampaign = async (patch, next, current) => {
    // A draft may wait for its dates; a published campaign needs both, in order.
    const publishing = next.publishStatus === 'published';
    for (const d of [next.startDate, next.endDate]) {
        if ((publishing || d) && !isDay(d)) throw new AppError('Set when voting opens and closes before publishing.', 422);
    }
    if (next.startDate && next.endDate && next.endDate < next.startDate) throw new AppError('Voting must close on or after the day it opens.', 422);
    if (isDay(next.startDate) && isDay(next.endDate) && campaignEndsAt(next.endDate, next.endTime) <= campaignStartsAt(next.startDate, next.startTime)) {
        throw new AppError('Voting must close after it opens.', 422);
    }

    if (publishing && current?.publishStatus !== 'published') {
        const count = current ? await prisma.contestant.count({ where: { campaignId: current.id } }) : 0;
        if (count < MIN_CONTESTANTS) throw new AppError(`Add at least ${MIN_CONTESTANTS} contestants before publishing.`, 409, { code: 'too_few_contestants' });
    }
};

/* Public */

/** Every published campaign, for /voting. */
export const listPublished = async () => {
    const campaigns = await prisma.campaign.findMany({ where: { publishStatus: 'published' }, orderBy: { startDate: 'desc' } });
    const [boards, logos] = await Promise.all([standingsFor(campaigns.map((c) => c.id)), organizerLogos(campaigns)]);
    const now = new Date();
    return campaigns.map((c) => toPublic(c, boards.get(c.id), now, logos.get(c.organizerId)));
};

/** One published campaign with its leaderboard. Drafts are a 404, as if they didn't exist. */
export const getPublished = async (id) => {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign || campaign.publishStatus !== 'published') throw notFound();
    const [board, logos] = await Promise.all([standingsOf(id), organizerLogos([campaign])]);
    return { campaign: toPublic(campaign, board, new Date(), logos.get(campaign.organizerId)), participants: board };
};

/* Studio */

export const listForStudio = async () => studioViews(await prisma.campaign.findMany({ orderBy: { startDate: 'desc' } }));

export const getStats = async () => {
    const [all, contestants, pendingPayments] = await Promise.all([listForStudio(), prisma.contestant.count(), pendingVotingPayments()]);
    const published = all.filter((c) => c.publishStatus === 'published');
    const now = Date.now();
    return {
        totalVotes: all.reduce((sum, c) => sum + c.totalVotes, 0),
        contestants,
        revenueUGX: all.reduce((sum, c) => sum + c.revenueUGX, 0),
        live: published.filter((c) => c.status === 'ongoing').length,
        upcoming: published.filter((c) => c.status === 'upcoming').length,
        ended: published.filter((c) => c.status === 'finished').length,
        drafts: all.length - published.length,
        // Payments still waiting for PesaPal's word.
        pendingPayments,
        endingSoon: published.filter((c) => c.status === 'ongoing' && campaignEndsAt(c.endDate, c.endTime).getTime() - now < HOURS_48).length,
    };
};

/** New campaigns start as drafts: they need contestants before they can go public. */
export const createCampaign = async (data) => {
    const row = { ...data, publishStatus: 'draft' };
    await checkCampaign(row, row);
    const campaign = await prisma.campaign.create({ data: row });
    invalidateSite('campaigns', { id: campaign.id });
    return studioView(campaign);
};

const pricesOf = (c) => Object.fromEntries(PRICE_FIELDS.map((k) => [k, c[k]]));

export const updateCampaign = async (id, patch, by) => {
    const current = await findCampaign(id);
    const next = { ...current, ...patch };
    await checkCampaign(patch, next, current);
    // Publishing by hand also lifts a take-down.
    const data = patch.publishStatus === 'published' && current.takenDown ? { ...patch, takenDown: null } : patch;
    const campaign = await prisma.campaign.update({ where: { id }, data });
    recordChange(by, 'campaign-price', id, pricesOf(current), pricesOf(campaign));
    invalidateSite('campaigns', { id });
    return studioView(campaign);
};

/** End voting now, or reopen a campaign ended early. */
export const setClosed = async (id, closed) => {
    await findCampaign(id);
    const campaign = await prisma.campaign.update({ where: { id }, data: { closedAt: closed ? new Date() : null } });
    invalidateSite('campaigns', { id });
    return studioView(campaign);
};

/** Take a campaign off /voting (back to draft), with the reason the organiser will see. */
export const takeDown = async (id, reason) => {
    await findCampaign(id);
    const campaign = await prisma.campaign.update({ where: { id }, data: { publishStatus: 'draft', takenDown: { at: new Date(), reason } } });
    invalidateSite('campaigns', { id });
    return studioView(campaign);
};

export const restore = async (id) => {
    const current = await findCampaign(id);
    if (!current.takenDown) throw new AppError("This campaign isn't taken down.", 409);
    const campaign = await prisma.campaign.update({ where: { id }, data: { publishStatus: 'published', takenDown: null } });
    invalidateSite('campaigns', { id });
    return studioView(campaign);
};

/** Only a campaign nobody has voted in or paid for can be deleted. */
export const deleteCampaign = async (id) => {
    await findCampaign(id);
    const voted = await prisma.contestant.count({ where: { campaignId: id, platformVotes: { gt: 0 } } });
    if (voted || (await campaignHasOrders(id))) throw new AppError("This campaign has votes or payments, so it can't be deleted. End it instead.", 409);
    await prisma.$transaction([
        prisma.contestant.deleteMany({ where: { campaignId: id } }),
        prisma.campaign.delete({ where: { id } }),
    ]);
    invalidateSite('campaigns', { id });
};

/** Whether a campaign exists, for the other voting services. */
export const assertCampaign = findCampaign;

/**
 * A campaign that's taking votes now, and a contestant in it: what every
 * vote, free or paid, must find before it counts.
 */
export const openForVotes = async (campaignId, participantId) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.publishStatus !== 'published') throw notFound();
    const phase = campaignPhase(campaign);
    if (phase === 'upcoming') throw new AppError("Voting hasn't opened yet.", 409, { code: 'not_open' });
    if (phase === 'finished') throw new AppError('Voting has closed for this campaign.', 409, { code: 'closed' });
    const contestant = participantId ? await prisma.contestant.findUnique({ where: { id: participantId } }) : null;
    if (participantId && contestant?.campaignId !== campaignId) throw new AppError("That contestant isn't in this campaign.", 422);
    return { campaign, contestant };
};
