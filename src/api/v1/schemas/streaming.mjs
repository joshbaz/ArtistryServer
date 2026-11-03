import { z } from 'zod';
import { imageField, text } from './common.mjs';

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
        priceUGX: z.coerce.number().int().min(0).max(10_000_000).default(0),
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
    interval: z.enum(['month', 'quarter', 'year'], { error: 'Choose how often it renews.' }),
    benefits: z.array(text(120).pipe(z.string().min(1))).max(10, 'Up to 10 benefits.'),
    active: z.boolean(),
    highlight: z.boolean(),
};

/** POST streaming/plans */
export const createPlanBody = z.object({ ...planFields, benefits: planFields.benefits.default([]), active: planFields.active.default(true), highlight: planFields.highlight.default(false) });

/** PATCH streaming/plans/:id */
export const updatePlanBody = z.object(planFields).partial();

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
