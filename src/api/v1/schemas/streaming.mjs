import { z } from 'zod';
import { imageField, objectId, text } from './common.mjs';

/**
 * Studio › Streaming and what stream.theartistry360.com and the app read.
 * Links typed into the Studio end up on the public sites, so they're https://
 * (or, where a page makes sense, a page on the stream site) and nothing else
 * (12-backend-integration.md, Security).
 */

/** A title, episode, plan or term id: ttl_001, cl_s1e1, plan_monthly, cat_drama. */
export const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/i, 'We could not find that.');

const isHttps = (v) => {
    try {
        return new URL(v).protocol === 'https:';
    } catch {
        return false;
    }
};
const httpsOrEmpty = (label) => z.string().trim().max(2000).refine((v) => v === '' || isHttps(v), `${label} must be an https:// link.`);
// "/films" is a page on the stream site; "//other.site" is not.
const linkOrEmpty = (label) => z.string().trim().max(2000).refine((v) => v === '' || isHttps(v) || /^\/(?![/\\])/.test(v), `${label} must be an https:// link or a page on the site, like /films.`);
const isoDate = z.iso.datetime({ offset: true, error: 'Use a full date and time.' });

export const titleParam = z.object({ id: key });
export const termParam = z.object({ id: key });
export const seasonParam = z.object({ id: key, number: z.coerce.number().int().min(1).max(99) });
export const episodeParam = z.object({ id: key, episodeId: key });

/* Types, categories, content warnings */

/** POST / PATCH streaming/types|categories|advisories */
export const termBody = z.object({ name: text(40).pipe(z.string().min(1, 'Give it a name.')) });

/* Titles */

const person = z.object({
    name: text(80).pipe(z.string().min(1, 'Add a name or remove the row.')),
    role: text(60).default(''),
});

const ugx = z.coerce.number().int().max(10_000_000);
/**
 * A pay-per-view title's price stages (services/streaming/pricing.mjs):
 * each later stage costs no more than the one before, and none less than UGX 500.
 * null takes the schedule off (the flat priceUGX again).
 */
export const ppvSchedule = z
    .object({
        premiereAt: isoDate,
        earlyUGX: ugx,
        premiereUGX: ugx,
        standardUGX: ugx.min(500, 'At least UGX 500.'),
        premiereDays: z.coerce.number().int().min(1, '1 to 90 days.').max(90, '1 to 90 days.'),
    })
    .refine((s) => s.premiereUGX >= s.standardUGX, { path: ['premiereUGX'], message: 'Not below the standard price.' })
    .refine((s) => s.earlyUGX >= s.premiereUGX, { path: ['earlyUGX'], message: 'Not below the premiere price.' });

const titleFields = {
    title: text(120).pipe(z.string().min(1, 'Give the title a name.')),
    type: key,
    synopsis: text(200),
    description: text(5000),
    categoryIds: z.array(key).max(20),
    language: text(60).pipe(z.string().min(1, 'Choose a language.')),
    ageRating: z.enum(['G', 'PG', '13+', '16+', '18+'], { error: 'Choose an age rating.' }),
    advisories: z.array(text(40)).max(10, 'Up to 10 content warnings.'),
    releaseYear: z.coerce.number().int().min(1950, 'Check the year.').max(2100, 'Check the year.'),
    poster: imageField('The poster'),
    backdrop: imageField('The backdrop'),
    cast: z.array(person).max(100),
    crew: z.array(person).max(100),
    access: z.object({
        tier: z.enum(['free', 'subscription', 'ppv'], { error: 'Choose who can watch.' }),
        // With a schedule, ignored: the server works the price out (pricing.mjs).
        priceUGX: z.coerce.number().int().min(0).max(10_000_000).default(0),
        ppv: ppvSchedule.nullable().optional(),
    }),
    // "archived" is the Studio's word; "unpublished" is accepted as the same.
    publishStatus: z.enum(['draft', 'scheduled', 'published', 'archived', 'unpublished']).transform((v) => (v === 'unpublished' ? 'archived' : v)),
    releaseAt: isoDate.nullable(),
    featured: z.boolean(),
};

/** POST streaming/titles. A series (`format: "series"`) starts with one empty season. */
export const createTitleBody = z.object({
    ...titleFields,
    format: z.enum(['film', 'series']).default('film'),
    type: titleFields.type.optional(),
}).partial().required({ title: true });

