import { z } from 'zod';
import { imageField, objectId, text } from './common.mjs';

// The date rules (both set before publishing, closing on or after opening) need the stored campaign,
// so services/voting/campaigns.mjs checks them.
const day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a date like 2026-11-30.');
const wholeAboveZero = z.coerce.number({ error: 'Prices and VIP votes must be whole numbers above 0.' }).int('Prices and VIP votes must be whole numbers above 0.').min(1, 'Prices and VIP votes must be whole numbers above 0.').max(100_000_000);

const campaignFields = {
    title: text(140).pipe(z.string().min(1, 'Give the campaign a title.')),
    description: text(2000),
    startDate: day,
    endDate: day,
    image: imageField('The cover'),
    category: text(60),
    organizer: text(120),
    organizerBadge: z.enum(['official', 'verified']),
    featured: z.boolean(),
    votePriceUGX: wholeAboveZero,
    vipPriceUGX: wholeAboveZero,
    vipDailyVotes: wholeAboveZero,
    vipTicketPerk: text(200),
    winner: text(120).optional(),
    logo: imageField('The logo'),
    prize: text(500),
    rules: text(4000),
};

/** POST voting/studio/campaigns. A new campaign is always a draft, whatever is sent. */
export const createCampaignBody = z.object({
    ...campaignFields,
    description: campaignFields.description.default(''),
    startDate: day.default(''),
    endDate: day.default(''),
    image: campaignFields.image.default(''),
    category: campaignFields.category.default(''),
    organizer: campaignFields.organizer.default('The Artistry360'),
    organizerBadge: campaignFields.organizerBadge.default('official'),
    featured: campaignFields.featured.default(false),
    vipTicketPerk: campaignFields.vipTicketPerk.default(''),
    logo: campaignFields.logo.default(''),
    prize: campaignFields.prize.default(''),
    rules: campaignFields.rules.default(''),
    // The organiser request it was set up for (Studio › Voting › Requests).
    requestId: objectId.optional(),
});

/** PATCH voting/studio/campaigns/:id: any of the fields, plus publishing. Unknown fields are dropped. */
export const updateCampaignBody = z.object({
    ...campaignFields,
    publishStatus: z.enum(['draft', 'published']),
}).partial();

export const closeBody = z.object({ closed: z.boolean({ error: 'Say whether voting should be closed.' }) });

export const takeDownBody = z.object({
    reason: text(500).pipe(z.string().min(1, 'Say why, so the organiser knows what to fix.')),
});

const contestantFields = {
    fullName: text(120).pipe(z.string().min(1, "Enter the contestant's name.")),
    number: z.coerce.number().int('Use a whole number.').min(1, 'Numbers start at 1.').max(100_000),
    photo: imageField('The photo'),
    bio: text(1000),
};

export const createContestantBody = z.object({
    ...contestantFields,
    number: contestantFields.number.optional(),
    photo: contestantFields.photo.default(''),
    bio: contestantFields.bio.default(''),
});

export const updateContestantBody = z.object(contestantFields).partial();
