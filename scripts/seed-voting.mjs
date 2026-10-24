/**
 * Load the client's demo voting data into the database: the same campaigns,
 * contestants and organiser requests /voting and the Studio show on mocks.
 * Development only.
 *
 *   yarn seed:voting            only if there are no campaigns yet
 *   yarn seed:voting --reset    delete every campaign, contestant and request first
 *
 * The demo ids (camp_001, vp_001_01…) become MongoDB ids. Demo organisers
 * who had a password get DEMO_ORGANIZER_PASSWORD; an invited one gets a
 * fresh invite link, printed at the end.
 */
import { parseArgs } from 'node:util';
import prisma from '../src/utils/db.mjs';
import { votingCampaignsSeed } from '../../client/src/data/votingCampaigns.js';
import { contestantsSeed } from '../../client/src/data/votingParticipants.js';
import { organiserRequests } from '../../client/src/data/organiserRequests.js';
import { organizersSeed } from '../../client/src/data/organizers.js';
import { payoutRequestsSeed } from '../../client/src/data/payoutRequests.js';
import { hashPassword } from '../src/services/auth/passwords.mjs';
import { issueInvite } from '../src/services/organisers/accounts.mjs';
import { env } from '../src/env.mjs';

const DEMO_ORGANIZER_PASSWORD = 'demo-organiser';

const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
}

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row[k] !== undefined && row[k] !== null).map((k) => [k, row[k]]));

const CAMPAIGN_KEYS = ['title', 'description', 'startDate', 'endDate', 'image', 'category', 'organizer', 'organizerBadge', 'publishStatus', 'featured', 'votePriceUGX', 'vipPriceUGX', 'vipDailyVotes', 'vipTicketPerk', 'winner', 'importedVotes', 'importedRevenueUGX', 'logo', 'prize', 'rules'];
const REQUEST_KEYS = ['orgName', 'contactName', 'email', 'phone', 'campaignType', 'campaignName', 'contestants', 'start', 'description', 'status'];

try {
    if (values.reset) {
        await prisma.payoutRequest.deleteMany();
        await prisma.session.deleteMany({ where: { realm: 'organizer' } });
        await prisma.organizer.deleteMany();
        await prisma.contestant.deleteMany();
        await prisma.campaign.deleteMany();
        await prisma.organiserRequest.deleteMany();
    } else if (await prisma.campaign.count()) {
        console.info('Campaigns already exist; nothing seeded. Use --reset to start over.');
        process.exit(0);
    }

    const organizerIds = new Map();
    const invites = [];
    const demoHash = await hashPassword(DEMO_ORGANIZER_PASSWORD);
    for (const o of organizersSeed) {
        const row = await prisma.organizer.create({
            data: {
                orgName: o.orgName,
                contactName: o.contactName,
                email: o.email.toLowerCase(),
                phone: o.phone,
                status: o.status,
                sharePercent: o.sharePercent,
                logo: o.logo,
                createdAt: new Date(o.createdAt),
                ...(o.password ? { passwordHash: demoHash } : {}),
            },
        });
        organizerIds.set(o.id, row.id);
        if (!o.password) invites.push(`${o.orgName}: ${env.APP_URL}/organizer/invite/${await issueInvite(row.id)}`);
    }

    const campaignIds = new Map();
    for (const c of votingCampaignsSeed) {
        const row = await prisma.campaign.create({
            data: {
                ...pick(c, CAMPAIGN_KEYS),
                ...(c.closedAt ? { closedAt: new Date(c.closedAt) } : {}),
                ...(c.organizerId && organizerIds.has(c.organizerId) ? { organizerId: organizerIds.get(c.organizerId) } : {}),
            },
        });
        campaignIds.set(c.id, row.id);
    }

    await prisma.contestant.createMany({
        data: contestantsSeed
            .filter((p) => campaignIds.has(p.campaignId))
            .map((p) => ({ campaignId: campaignIds.get(p.campaignId), fullName: p.fullName, number: p.number, photo: p.photo, bio: p.bio, importedVotes: p.votes })),
    });

    for (const r of organiserRequests) {
        await prisma.organiserRequest.create({
            data: {
                ...pick(r, REQUEST_KEYS),
                submittedAt: new Date(r.submittedAt),
                ...(r.campaignId && campaignIds.has(r.campaignId) ? { campaignId: campaignIds.get(r.campaignId) } : {}),
            },
        });
    }

    for (const p of payoutRequestsSeed) {
        if (!organizerIds.has(p.organizerId) || !campaignIds.has(p.campaignId)) continue;
        await prisma.payoutRequest.create({
            data: {
                organizerId: organizerIds.get(p.organizerId),
                campaignId: campaignIds.get(p.campaignId),
                amountUGX: p.amountUGX,
                method: p.method,
                accountName: p.accountName,
                accountNumber: p.accountNumber,
                status: p.status,
                requestedAt: new Date(p.requestedAt),
                ...(p.paidAt ? { paidAt: new Date(p.paidAt) } : {}),
                ...(p.reference ? { reference: p.reference } : {}),
            },
        });
    }

    console.info(`Seeded ${campaignIds.size} campaigns, ${await prisma.contestant.count()} contestants, ${organiserRequests.length} organiser requests, ${organizerIds.size} organisers and ${await prisma.payoutRequest.count()} payout requests.`);
    console.info(`Demo organisers sign in at /organizer/login with their email and the password "${DEMO_ORGANIZER_PASSWORD}" (e.g. organiser@mtu.ug).`);
    for (const line of invites) console.info(`Invite, ${line}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
