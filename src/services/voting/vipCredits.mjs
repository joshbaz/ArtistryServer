import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { campaignPhase } from './phase.mjs';
import { openForVotes } from './campaigns.mjs';

/**
 * Automatic VIP votes. A VIP pass gives its daily votes to the voter's
 * contestant at payment (day 1, the order's own votes) and then every 24
 * hours after, until voting closes, without the voter doing anything.
 *
 *   - Each day is given once: the pass's `nextCreditAt` moves on in the same
 *     transaction that adds the votes, guarded on its old value, and each
 *     day's VipCredit is unique per pass, so two runs can't both count it.
 *   - Days missed while the server was down are given on the next run, as
 *     long as voting was still open when they were due.
 *   - A pass from before votes were automatic is set up on its first run:
 *     its contestant is the one it last voted for with the pass, its next
 *     votes are due 24 hours after that vote, and nothing before is added back.
 *
 * Every credit is a VipCredit row, counted in the vote audit as VIP daily votes.
 */

export const DAY = 24 * 60 * 60 * 1000;
// A pass more than this many days behind catches up over the following runs.
const MAX_DAYS_PER_RUN = 60;

const unset = { OR: [{ creditState: null }, { creditState: { isSet: false } }] };

/**
 * Turn a pass from before automatic votes into an automatic one. Does
 * nothing if it's already set up.
 * @param {{ id: string, campaignId: string, memberId: string, orderId: string, dailyVotes: number }} pass
 */
export const setUpPass = async (pass, now = new Date()) => {
    const [lastVip, vipVotes, slot, order] = await Promise.all([
        prisma.freeVote.findFirst({ where: { campaignId: pass.campaignId, memberId: pass.memberId, vip: true }, orderBy: { createdAt: 'desc' }, select: { participantId: true } }),
        prisma.freeVote.aggregate({ where: { campaignId: pass.campaignId, memberId: pass.memberId, vip: true }, _sum: { votes: true }, _count: { _all: true } }),
        prisma.freeVoteSlot.findUnique({ where: { campaignId_memberId: { campaignId: pass.campaignId, memberId: pass.memberId } } }),
        prisma.paymentOrder.findUnique({ where: { id: pass.orderId }, select: { participantId: true, votes: true, completedAt: true } }),
    ]);
    const last = slot?.lastVoteAt ?? order?.completedAt ?? now;
    const due = new Date(last.getTime() + DAY);
    await prisma.vipPass.updateMany({
        where: { id: pass.id, ...unset },
        data: {
            contestantId: lastVip?.participantId ?? order?.participantId ?? null,
            nextCreditAt: due > now ? due : now,
            creditState: 'running',
            daysCredited: 1 + (vipVotes._count._all ?? 0),
            votesCredited: (order?.votes ?? 0) + (vipVotes._sum.votes ?? 0),
        },
    });
    return prisma.vipPass.findUnique({ where: { id: pass.id } });
};

// MongoDB aborts one of two transactions writing the same contestant at once: try again.
const withRetry = async (work, tries = 4) => {
    for (let i = 1; ; i++) {
        try {
            return await work();
        } catch (error) {
            const conflict = error?.code === 'P2034' || /write ?conflict/i.test(error?.message ?? '');
            if (!conflict || i >= tries) throw error;
            await new Promise((r) => setTimeout(r, 50 * i));
        }
    }
};

/**
 * Give one pass every day it's due, up to now. → how many days were given.
 * @param {object} pass - an active, running pass
 * @param {Map<string, object | null>} campaigns - campaigns read this run
 */
const creditPass = async (pass, campaigns, now) => {
    let given = 0;
    let current = pass;
    while (current.nextCreditAt && current.nextCreditAt <= now && given < MAX_DAYS_PER_RUN) {
        const dueAt = current.nextCreditAt;
        if (!campaigns.has(current.campaignId)) campaigns.set(current.campaignId, await prisma.campaign.findUnique({ where: { id: current.campaignId } }));
        const campaign = campaigns.get(current.campaignId);

        // Voting had closed by the time these were due: the pass's daily votes are over.
        if (!campaign || campaignPhase(campaign, dueAt) === 'finished') {
            await prisma.vipPass.updateMany({ where: { id: current.id, nextCreditAt: dueAt }, data: { nextCreditAt: null, creditState: 'ended' } });
            return given;
        }
        // Taken down or unpublished: nothing is given while it's off the site.
        if (campaign.publishStatus !== 'published') return given;
        const contestant = current.contestantId ? await prisma.contestant.findUnique({ where: { id: current.contestantId }, select: { campaignId: true } }) : null;
        if (contestant?.campaignId !== current.campaignId) {
            console.warn(`VIP pass ${current.id}: no contestant to give its daily votes to`);
            return given;
        }

        const day = (current.daysCredited ?? 1) + 1;
        // The next day would fall after voting closes: this is the last one.
        const last = campaignPhase(campaign, new Date(dueAt.getTime() + DAY)) === 'finished';
        const next = last ? null : new Date(dueAt.getTime() + DAY);
        const done = await withRetry(() =>
            prisma.$transaction(async (tx) => {
                const { count } = await tx.vipPass.updateMany({
                    where: { id: current.id, status: 'active', creditState: 'running', nextCreditAt: dueAt },
                    data: { nextCreditAt: next, creditState: last ? 'ended' : 'running', daysCredited: day, votesCredited: { increment: current.dailyVotes } },
                });
                if (!count) return false;
                await tx.vipCredit.create({
                    data: { passId: current.id, campaignId: current.campaignId, memberId: current.memberId, participantId: current.contestantId, day, votes: current.dailyVotes, dueAt },
                });
                await tx.contestant.update({ where: { id: current.contestantId }, data: { platformVotes: { increment: current.dailyVotes } } });
                return true;
            }),
        );
        // Another run got there first.
        if (!done) return given;
        given++;
        if (last) return given;
        current = { ...current, nextCreditAt: next, daysCredited: day };
    }
    return given;
};

