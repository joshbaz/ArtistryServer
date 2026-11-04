import prisma from '../../utils/db.mjs';
import { roleAllows } from '../../utils/permissions.mjs';

/**
 * The figures behind Studio › Overview that only the server can know: money
 * by month, members, payouts waiting and what happened lately. Streaming,
 * voting, enquiries and the approval queues the Studio counts itself from
 * the lists it already loads, so the two never disagree.
 *
 * Money (revenue and payments in the activity feed) is for a Super Admin and
 * Finance only; other roles get `revenue: null` and no payments in the feed.
 * No payer details are kept, so none appear: a payment is its item and amount.
 */

const MONTHS = 6;
const ACTIVITY = 8;
const ACTIVITY_DAYS = 30;
const DAY = 24 * 3600 * 1000;
// Kampala is UTC+3 all year: months turn at its midnight, not UTC's.
const KAMPALA = 3 * 3600 * 1000;

const monthKey = (date) => new Date(date.getTime() + KAMPALA).toISOString().slice(0, 7);
/** The instant month `offset` (0 this month, -1 last month…) starts in Kampala. */
const monthStart = (now, offset) => {
    const k = new Date(now.getTime() + KAMPALA);
    return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + offset, 1) - KAMPALA);
};

const ugx = (n) => `UGX ${n.toLocaleString('en')}`;
const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

// Which bar a completed payment adds to.
const SOURCE = { subscription: 'subscriptions', renewal: 'subscriptions', ppv: 'payPerView', votes: 'votes', vip: 'votes' };

const revenueByMonth = async (now) => {
    const from = monthStart(now, -(MONTHS - 1));
    const months = Array.from({ length: MONTHS }, (_, i) => ({ month: monthKey(monthStart(now, i - (MONTHS - 1))), subscriptions: 0, payPerView: 0, votes: 0 }));
    const byKey = new Map(months.map((m) => [m.month, m]));
    // Counted when PesaPal confirmed it; a refunded payment is `reversed` and drops out.
    const orders = await prisma.paymentOrder.findMany({
        where: { status: 'completed', OR: [{ completedAt: { gte: from } }, { completedAt: null, createdAt: { gte: from } }] },
        select: { kind: true, amountUGX: true, completedAt: true, createdAt: true },
    });
    for (const o of orders) {
        const m = byKey.get(monthKey(o.completedAt ?? o.createdAt));
        if (m && SOURCE[o.kind]) m[SOURCE[o.kind]] += o.amountUGX;
    }
    const sum = (m) => (m ? m.subscriptions + m.payPerView + m.votes : 0);
    return { months, thisMonth: sum(months.at(-1)), lastMonth: sum(months.at(-2)) };
};

const memberCounts = async (now) => {
    const [total, subscribers, subscribersChange] = await Promise.all([
        prisma.member.count({ where: { status: 'active' } }),
        prisma.streamSubscription.count({ where: { currentPeriodEnd: { gt: now } } }),
        // Plans started (or started again after lapsing) this month and still running.
        prisma.streamSubscription.count({ where: { currentPeriodEnd: { gt: now }, startedAt: { gte: monthStart(now, 0) } } }),
    ]);
    // Live classes are a later phase: activeStudents stays 0 until they're back.
    return { total, subscribers, subscribersChange, freeMembers: Math.max(0, total - subscribers), activeStudents: 0 };
};

const PAYMENT_ACTION = {
    subscription: { action: 'New subscriber', tone: 'success' },
    renewal: { action: 'Plan renewed', tone: 'success' },
    ppv: { action: 'Title rented', tone: 'success' },
    votes: { action: 'Votes bought', tone: 'gold' },
    vip: { action: 'VIP pass bought', tone: 'gold' },
};

