import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { campaignEndsAt, campaignPhase, isDay } from './phase.mjs';

/**
 * Voting campaigns (client/docs/10-voting.md). Every figure the clients show
 * (status, contestant count, vote totals, revenue, the winner) is worked out
 * here from the campaign and its contestants, never stored, so /voting and
 * the Studio always agree. The rules mirror the client's studioCampaignsApi.
 */

export const MIN_CONTESTANTS = 2;
const RULE_FIELDS = ['votePriceUGX', 'vipPriceUGX', 'vipDailyVotes'];
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

/**
 * What /voting reads. Revenue, the organiser request and the take-down note
 * stay in the Studio.
 */
const toPublic = (c, board, now = new Date()) => {
    const status = campaignPhase(c, now);
    return {
        id: c.id,
        title: c.title,
        description: c.description,
        startDate: c.startDate,
        endDate: c.endDate,
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
        logo: c.logo,
        prize: c.prize,
        rules: c.rules,
        status,
        participants: board.length,
        totalVotes: c.importedVotes + board.reduce((sum, p) => sum + p.votes, 0),
        // Decided by hand when the result came from elsewhere; otherwise the leader once it ends.
        winner: c.winner || (status === 'finished' ? board[0]?.fullName : undefined),
    };
};

/** What the Studio reads: everything, with revenue by source. Payments arrive with PesaPal (build step 3); until then only imported revenue counts. */
const toStudio = (c, board, now = new Date()) => ({
    ...toPublic(c, board, now),
    importedRevenueUGX: c.importedRevenueUGX,
    requestId: c.requestId ?? undefined,
    organizerId: c.organizerId ?? undefined,
    takenDown: c.takenDown ? { at: iso(c.takenDown.at), reason: c.takenDown.reason } : null,
    revenueFromVotesUGX: 0,
    revenueFromVipUGX: 0,
    revenueUGX: c.importedRevenueUGX,
    orders: 0,
    vipVoters: 0,
});

const studioView = async (c) => toStudio(c, (await standingsFor([c.id])).get(c.id));

const findCampaign = async (id) => {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw notFound();
    return campaign;
};

/**
 * The rules every campaign write meets. `next` is the campaign as it would
 * be saved; `current` is what's stored now (none when creating).
 */
const checkCampaign = async (patch, next, current) => {
    // A draft may wait for its dates; a published campaign needs both, in order.
    const publishing = next.publishStatus === 'published';
    for (const d of [next.startDate, next.endDate]) {
        if ((publishing || d) && !isDay(d)) throw new AppError('Set when voting opens and closes before publishing.', 422);
    }
    if (next.startDate && next.endDate && next.endDate < next.startDate) throw new AppError('Voting must close on or after the day it opens.', 422);

    // Fairness: once voting has opened, the price of a vote and what VIP gives can't change.
    if (current && campaignPhase(current) !== 'upcoming' && RULE_FIELDS.some((k) => patch[k] !== undefined && patch[k] !== current[k])) {
        throw new AppError('Prices and VIP votes are locked once voting has opened.', 409, { code: 'rules_locked' });
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
    const boards = await standingsFor(campaigns.map((c) => c.id));
    const now = new Date();
    return campaigns.map((c) => toPublic(c, boards.get(c.id), now));
};

/** One published campaign with its leaderboard. Drafts are a 404, as if they didn't exist. */
export const getPublished = async (id) => {
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign || campaign.publishStatus !== 'published') throw notFound();
    const board = (await standingsFor([id])).get(id);
    return { campaign: toPublic(campaign, board), participants: board };
};

/* Studio */

export const listForStudio = async () => {
    const campaigns = await prisma.campaign.findMany({ orderBy: { startDate: 'desc' } });
    const boards = await standingsFor(campaigns.map((c) => c.id));
    const now = new Date();
    return campaigns.map((c) => toStudio(c, boards.get(c.id), now));
};

export const getStats = async () => {
    const [all, contestants] = await Promise.all([listForStudio(), prisma.contestant.count()]);
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
        // Payments waiting for PesaPal's IPN: none until build step 3.
        pendingPayments: 0,
        endingSoon: published.filter((c) => c.status === 'ongoing' && campaignEndsAt(c.endDate).getTime() - now < HOURS_48).length,
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

export const updateCampaign = async (id, patch) => {
    const current = await findCampaign(id);
    const next = { ...current, ...patch };
    await checkCampaign(patch, next, current);
    // Publishing by hand also lifts a take-down.
    const data = patch.publishStatus === 'published' && current.takenDown ? { ...patch, takenDown: null } : patch;
    const campaign = await prisma.campaign.update({ where: { id }, data });
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

/** Only a campaign nobody has voted in can be deleted (payments will count too, from build step 3). */
export const deleteCampaign = async (id) => {
    await findCampaign(id);
    const voted = await prisma.contestant.count({ where: { campaignId: id, platformVotes: { gt: 0 } } });
    if (voted) throw new AppError("This campaign has votes, so it can't be deleted. End it instead.", 409);
    await prisma.$transaction([
        prisma.contestant.deleteMany({ where: { campaignId: id } }),
        prisma.campaign.delete({ where: { id } }),
    ]);
    invalidateSite('campaigns', { id });
};

/** Whether a campaign exists, for the other voting services. */
export const assertCampaign = findCampaign;