/**
 * The scheduler's run: set up passes from before automatic votes, then give
 * every pass the days it's due. → how many days of votes were given.
 */
export const creditDuePasses = async (now = new Date()) => {
    const old = await prisma.vipPass.findMany({ where: { status: 'active', ...unset } });
    for (const pass of old) await setUpPass(pass, now);

    const due = await prisma.vipPass.findMany({ where: { status: 'active', creditState: 'running', nextCreditAt: { lte: now } }, orderBy: { nextCreditAt: 'asc' }, take: 1000 });
    const campaigns = new Map();
    const touched = new Set();
    let given = 0;
    for (const pass of due) {
        try {
            const n = await creditPass(pass, campaigns, now);
            if (n) touched.add(pass.campaignId);
            given += n;
        } catch (error) {
            console.error(`VIP pass ${pass.id}: daily votes not given:`, error.message);
        }
    }
    for (const id of touched) {
        invalidateSite('campaigns', { id });
        invalidate('admin', ['admin', 'campaigns'], { id });
    }
    return given;
};

// Whether a pass's next votes will still come: false once voting closes before they're due.
const stillComing = (pass, campaign) =>
    pass.status === 'active' && pass.creditState === 'running' && Boolean(pass.nextCreditAt) && Boolean(campaign) && campaignPhase(campaign, pass.nextCreditAt) !== 'finished';

/**
 * The voter's pass as their vote window shows it, set up first if it's from
 * before automatic votes. Null without an active pass.
 */
export const passStatus = async (pass) => {
    if (!pass) return null;
    const ready = pass.creditState ? pass : await setUpPass(pass);
    const [contestant, campaign] = await Promise.all([
        ready.contestantId ? prisma.contestant.findUnique({ where: { id: ready.contestantId }, select: { id: true, fullName: true } }) : null,
        prisma.campaign.findUnique({ where: { id: ready.campaignId } }),
    ]);
    const coming = stillComing(ready, campaign);
    return {
        contestantId: contestant?.id ?? null,
        contestantName: contestant?.fullName ?? null,
        day: ready.daysCredited ?? 1,
        votesGiven: ready.votesCredited ?? 0,
        nextCreditAt: coming ? ready.nextCreditAt.toISOString() : null,
        running: coming,
    };
};

/**
 * Send the voter's daily VIP votes to another contestant from the next day on.
 * @param {{ campaignId: string, memberId: string, participantId: string }} change
 */
export const setVipContestant = async ({ campaignId, memberId, participantId }) => {
    const { contestant } = await openForVotes(campaignId, participantId);
    const pass = await prisma.vipPass.findFirst({ where: { campaignId, memberId, status: 'active' } });
    if (!pass) throw new AppError("You're not a VIP voter in this campaign.", 404, { code: 'not_vip' });
    const ready = pass.creditState ? pass : await setUpPass(pass);
    await prisma.vipPass.update({ where: { id: ready.id }, data: { contestantId: contestant.id } });
    return { contestantId: contestant.id, contestantName: contestant.fullName };
};

/**
 * Studio: every VIP pass in a campaign, newest first, with how far its daily
 * votes have got. Voter names and emails only with `identities`.
 * @param {string} campaignId
 * @param {{ identities: boolean }} access
 */
export const listPasses = async (campaignId, { identities }) => {
    const [passes, campaign] = await Promise.all([
        prisma.vipPass.findMany({ where: { campaignId }, orderBy: { createdAt: 'desc' } }),
        prisma.campaign.findUnique({ where: { id: campaignId } }),
    ]);
    const memberIds = [...new Set(passes.map((p) => p.memberId))];
    const contestantIds = [...new Set(passes.map((p) => p.contestantId).filter(Boolean))];
    const [members, contestants] = await Promise.all([
        identities && memberIds.length ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, email: true, lastSignInWith: true } }) : [],
        contestantIds.length ? prisma.contestant.findMany({ where: { id: { in: contestantIds } }, select: { id: true, fullName: true, number: true } }) : [],
    ]);
    const people = new Map(members.map((m) => [m.id, m]));
    const names = new Map(contestants.map((c) => [c.id, c]));
    return passes.map((p) => {
        const person = people.get(p.memberId);
        const c = names.get(p.contestantId);
        return {
            id: p.id,
            memberId: p.memberId,
            voter: { voterRef: p.memberId.slice(-6).toUpperCase(), ...(identities && person ? { name: person.name, email: person.email ?? '', signsInWith: person.lastSignInWith ?? null } : {}) },
            // The voter's event ticket: for the roles that see who they are.
            ...(identities ? { ticketCode: p.ticketCode } : {}),
            contestantName: c?.fullName ?? null,
            contestantNumber: c?.number ?? null,
            dailyVotes: p.dailyVotes,
            day: p.daysCredited ?? null,
            votesGiven: p.votesCredited ?? null,
            nextCreditAt: stillComing(p, campaign) ? p.nextCreditAt.toISOString() : null,
            // active (votes still coming) | finished (voting closed) | revoked (payment reversed) | waiting (set up on the next run)
            state: p.status === 'revoked' ? 'revoked' : p.creditState === 'running' ? (stillComing(p, campaign) ? 'active' : 'finished') : p.creditState === 'ended' ? 'finished' : 'waiting',
            since: p.createdAt.toISOString(),
        };
    });
};
