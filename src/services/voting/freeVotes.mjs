import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { openForVotes } from './campaigns.mjs';
import { activePass } from './vip.mjs';

/**
 * The free daily vote (10-voting.md, decision 4). Three checks, all of which
 * must pass:
 *   - the voter: signed in with Google or Apple, one free vote per campaign
 *     every 24 hours;
 *   - the device: one free vote per campaign per 24 hours, whoever is signed
 *     in on it, so one phone can't vote again under a second account;
 *   - the network: at most NETWORK_LIMIT per campaign per 24 hours from one
 *     IP, high enough for a campus or office behind one address.
 * IPs and device ids are kept only as keyed hashes. A VIP voter's free vote
 * counts their pass's daily votes (vip.mjs).
 */

const DAY = 24 * 60 * 60 * 1000;
const DEVICE_LIMIT = 1;
const NETWORK_LIMIT = 50;

// Keyed, so a stored hash can't be matched back to an IP by hashing every address.
const hashed = (kind, value) => crypto.createHmac('sha256', env.MEMBER_TOKEN_SECRET).update(`${kind}:${value}`).digest('hex');

const used = (nextAt) => new AppError("You've used today's vote in this campaign.", 429, { code: 'free_vote_used', details: { nextAt: nextAt.toISOString() } });

/** When this voter's next free vote in the campaign opens, or null when it's open now. */
export const nextFreeVoteAt = async (campaignId, memberId) => {
    const slot = await prisma.freeVoteSlot.findUnique({ where: { campaignId_memberId: { campaignId, memberId } } });
    const next = slot ? new Date(slot.lastVoteAt.getTime() + DAY) : null;
    return next && next > new Date() ? next : null;
};

/** What the vote window shows the signed-in voter: their next free vote, and their VIP pass if they hold one. */
export const voterStatus = async (campaignId, memberId) => {
    await openOrFinished(campaignId);
    const [next, pass] = await Promise.all([nextFreeVoteAt(campaignId, memberId), activePass(campaignId, memberId)]);
    return {
        nextFreeVoteAt: next?.toISOString() ?? null,
        isVip: Boolean(pass),
        dailyVotes: pass?.dailyVotes ?? 1,
        ...(pass ? { ticketCode: pass.ticketCode } : {}),
    };
};

// A finished campaign's page still asks; only a missing or unpublished one is a 404.
const openOrFinished = async (campaignId) => {
    try {
        await openForVotes(campaignId);
    } catch (error) {
        if (error.status === 404) throw error;
    }
};

/**
 * Take the voter's free vote for this campaign, if it's theirs to take: a
 * single guarded write, so two taps at once can't both count. Returns false
 * when it was already used in the last 24 hours.
 */
const claimSlot = async (campaignId, memberId, now) => {
    const { count } = await prisma.freeVoteSlot.updateMany({
        where: { campaignId, memberId, lastVoteAt: { lte: new Date(now.getTime() - DAY) } },
        data: { lastVoteAt: now },
    });
    if (count) return true;
    try {
        await prisma.freeVoteSlot.create({ data: { campaignId, memberId, lastVoteAt: now } });
        return true;
    } catch (error) {
        if (error?.code === 'P2002') return false; // the slot exists and was used within the day
        throw error;
    }
};

/**
 * Use up today's free vote without casting one: a VIP pass's instant votes
 * count as that day's. Does nothing if today's was already used.
 */
export const takeTodaysVote = (campaignId, memberId, at = new Date()) => claimSlot(campaignId, memberId, at);

/** Give the vote back, when a check after claiming it says no. */
const releaseSlot = (campaignId, memberId, now) =>
    prisma.freeVoteSlot.updateMany({ where: { campaignId, memberId, lastVoteAt: now }, data: { lastVoteAt: new Date(0) } });

/**
 * Cast the signed-in voter's free vote for a contestant.
 * @param {{ campaignId: string, participantId: string, memberId: string, ip: string, deviceId: string }} vote
 */
export const castFreeVote = async ({ campaignId, participantId, memberId, ip, deviceId }) => {
    await openForVotes(campaignId, participantId);
    const now = new Date();
    const since = new Date(now.getTime() - DAY);
    const ipHash = hashed('ip', ip || 'unknown');
    const deviceHash = hashed('device', deviceId);

    if (!(await claimSlot(campaignId, memberId, now))) throw used(await nextFreeVoteAt(campaignId, memberId) ?? new Date(now.getTime() + DAY));

    const [fromDevice, fromNetwork] = await Promise.all([
        prisma.freeVote.count({ where: { campaignId, deviceHash, createdAt: { gt: since } } }),
        prisma.freeVote.count({ where: { campaignId, ipHash, createdAt: { gt: since } } }),
    ]);
    if (fromDevice >= DEVICE_LIMIT || fromNetwork >= NETWORK_LIMIT) {
        await releaseSlot(campaignId, memberId, now);
        throw fromDevice >= DEVICE_LIMIT
            ? new AppError("Today's free vote in this campaign has already been used on this device.", 429, { code: 'device_limit' })
            : new AppError('Too many free votes from this network today. You can still boost with paid votes.', 429, { code: 'network_limit' });
    }

    // A VIP voter's free vote counts their pass's daily votes.
    const pass = await activePass(campaignId, memberId);
    const votes = pass?.dailyVotes ?? 1;
    // Two single-document writes rather than one transaction: a popular contestant gets many votes
    // at once, and transactions on the same document would fail each other with write conflicts.
    await prisma.freeVote.create({ data: { campaignId, participantId, memberId, votes, vip: Boolean(pass), ipHash, deviceHash } });
    await prisma.contestant.update({ where: { id: participantId }, data: { platformVotes: { increment: votes } } });

    invalidateSite('campaigns', { id: campaignId });
    invalidate('admin', ['admin', 'campaigns'], { id: campaignId });
    return { participantId, added: votes, isVip: Boolean(pass), nextFreeVoteAt: new Date(now.getTime() + DAY).toISOString() };
};