/** PATCH streaming/titles/:id. The video, trailer, views and format aren't set here. */
export const updateTitleBody = z.object(titleFields).partial();

/** PATCH streaming/titles/:id/trailer */
export const trailerBody = z.object({ autoplay: z.boolean() });

/* Seasons and episodes */

/** PATCH streaming/titles/:id/seasons/:number */
export const seasonBody = z.object({ title: text(60) });

const seconds = z.number().min(0).max(24 * 3600);
const episodeFields = {
    number: z.coerce.number().int().min(1, 'Episodes start at 1.').max(999),
    title: text(100).pipe(z.string().min(1, 'Give the episode a title.')),
    synopsis: text(300),
    still: imageField('The still'),
    intro: z.object({ start: seconds, end: seconds }).refine((v) => v.end > v.start, { path: ['end'], message: 'The intro must end after it starts.' }).nullable(),
    releaseAt: isoDate.nullable(),
};

/** POST streaming/titles/:id/seasons/:number/episodes */
export const createEpisodeBody = z.object({
    ...episodeFields,
    synopsis: episodeFields.synopsis.default(''),
    still: episodeFields.still.default(''),
    intro: episodeFields.intro.default(null),
    releaseAt: episodeFields.releaseAt.default(null),
});

/** PATCH streaming/titles/:id/episodes/:episodeId */
export const updateEpisodeBody = z.object(episodeFields).partial();

/* Plans */

const planFields = {
    name: text(40).pipe(z.string().min(1, 'Give the plan a name.')),
    priceUGX: z.coerce.number().int().min(500, 'A plan costs at least UGX 500.').max(10_000_000),
    // A billing period's id (streaming/billing-periods); the service checks it exists.
    interval: key,
    benefits: z.array(text(120).pipe(z.string().min(1))).max(10, 'Up to 10 benefits.'),
    active: z.boolean(),
    highlight: z.boolean(),
};

/** POST streaming/plans */
export const createPlanBody = z.object({ ...planFields, benefits: planFields.benefits.default([]), active: planFields.active.default(true), highlight: planFields.highlight.default(false) });

/** PATCH streaming/plans/:id */
export const updatePlanBody = z.object(planFields).partial();

/* Billing periods: Weekly, Monthly… a plan's interval is one of these ids. */

const periodFields = {
    name: text(40).pipe(z.string().min(1, 'Give the period a name.')),
    days: z.coerce.number().int().min(1, '1 to 366 days.').max(366, '1 to 366 days.'),
    active: z.boolean(),
};

/** POST streaming/billing-periods */
export const createPeriodBody = z.object({ ...periodFields, active: periodFields.active.default(true) });

/** PATCH streaming/billing-periods/:id */
export const updatePeriodBody = z.object(periodFields).partial();

/* Settings documents: each section may be sent on its own and is merged into what's saved. */

/** PATCH streaming/ads */
export const adsBody = z.object({
    general: z.object({
        enabled: z.boolean(),
        frequencyCapPerHour: z.coerce.number().int().min(0).max(60),
    }).partial(),
    web: z.object({
        adTagUrl: httpsOrEmpty('The ad tag'),
        preroll: z.boolean(),
        midrollEveryMinutes: z.coerce.number().int().min(0).max(240),
        skippableAfterSeconds: z.coerce.number().int().min(0).max(60),
    }).partial(),
    app: z.object({
        admobAppIdAndroid: text(100),
        admobAppIdIos: text(100),
        videoUnitAndroid: text(100),
        videoUnitIos: text(100),
    }).partial(),
}).partial();

const ROW_SOURCE = /^(trending|continue|new|tier:(free|subscription|ppv)|type:[a-z0-9_-]+|category:[a-z0-9_-]+)$/i;

