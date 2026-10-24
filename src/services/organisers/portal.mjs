import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { checkCampaign, MIN_CONTESTANTS, standingsOf, studioView, studioViews } from '../voting/campaigns.mjs';
import * as contestants from '../voting/contestants.mjs';
import { campaignPhase, isDay } from '../voting/phase.mjs';
import { completedOrdersFor } from '../payments/revenue.mjs';
import { toVoteOrderRow } from '../payments/orders.mjs';

/**
 * The organiser's own campaigns at /organizer. They edit the content (title,
 * banner, logo, dates before voting opens, prize, rules), manage contestants
 * and publish; prices, the featured slot and taking a campaign down stay
 * with the Studio. The rules are the Studio's (checkCampaign), so both
 * sides agree. Every read and write checks the campaign is theirs.
 */

// Someone else's campaign looks the same as one that doesn't exist.
const notYours = () => new AppError('Campaign not found.', 404);

/** The campaign row, if it belongs to this organiser. */
const ownedCampaign = async (organizerId, campaignId) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.organizerId !== organizerId) throw notYours();
    return campaign;
};

const ownedContestant = async (organizerId, contestantId) => {
    const campaignId = await contestants.campaignOfContestant(contestantId);
    await ownedCampaign(organizerId, campaignId);
};

/** The steps to a publishable campaign, for the setup checklist. */
const withChecklist = (view, board) => {
    const checklist = {
        details: Boolean(view.title?.trim() && view.description?.trim()),
        banner: Boolean(view.image),
        dates: isDay(view.startDate) && isDay(view.endDate),
        contestants: board.length >= MIN_CONTESTANTS,
        photos: board.length > 0 && board.every((p) => Boolean(p.photo)),
    };
    return { ...view, checklist, ready: Object.values(checklist).every(Boolean) };
};

const portalView = async (campaign) => withChecklist(await studioView(campaign), await standingsOf(campaign.id));

/* Campaigns */

/** Newest first; campaigns still waiting for dates first of all. */
export const listMine = async (organizerId) => {
    const rows = await prisma.campaign.findMany({ where: { organizerId } });
    const views = await studioViews(rows);
    const boards = await Promise.all(rows.map((c) => standingsOf(c.id)));
    return views
        .map((v, i) => withChecklist(v, boards[i]))
        .sort((a, b) => (b.startDate || '9').localeCompare(a.startDate || '9'));
};

export const getMine = async (organizerId, id) => portalView(await ownedCampaign(organizerId, id));

/**
 * Edit the content. Dates are fixed once a published campaign opens. The
 * card always names the organiser as their organisation.
 * @param {{ id: string, orgName: string }} organizer
 */
export const updateMine = async (organizer, id, patch) => {
    const current = await ownedCampaign(organizer.id, id);
    const datesChange = (patch.startDate !== undefined && patch.startDate !== current.startDate) || (patch.endDate !== undefined && patch.endDate !== current.endDate);
    if (datesChange && current.publishStatus === 'published' && campaignPhase(current) !== 'upcoming') {
        throw new AppError('Voting has opened, so the dates are fixed. Ask The Artistry360 team if they must change.', 409, { code: 'dates_locked' });
    }
    await checkCampaign(patch, { ...current, ...patch }, current);
    const campaign = await prisma.campaign.update({ where: { id }, data: { ...patch, organizer: organizer.orgName, organizerBadge: 'verified' } });
    invalidateSite('campaigns', { id });
    return portalView(campaign);
};

/**
 * Publish (it shows on /voting) or take it back to draft. A campaign the
 * Studio took down stays down, and once voting has opened it can't be
 * pulled back, so votes and payments are never hidden.
 */
