import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * Where every vote in a campaign came from, for Studio › Voting › Campaigns
 * › Votes. Worked out from the records themselves (each free vote, each
 * PesaPal order), never from the contestants' running counters, so the
 * counters can be checked against them.
 *
 *   imported      votes carried over from before the platform
 *   free          a signed-in voter's daily free vote
 *   vipDaily      a VIP pass's daily votes: given automatically each day (VipCredit), or,
 *                 before they were automatic, the voter's free vote cast with the pass
 *   bought        votes paid for through PesaPal
 *   vipInstant    the votes a VIP purchase adds at once
 *
 * No payment details are kept anywhere: a paid vote is known by PesaPal's
 * reference and confirmation code, and by the buyer's account if they were signed in.
 */

const TYPES = ['free', 'vipDaily', 'bought', 'vipInstant'];
const zero = () => ({ imported: 0, free: 0, vipDaily: 0, bought: 0, vipInstant: 0, total: 0 });
const notFound = () => new AppError('Campaign not found.', 404);

// MongoDB hands ids back as { $oid } from a raw aggregation.
const idOf = (v) => (v && typeof v === 'object' && '$oid' in v ? v.$oid : v ?? null);

/**
 * Free votes per contestant, VIP or not, added up in MongoDB itself. Raw,
 * because Prisma's groupBy crashes on a row missing a grouped field (free
 * votes cast before `vip` existed); here a missing `vip` simply counts as false.
 */
const freeVoteGroups = async (campaignId) => {
    const rows = await prisma.freeVote.aggregateRaw({
        pipeline: [
            { $match: { campaignId: { $oid: campaignId } } },
            { $group: { _id: { participantId: '$participantId', vip: { $ifNull: ['$vip', false] } }, votes: { $sum: '$votes' }, count: { $sum: 1 } } },
        ],
    });
    return rows.map((r) => ({ participantId: idOf(r._id.participantId), vip: Boolean(r._id.vip), votes: Number(r.votes) || 0, count: Number(r.count) || 0 }));
};

/** How many different voters cast a free vote in the campaign. */
const freeVoterCount = async (campaignId) => {
    const [row] = await prisma.freeVote.aggregateRaw({
        pipeline: [{ $match: { campaignId: { $oid: campaignId } } }, { $group: { _id: '$memberId' } }, { $count: 'voters' }],
    });
    return Number(row?.voters) || 0;
};

const add = (t, key, n) => {
    t[key] += n;
    t.total += n;
};

/**
 * The campaign's votes by source, overall and per contestant, with the
 * check that each contestant's counter equals what their records add up to.
 * @param {string} campaignId
 */
export const voteBreakdown = async (campaignId) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, importedVotes: true } });
    if (!campaign) throw notFound();

    const [contestants, free, credits, paid, freeVoters, buyers, reversed] = await Promise.all([
        prisma.contestant.findMany({ where: { campaignId }, orderBy: { number: 'asc' } }),
        freeVoteGroups(campaignId),
        prisma.vipCredit.groupBy({ by: ['participantId'], where: { campaignId }, _sum: { votes: true }, _count: { _all: true } }),
        // Every field grouped on here is always set on an order.
        prisma.paymentOrder.groupBy({ by: ['participantId', 'kind'], where: { campaignId, module: 'voting', status: 'completed' }, _sum: { votes: true }, _count: { _all: true } }),
        freeVoterCount(campaignId),
        // Orders from before memberId existed have no such field: read the ids rather than group on them.
        prisma.paymentOrder.findMany({ where: { campaignId, module: 'voting', status: 'completed', memberId: { not: null } }, select: { memberId: true } }),
        prisma.paymentOrder.count({ where: { campaignId, module: 'voting', status: 'reversed' } }),
    ]);

    const rows = new Map(contestants.map((c) => [c.id, { id: c.id, fullName: c.fullName, number: c.number, counter: c.importedVotes + c.platformVotes, ...zero() }]));
    const totals = zero();
    // Votes carried over at campaign level, on no contestant.
    add(totals, 'imported', campaign.importedVotes);
    for (const c of contestants) {
        add(rows.get(c.id), 'imported', c.importedVotes);
        add(totals, 'imported', c.importedVotes);
    }
    const counts = { freeVotes: 0, vipCredits: 0, orders: 0 };
    for (const g of free) {
        const key = g.vip ? 'vipDaily' : 'free';
        const n = g.votes;
        counts.freeVotes += g.count;
        add(totals, key, n);
        if (rows.has(g.participantId)) add(rows.get(g.participantId), key, n);
    }
    for (const g of credits) {
        const n = g._sum.votes ?? 0;
        counts.vipCredits += g._count._all;
        add(totals, 'vipDaily', n);
        if (rows.has(g.participantId)) add(rows.get(g.participantId), 'vipDaily', n);
    }
    for (const g of paid) {
        const key = g.kind === 'vip' ? 'vipInstant' : 'bought';
        const n = g._sum.votes ?? 0;
        counts.orders += g._count._all;
        add(totals, key, n);
        if (g.participantId && rows.has(g.participantId)) add(rows.get(g.participantId), key, n);
    }

    const perContestant = [...rows.values()].map((r) => ({ ...r, matches: r.counter === r.total, difference: r.counter - r.total }));
    return {
        totals,
        contestants: perContestant.sort((a, b) => b.total - a.total || a.number - b.number),
        check: { matches: perContestant.every((r) => r.matches), mismatched: perContestant.filter((r) => !r.matches).length },
        people: { freeVoters, signedInBuyers: new Set(buyers.map((b) => b.memberId).filter(Boolean)).size },
        records: { ...counts, reversedOrders: reversed },
    };
};