/** PATCH stream/site. `rows` is the whole list, in order. */
export const streamSiteBody = z.object({
    community: z.object({
        enabled: z.boolean(),
        heading: text(80),
        body: text(300),
        channelUrl: httpsOrEmpty('The channel link'),
        groupUrl: httpsOrEmpty('The group link'),
    }).partial(),
    hero: z.object({
        featuredIds: z.array(key).max(10, 'Up to 10 titles in the hero.'),
        autoplayTrailers: z.boolean(),
    }).partial(),
    rows: z.array(z.object({
        id: key,
        label: text(40).pipe(z.string().min(1, 'Give the row a name.')),
        source: z.string().regex(ROW_SOURCE, 'Choose what the row lists.'),
        enabled: z.boolean(),
    })).max(30),
    announcement: z.object({
        enabled: z.boolean(),
        text: text(200),
        linkLabel: text(30),
        linkUrl: linkOrEmpty('The link'),
    }).partial(),
}).partial();

/** GET streaming/titles?published=true&q= */
export const titlesQuery = z.object({ q: text(100).optional() });

/* Uploads (the Studio, straight to Spaces) and playback */

const GB = 1024 ** 3;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'application/octet-stream', ''];

/** POST streaming/uploads: where the file goes (a film, an episode, or a title's trailer) and what it is. */
export const startUploadBody = z
    .object({
        titleId: key,
        episodeId: key.nullish(),
        kind: z.enum(['video', 'trailer']).default('video'),
        fileName: z.string().trim().min(1).max(255).refine((v) => /\.(mp4|mov|webm|mkv)$/i.test(v), 'Use an MP4, MOV, WebM or MKV file.'),
        size: z.number().int().min(1, 'That file is empty.').max(20 * GB, 'That file is over the 20 GB limit.'),
        contentType: z.string().trim().max(100).default('video/mp4').refine((v) => VIDEO_TYPES.includes(v), 'Use an MP4, MOV, WebM or MKV file.'),
    })
    .transform(({ contentType, ...rest }) => ({ ...rest, contentType: contentType && contentType !== 'application/octet-stream' ? contentType : 'video/mp4' }));

export const uploadParam = z.object({ assetId: z.string().regex(/^ast_[a-f0-9]{16}$/, 'Upload not found.') });

/** POST streaming/uploads/:assetId/parts: up to 20 part links at a time. */
export const signPartsBody = z.object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(20) });

/** POST streaming/uploads/:assetId/abort: cancelled (the default), or failed with what the browser saw. */
export const abortUploadBody = z.object({ failed: z.boolean().default(false), error: z.string().trim().max(200).optional() });

/** POST streaming/playback (and the Studio's preview): a film, or one episode of a series. */
export const playbackBody = z.object({ titleId: key, episodeId: key.nullish() });

export const playParam = z.object({ token: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'This playback link has expired. Press play again.') });
export const playRenditionParam = playParam.extend({ rendition: z.string().regex(/^\d{3,4}p$/, 'We could not find that.') });

/* Library and comments (members) */

export const libraryTitleParam = z.object({ titleId: key });

/** PUT library/ratings/:titleId */
export const ratingBody = z.object({ rating: z.enum(['meh', 'like', 'love'], { error: 'Choose Not for me, I like this or Love this.' }) });

const playerSeconds = z.number().min(0).max(48 * 3600);
/** PUT library/progress: where the player is. */
export const progressBody = z.object({ titleId: key, episodeId: key.nullish(), seconds: playerSeconds, duration: playerSeconds });

export const commentParam = z.object({ id: key, cid: objectId });

/** POST streaming/titles/:id/comments. Plain text; blank lines squeezed. */
export const commentBody = z.object({
    body: text(500).transform((v) => v.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')).pipe(z.string().min(1, 'Write something first.')),
    spoiler: z.boolean().default(false),
});

export const studioCommentsQuery = z.object({ status: z.enum(['reported', 'hidden', 'all']).default('reported') });
export const studioCommentParam = z.object({ cid: objectId });
export const hideCommentBody = z.object({ hidden: z.boolean() });

/* Captions */

// A language code: en, lg (Luganda), sw, fr, pt-BR…
const lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'We could not find that.');
export const captionsParam = z.object({ id: key, lang });
export const episodeCaptionsParam = z.object({ id: key, episodeId: key, lang });

/** PUT …/captions/:lang: the file's text (.vtt or .srt) and the name viewers pick it by. */
export const captionsBody = z.object({
    label: text(40).pipe(z.string().min(1, 'Name the language, e.g. English.')),
    text: z.string().min(1, 'That file is empty.').max(1_500_000, 'That captions file is too large (1.5 MB at most).'),
});