export const setPublished = async (organizerId, id, published) => {
    const current = await ownedCampaign(organizerId, id);
    if (current.takenDown) throw new AppError(`The Artistry360 team took this campaign down: ${current.takenDown.reason}`, 409, { code: 'taken_down' });
    if (!published && current.publishStatus === 'published' && campaignPhase(current) !== 'upcoming') {
        throw new AppError('Voting has opened, so the campaign stays live. Ask The Artistry360 team to end it early.', 409, { code: 'live_locked' });
    }
    const patch = { publishStatus: published ? 'published' : 'draft' };
    if (published) {
        const board = await standingsOf(id);
        if (!current.image) throw new AppError('Add a banner image before publishing.', 409, { code: 'no_banner' });
        if (board.some((p) => !p.photo)) throw new AppError('Every contestant needs a photo before publishing.', 409, { code: 'missing_photos' });
    }
    await checkCampaign(patch, { ...current, ...patch }, current);
    const campaign = await prisma.campaign.update({ where: { id }, data: patch });
    invalidateSite('campaigns', { id });
    return portalView(campaign);
};

/* Contestants */

export const listMyContestants = async (organizerId, campaignId) => {
    await ownedCampaign(organizerId, campaignId);
    return contestants.listContestants(campaignId);
};

export const addMyContestants = async (organizerId, campaignId, rows) => {
    await ownedCampaign(organizerId, campaignId);
    return contestants.addContestants(campaignId, rows);
};

export const updateMyContestant = async (organizerId, id, patch) => {
    await ownedContestant(organizerId, id);
    return contestants.updateContestant(id, patch);
};

export const moveMyContestant = async (organizerId, id, step) => {
    await ownedContestant(organizerId, id);
    return contestants.moveContestant(id, step);
};

export const deleteMyContestant = async (organizerId, id) => {
    await ownedContestant(organizerId, id);
    return contestants.deleteContestant(id);
};

/* Results */

const DAY = 24 * 60 * 60 * 1000;
const kampalaDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });

/** A campaign's standings and money: completed payments only. */
export const getMyResults = async (organizerId, campaignId) => {
    const campaign = await ownedCampaign(organizerId, campaignId);
    const [view, board] = await Promise.all([studioView(campaign), standingsOf(campaignId)]);
    const [rows, orders] = await Promise.all([
        prisma.contestant.findMany({ where: { campaignId }, select: { platformVotes: true } }),
        completedOrdersFor([campaignId]),
    ]);
    const onPlatform = rows.reduce((sum, r) => sum + r.platformVotes, 0);
    const paidVotes = orders.filter((o) => o.kind === 'votes').reduce((sum, o) => sum + o.votes, 0);
    const now = Date.now();
    return {
        standings: board,
        totalVotes: view.totalVotes,
        carriedVotes: Math.max(0, view.totalVotes - onPlatform),
        paidVotes,
        freeVotes: Math.max(0, onPlatform - paidVotes),
        vipBuyers: view.vipVoters,
        revenueUGX: view.revenueFromVotesUGX + view.revenueFromVipUGX,
        payments: view.orders,
        // Completed payments per day (Kampala), oldest first, for the last 14 days.
        daily: Array.from({ length: 14 }, (_, i) => {
            const date = kampalaDay(new Date(now - (13 - i) * DAY));
            const that = orders.filter((o) => kampalaDay(o.createdAt) === date);
            return { date, votes: that.reduce((s, o) => s + o.votes, 0), amountUGX: that.reduce((s, o) => s + o.amountUGX, 0) };
        }),
    };
};

/** Every completed payment for this organiser's campaigns, newest first. No payer details are kept, so none are shown. */
export const listMyPayments = async (organizerId) => {
    const campaigns = await prisma.campaign.findMany({ where: { organizerId }, select: { id: true, title: true } });
    const orders = await completedOrdersFor(campaigns.map((c) => c.id));
    const contestants = await prisma.contestant.findMany({ where: { id: { in: [...new Set(orders.map((o) => o.participantId).filter(Boolean))] } }, select: { id: true, fullName: true } });
    return orders.map(toVoteOrderRow(new Map(campaigns.map((c) => [c.id, c.title])), new Map(contestants.map((c) => [c.id, c.fullName]))));
};