/**
 * Every vote in the campaign, newest first, a page at a time: free votes,
 * automatic VIP daily votes and completed or reversed PesaPal orders, merged
 * by time. `memberId` narrows it to one voter (a VIP pass's history). `before` is the
 * previous page's `next`. Voter names and emails only with `identities`
 * (Super Admin, Moderator); otherwise a short voter id, so repeat voters can
 * still be spotted.
 * @param {string} campaignId
 * @param {{ type?: string, participantId?: string, memberId?: string, before?: string, limit?: number }} query
 * @param {{ identities: boolean }} access
 */
export const voteLedger = async (campaignId, { type, participantId, memberId, before, limit = 100 }, { identities }) => {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!campaign) throw notFound();
    const at = before ? { lt: new Date(before) } : undefined;
    const contestant = { ...(participantId ? { participantId } : {}), ...(memberId ? { memberId } : {}) };
    const wantFree = !type || type === 'free' || type === 'vipDaily';
    const wantCredits = !type || type === 'vipDaily';
    const wantPaid = !type || type === 'bought' || type === 'vipInstant';

    const [free, credits, orders] = await Promise.all([
        wantFree
            ? prisma.freeVote.findMany({
                where: { campaignId, ...contestant, ...(type === 'vipDaily' ? { vip: true } : type === 'free' ? { vip: { not: true } } : {}), ...(at ? { createdAt: at } : {}) },
                orderBy: { createdAt: 'desc' },
                take: limit,
            })
            : [],
        wantCredits
            ? prisma.vipCredit.findMany({ where: { campaignId, ...contestant, ...(at ? { createdAt: at } : {}) }, orderBy: { createdAt: 'desc' }, take: limit })
            : [],
        wantPaid
            ? prisma.paymentOrder.findMany({
                where: {
                    campaignId, module: 'voting', status: { in: ['completed', 'reversed'] }, ...contestant,
                    ...(type ? { kind: type === 'vipInstant' ? 'vip' : 'votes' } : {}),
                    // Paid votes count from when PesaPal confirmed them.
                    ...(at ? { completedAt: at } : { completedAt: { not: null } }),
                },
                orderBy: { completedAt: 'desc' },
                take: limit,
            })
            : [],
    ]);

    const merged = [
        ...free.map((v) => ({ at: v.createdAt, row: v, source: 'free' })),
        ...credits.map((v) => ({ at: v.createdAt, row: v, source: 'credit' })),
        ...orders.map((o) => ({ at: o.completedAt, row: o, source: 'order' })),
    ].sort((a, b) => b.at - a.at).slice(0, limit);

    const memberIds = [...new Set(merged.map((m) => m.row.memberId).filter(Boolean))];
    const contestantIds = [...new Set(merged.map((m) => m.row.participantId).filter(Boolean))];
    const [members, contestants] = await Promise.all([
        identities && memberIds.length ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, email: true } }) : [],
        contestantIds.length ? prisma.contestant.findMany({ where: { id: { in: contestantIds } }, select: { id: true, fullName: true, number: true } }) : [],
    ]);
    const people = new Map(members.map((m) => [m.id, m]));
    const names = new Map(contestants.map((c) => [c.id, c]));

    const who = (memberId) => {
        if (!memberId) return null;
        const person = people.get(memberId);
        return { voterRef: memberId.slice(-6).toUpperCase(), ...(identities && person ? { name: person.name, email: person.email ?? '' } : {}) };
    };

    const items = merged.map(({ at: when, row, source }) => {
        const c = names.get(row.participantId);
        const base = { id: row.id, at: when.toISOString(), participantId: row.participantId, contestantName: c?.fullName ?? 'Removed contestant', contestantNumber: c?.number ?? null, votes: row.votes, voter: who(row.memberId) };
        if (source === 'free') return { ...base, type: row.vip ? 'vipDaily' : 'free', status: 'counted' };
        // Given automatically by the voter's VIP pass, on its `day`.
        if (source === 'credit') return { ...base, type: 'vipDaily', status: 'counted', auto: true, day: row.day };
        return {
            ...base,
            type: row.kind === 'vip' ? 'vipInstant' : 'bought',
            // A reversed payment's votes were taken back: it shows, but no longer counts.
            status: row.status === 'reversed' ? 'reversed' : 'counted',
            reference: row.reference,
            transactionId: row.confirmationCode || row.trackingId || '',
            method: row.method || 'PesaPal',
            amountUGX: row.amountUGX,
        };
    });

    return { items, next: items.length === limit ? items[items.length - 1].at : null };
};

export const LEDGER_TYPES = TYPES;
