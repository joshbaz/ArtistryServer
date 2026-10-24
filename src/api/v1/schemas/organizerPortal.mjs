import { z } from 'zod';
import { imageField, objectId, text } from './common.mjs';
import { MIN_ORGANIZER_PASSWORD } from '../../../services/organisers/accounts.mjs';
import { PAYOUT_METHODS } from '../../../services/organisers/payouts.mjs';

const day = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a date like 2026-11-30.');
const password = z.string({ error: `Use at least ${MIN_ORGANIZER_PASSWORD} characters.` }).min(MIN_ORGANIZER_PASSWORD, `Use at least ${MIN_ORGANIZER_PASSWORD} characters.`).max(200);

/* auth/organizer */

export const loginBody = z.object({
    email: z.string({ error: 'Enter your email address.' }).trim().min(1, 'Enter your email address.').max(254).pipe(z.email('Enter a valid email address.')),
    password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(200),
});

export const inviteParam = z.object({ token: z.string().regex(/^[\w-]{20,64}$/) });

export const acceptInviteBody = z.object({
    contactName: text(80).default(''),
    password,
});

/* organizer/… */

/** What an organiser may change: never prices, VIP, featured, the badge or totals (those fields are dropped). */
export const updateCampaignBody = z.object({
    title: text(140).pipe(z.string().min(1, 'Give the campaign a title.')),
    description: text(2000),
    category: text(60),
    image: imageField('The banner'),
    logo: imageField('The logo'),
    prize: text(300),
    rules: text(2000),
    startDate: day,
    endDate: day,
}).partial();

export const publishBody = z.object({ published: z.boolean({ error: 'Say whether to publish.' }) });

const contestantRow = z.object({
    fullName: text(120).pipe(z.string().min(1, "Enter the contestant's name.")),
    photo: imageField('The photo').default(''),
    bio: text(400).default(''),
});

/** One or many (a pasted list or CSV), checked together: a bad row adds nothing. */
export const addContestantsBody = z.object({
    rows: z.array(contestantRow, { error: 'Add at least one contestant.' }).min(1, 'Add at least one contestant.').max(200, 'Add up to 200 at a time.'),
});

export const updateContestantBody = z.object({
    fullName: contestantRow.shape.fullName,
    photo: imageField('The photo'),
    bio: text(400),
}).partial();

export const moveBody = z.object({ step: z.union([z.literal(-1), z.literal(1)], { error: 'Move up (-1) or down (1).' }) });

export const payoutBody = z.object({
    campaignId: objectId,
    method: z.enum(PAYOUT_METHODS, { error: "Choose how you'd like to be paid." }),
    accountName: text(120).pipe(z.string().min(1, 'Enter the name on the account.')),
    accountNumber: text(40),
}).superRefine((b, ctx) => {
    const number = b.accountNumber.replace(/\s/g, '');
    if (b.method !== 'Bank transfer' && !/^\+?2567\d{8}$/.test(number)) {
        ctx.addIssue({ code: 'custom', path: ['accountNumber'], message: 'Enter a Ugandan mobile money number, e.g. +256 772 000 000.' });
    }
    if (b.method === 'Bank transfer' && number.length < 6) {
        ctx.addIssue({ code: 'custom', path: ['accountNumber'], message: 'Enter the bank account number.' });
    }
});

export const profileBody = z.object({
    contactName: text(80).pipe(z.string().min(1, 'Enter a contact name.')),
    phone: z.string().trim().regex(/^(\+?[\d\s-]{9,16})?$/, 'Enter a phone number, e.g. +256 700 000 000'),
    logo: imageField('The logo'),
}).partial();

export const passwordBody = z.object({
    current: z.string({ error: 'Enter your current password.' }).min(1, 'Enter your current password.').max(200),
    next: password,
});
