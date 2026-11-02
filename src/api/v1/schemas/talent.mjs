import { z } from 'zod';
import { imageField, objectId, text } from './common.mjs';

/** The scales the Studio's form offers (client utils/talent.js). Disciplines, places and languages are editable lists. */
const EXPERIENCE = ['New (under 1 year)', '1–3 years', '3–5 years', '5–10 years', '10+ years'];
const AVAILABILITY = ['available', 'on-project', 'unavailable'];
const PROJECT_TYPES = ['Film', 'Series', 'Commercial', 'Music video', 'Stage', 'Event', 'Voice-over', 'Other'];

const phone = z.union([z.literal(''), z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a phone number, e.g. +256 772 000 000.')]);
const email = z.union([z.literal(''), z.string().trim().max(120).email('Enter a valid email address.')]);
const listOf = (max, itemMax, message) => z.array(text(itemMax).pipe(z.string().min(1))).max(max, message);

/** The public reference, T-001, and the URL slug, t-001. */
export const talentRef = z.string().regex(/^T-\d{3,}$/, 'Choose a talent from the roster.');
export const slugParam = z.object({ id: z.string().regex(/^t-\d{3,}$/) });
export const talentRefParam = z.object({ talentId: talentRef });

const project = z.object({
    id: z.union([z.string().max(40), z.number().int()]),
    title: text(120),
    description: text(500),
    image: imageField('The project image'),
});

const talentFields = {
    firstName: text(40).pipe(z.string().min(1, 'Enter a first name.')),
    lastName: text(60),
    primaryRole: text(60).pipe(z.string().min(1, 'Choose their main discipline.')),
    otherRoles: listOf(4, 60, 'Up to 4 other disciplines.'),
    skills: listOf(10, 30, 'Up to 10 skills.'),
    experience: z.enum(EXPERIENCE, { error: 'Choose their experience.' }),
    base: text(60).pipe(z.string().min(1, "Choose where they're based.")),
    languages: listOf(6, 40, 'Up to 6 languages.'),
    availability: z.enum(AVAILABILITY),
    published: z.boolean(),
    phone,
    email,
    shortBio: text(700),
    profileImg: imageField('The profile photo'),
    headerImage: imageField('The header photo'),
    projects: z.array(project).max(20, 'Up to 20 projects.'),
};

// What publishing needs: a photo and a bio someone would read.
const publishable = (v) => !v.published || (v.shortBio?.length ?? 0) >= 40;
const bioMessage = { path: ['shortBio'], message: 'Published talent needs a bio of at least 40 characters.' };

/** POST talent. The server gives the reference and slug. */
export const createTalentBody = z.object({
    ...talentFields,
    lastName: talentFields.lastName.default(''),
    otherRoles: talentFields.otherRoles.default([]),
    skills: talentFields.skills.default([]),
    experience: talentFields.experience.default(EXPERIENCE[1]),
    languages: talentFields.languages.min(1, 'Add at least one language.'),
    availability: talentFields.availability.default('available'),
    published: talentFields.published.default(false),
    phone: phone.default(''),
    email: email.default(''),
    shortBio: talentFields.shortBio.default(''),
    profileImg: talentFields.profileImg.pipe(z.string().min(1, 'Add a profile photo.')),
    headerImage: talentFields.headerImage.default(''),
    projects: talentFields.projects.default([]),
}).refine(publishable, bioMessage).refine((v) => !v.otherRoles.includes(v.primaryRole), { path: ['otherRoles'], message: 'The main discipline is already set above.' });

/** PATCH talent/:id. The reference and slug never change (they're dropped if sent). The service checks publishing against the stored bio. */
export const updateTalentBody = z.object({
    ...talentFields,
    languages: talentFields.languages.min(1, 'Add at least one language.'),
    profileImg: talentFields.profileImg.pipe(z.string().min(1, 'Add a profile photo.')),
}).partial();

/** GET talent/profiles?page=&pageSize= */
export const profilesQuery = z.object({
    page: z.coerce.number().int().min(1).catch(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).catch(20).default(20),
});

/* Monologues */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);

/** The 11-character video id from any YouTube link (watch, youtu.be, shorts, embed, live), or null. */
export const youtubeId = (value) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname)) return null;
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
};

const isHttps = (v) => {
    try {
        return new URL(v).protocol === 'https:';
    } catch {
        return false;
    }
};

const monologueFields = {
    talentId: talentRef,
    title: text(120).pipe(z.string().min(1, 'Give it a title.')),
    source: z.enum(['youtube', 'upload'], { error: 'Choose YouTube or an upload.' }),
    url: z.string().trim().max(2000),
    duration: z.coerce.number().int().min(0).max(24 * 60 * 60).optional(),
};

const linkFits = (v) => v.source === undefined || v.url === undefined || (v.source === 'youtube' ? Boolean(youtubeId(v.url)) : isHttps(v.url));
const linkMessage = (v) => ({ path: ['url'], message: v.source === 'youtube' ? "That isn't a YouTube video link." : 'The upload has no playable link yet.' });

/** POST talent/monologues */
export const createMonologueBody = z.object(monologueFields).superRefine((v, ctx) => {
    if (!linkFits(v)) ctx.addIssue({ code: 'custom', ...linkMessage(v) });
});

/** PATCH talent/monologues/:id: a new link is checked against its source (send both). */
export const updateMonologueBody = z.object(monologueFields).partial().superRefine((v, ctx) => {
    if (v.url !== undefined && v.source === undefined) ctx.addIssue({ code: 'custom', path: ['source'], message: 'Say where the link is from: YouTube or an upload.' });
    else if (!linkFits(v)) ctx.addIssue({ code: 'custom', ...linkMessage(v) });
});

/* Bookings */

/** POST talent/bookings: a guest's request. `website` is the honeypot; consent is the form's, not stored. */
export const bookingRequestBody = z.object({
    talentIds: z.array(talentRef).min(1, 'Choose at least one talent.').max(20, 'Up to 20 talents per request.'),
    name: text(80).pipe(z.string().min(2, 'Enter your name.')),
    email: email.default(''),
    phone: phone.default(''),
    organisation: text(120).default(''),
    projectType: z.enum(PROJECT_TYPES, { error: 'Choose the kind of project.' }),
    dates: text(120).default(''),
    message: text(1000).pipe(z.string().min(10, 'Tell us a little about the project (at least 10 characters).')),
    website: z.string().max(500).optional(),
}).refine((v) => v.email || v.phone, { path: ['email'], message: 'Leave an email or a phone number so we can reach you.' });

const bookingStatus = z.enum(['new', 'contacted', 'confirmed', 'declined'], { error: 'Choose a status.' });

/** PATCH talent/bookings/:id. The history is the server's to write. */
export const updateBookingBody = z.object({
    status: bookingStatus.optional(),
    talentOutcomes: z.record(talentRef, z.enum(['pending', 'confirmed', 'unavailable', 'declined'])).optional(),
    via: z.enum(['email', 'WhatsApp', 'phone']).optional(),
});

/** POST talent/bookings/:id/notes */
export const bookingNoteBody = z.object({ text: text(1000).pipe(z.string().min(1, 'Write the note first.')) });

const ids = z.array(objectId).min(1, 'Choose at least one request.').max(500);

/** PATCH talent/bookings: one status for several. */
export const bulkStatusBody = z.object({ ids, status: bookingStatus });

/** DELETE talent/bookings */
export const bulkDeleteBody = z.object({ ids });