const recentActivity = async (now, { money }) => {
    const since = new Date(now.getTime() - ACTIVITY_DAYS * DAY);
    const recent = { orderBy: { createdAt: 'desc' }, take: ACTIVITY };
    const [orders, enquiries, bookings, requests, members, ended] = await Promise.all([
        money
            ? prisma.paymentOrder.findMany({ where: { status: 'completed', completedAt: { gte: since } }, orderBy: { completedAt: 'desc' }, take: ACTIVITY, select: { id: true, kind: true, amountUGX: true, votes: true, itemName: true, campaignId: true, method: true, completedAt: true } })
            : [],
        prisma.enquiry.findMany({ where: { createdAt: { gte: since } }, ...recent, select: { id: true, name: true, subject: true, createdAt: true } }),
        prisma.booking.findMany({ where: { createdAt: { gte: since } }, ...recent, select: { id: true, reference: true, name: true, talentIds: true, createdAt: true } }),
        prisma.organiserRequest.findMany({ where: { submittedAt: { gte: since } }, orderBy: { submittedAt: 'desc' }, take: ACTIVITY, select: { id: true, orgName: true, campaignName: true, submittedAt: true } }),
        prisma.member.findMany({ where: { createdAt: { gte: since } }, ...recent, select: { id: true, name: true, lastSignInWith: true, createdAt: true } }),
        prisma.campaign.findMany({
            where: { publishStatus: 'published', OR: [{ closedAt: { gte: since } }, { closedAt: null, endDate: { gte: monthKey(since) } }] },
            select: { id: true, title: true, closedAt: true, endDate: true, importedVotes: true },
        }),
    ]);

    // Campaigns that ended lately: closed early in the Studio, or past their last day (23:59:59 Kampala).
    const endOf = (c) => c.closedAt ?? (c.endDate ? new Date(Date.parse(`${c.endDate}T23:59:59.999Z`) - KAMPALA) : null);
    const closed = ended.map((c) => ({ ...c, at: endOf(c) })).filter((c) => c.at && c.at >= since && c.at <= now);

    const campaignIds = [...new Set([...orders.map((o) => o.campaignId), ...closed.map((c) => c.id)].filter(Boolean))];
    const [campaigns, boards] = await Promise.all([
        prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, title: true } }),
        closed.length
            ? prisma.contestant.groupBy({ by: ['campaignId'], where: { campaignId: { in: closed.map((c) => c.id) } }, _sum: { importedVotes: true, platformVotes: true } })
            : [],
    ]);
    const title = new Map(campaigns.map((c) => [c.id, c.title]));
    // The same total Voting shows: carried-over votes plus every contestant's.
    const cast = new Map(closed.map((c) => [c.id, c.importedVotes]));
    for (const b of boards) cast.set(b.campaignId, (cast.get(b.campaignId) ?? 0) + (b._sum.importedVotes ?? 0) + (b._sum.platformVotes ?? 0));

    const items = [
        ...orders.map((o) => {
            const what = o.kind === 'votes' ? `${plural(o.votes, 'vote', 'votes')} in ${title.get(o.campaignId) ?? 'a campaign'}`
                : o.kind === 'vip' ? title.get(o.campaignId) ?? 'A campaign'
                    : o.itemName || 'Streaming';
            return { id: `pay-${o.id}`, ...PAYMENT_ACTION[o.kind], detail: `${what} · ${ugx(o.amountUGX)}${o.method ? ` by ${o.method}` : ''}`, at: o.completedAt };
        }),
        ...enquiries.map((e) => ({ id: `enq-${e.id}`, action: 'Enquiry received', detail: `${e.name}: ${e.subject}`, tone: 'info', at: e.createdAt })),
        ...bookings.map((b) => ({ id: `bk-${b.id}`, action: 'Booking request', detail: `${b.name} asked for ${plural(b.talentIds.length, 'talent', 'talents')} (${b.reference})`, tone: 'brand', at: b.createdAt })),
        ...requests.map((r) => ({ id: `org-${r.id}`, action: 'Organiser request', detail: r.campaignName ? `${r.orgName}: ${r.campaignName}` : r.orgName, tone: 'info', at: r.submittedAt })),
        ...members.map((m) => ({ id: `mem-${m.id}`, action: 'New member', detail: `${m.name || 'Someone'} joined${m.lastSignInWith ? ` with ${m.lastSignInWith === 'apple' ? 'Apple' : 'Google'}` : ''}`, tone: 'brand', at: m.createdAt })),
        ...closed.map((c) => ({ id: `end-${c.id}`, action: 'Campaign ended', detail: `"${c.title}" closed with ${plural(cast.get(c.id) ?? 0, 'vote', 'votes')}`, tone: 'info', at: c.at })),
    ];
    return items
        .sort((a, b) => b.at - a.at)
        .slice(0, ACTIVITY)
        .map((i) => ({ ...i, at: i.at.toISOString() }));
};

/** @param {{ role: string }} admin the signed-in staff member */
export const getOverview = async (admin) => {
    const now = new Date();
    const money = roleAllows(admin.role, ['finance']);
    const [revenue, members, payoutsDue, recent] = await Promise.all([
        money ? revenueByMonth(now) : null,
        memberCounts(now),
        prisma.payoutRequest.count({ where: { status: 'requested' } }),
        recentActivity(now, { money }),
    ]);
    return { revenue, members, queues: { payoutsDue }, recentActivity: recent };
};
