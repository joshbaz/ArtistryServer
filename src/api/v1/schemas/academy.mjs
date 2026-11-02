import { z } from 'zod';
import { text } from './common.mjs';

const liveClassFields = {
    title: text(140).pipe(z.string().min(1, 'Give the class a title.')),
    instructor: text(120),
    startsAt: z.iso.datetime({ offset: true, error: 'Pick a start time.' }).transform((v) => new Date(v)),
    durationMinutes: z.coerce.number().int('Use whole minutes.').min(15, 'At least 15 minutes.').max(480, 'At most 8 hours.'),
    tier: z.enum(['free', 'subscription', 'ppv'], { error: 'Choose who can watch.' }),
    priceUGX: z.coerce.number().int('Use a whole number.').min(0).max(100_000_000),
    description: text(2000),
    status: z.enum(['scheduled', 'live', 'ended', 'cancelled']),
    recordReplay: z.boolean(),
};

/** POST academy/live-classes */
export const createLiveClassBody = z.object({
    ...liveClassFields,
    instructor: liveClassFields.instructor.default(''),
    tier: liveClassFields.tier.default('subscription'),
    priceUGX: liveClassFields.priceUGX.default(0),
    description: liveClassFields.description.default(''),
    status: liveClassFields.status.default('scheduled'),
    recordReplay: liveClassFields.recordReplay.default(true),
}).refine((v) => v.tier !== 'ppv' || v.priceUGX > 0, { path: ['priceUGX'], message: 'Set a price for a pay-per-view class.' });

/** PATCH academy/live-classes/:id */
export const updateLiveClassBody = z.object(liveClassFields).partial();
