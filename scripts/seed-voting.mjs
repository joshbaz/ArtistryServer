/**
 * Load the client's demo voting data into the database: the same campaigns,
 * contestants and organiser requests /voting and the Studio show on mocks.
 * Development only.
 *
 *   yarn seed:voting            only if there are no campaigns yet
 *   yarn seed:voting --reset    delete every campaign, contestant and request first
 *
 * The demo ids (camp_001, vp_001_01…) become MongoDB ids. Organiser links
 * (organizerId) are left out until organiser accounts exist (build step 4).
 */
import { parseArgs } from 'node:util';
import prisma from '../src/utils/db.mjs';
import { votingCampaignsSeed } from '../../client/src/data/votingCampaigns.js';
import { contestantsSeed } from '../../client/src/data/votingParticipants.js';
import { organiserRequests } from '../../client/src/data/organiserRequests.js';

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
        await prisma.contestant.deleteMany();
        await prisma.campaign.deleteMany();
        await prisma.organiserRequest.deleteMany();
    } else if (await prisma.campaign.count()) {
        console.info('Campaigns already exist; nothing seeded. Use --reset to start over.');
        process.exit(0);
    }

    const campaignIds = new Map();
    for (const c of votingCampaignsSeed) {
        const row = await prisma.campaign.create({
            data: { ...pick(c, CAMPAIGN_KEYS), ...(c.closedAt ? { closedAt: new Date(c.closedAt) } : {}) },
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

    console.info(`Seeded ${campaignIds.size} campaigns, ${await prisma.contestant.count()} contestants and ${organiserRequests.length} organiser requests.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
