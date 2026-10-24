import { z } from 'zod';
import { objectId, text } from './common.mjs';

// The same lists and messages as the client's organizerSchema (pages/6.voting/sections/organizer/organizerSchema.js).
export const CAMPAIGN_TYPES = ['Beauty Pageant', 'Music Competition', 'Film Festival', 'Acting / Film', 'School / Education', 'Sports', 'Other'];
export const CONTESTANT_RANGES = ['Under 10', '10–30', '30–100', 'Over 100'];
export const START_OPTIONS = ['As soon as possible', 'Within a month', 'In 1–3 months', 'Not sure yet'];

const choice = (list, message) => z.string({ error: message }).refine((v) => list.includes(v), message);

/** POST organisers/requests. `agreed` must be true, but isn't stored. */
export const requestBody = z.object({
    orgName: text(120).pipe(z.string().min(1, "Enter your organisation's name")),
    contactName: text(80).pipe(z.string().min(1, 'Enter your name')),
    email: z.string({ error: 'Enter a valid email address' }).trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address')),
    phone: z.string({ error: 'Enter a phone number, e.g. +256 700 000 000' }).trim().regex(/^\+?[\d\s-]{9,16}$/, 'Enter a phone number, e.g. +256 700 000 000'),
    campaignType: choice(CAMPAIGN_TYPES, 'Choose the kind of campaign'),
    campaignName: text(120).default(''),
    contestants: choice(CONTESTANT_RANGES, 'Choose roughly how many'),
    start: choice(START_OPTIONS, "Choose when you'd like to start"),
    description: text(1000).default(''),
    agreed: z.literal(true, { error: 'Please agree to the terms to send your request' }),
}).transform(({ agreed: _agreed, ...row }) => row);

/** PATCH organisers/requests/:id */
export const updateRequestBody = z.object({
    status: z.enum(['pending', 'approved', 'declined']).optional(),
    campaignId: objectId.optional(),
}).refine((b) => b.status || b.campaignId, 'Send a status or a campaign.');
