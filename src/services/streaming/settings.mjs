import prisma from '../../utils/db.mjs';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * The two settings documents of Studio › Streaming: the stream site's home
 * page (GET stream/site, read by the stream site and the app) and the ad
 * settings. Saving one section merges into what's saved, so it never wipes
 * another; a list (the home page's rows) is replaced whole.
 */

const DOCS = {
    'stream-site': {
        defaults: {
            community: { enabled: false, heading: 'Join the Artistry360 community', body: 'Get new releases and behind-the-scenes first.', channelUrl: '', groupUrl: '' },
            hero: { featuredIds: [], autoplayTrailers: true },
            // Home page rows, top to bottom. `source` tells the stream site what to list.
            rows: [
                { id: 'trending', label: 'Most Watched', source: 'trending', enabled: true },
                { id: 'continue', label: 'Continue Watching', source: 'continue', enabled: true },
                { id: 'new', label: 'New Releases', source: 'new', enabled: true },
                { id: 'free', label: 'Free to Watch', source: 'tier:free', enabled: true },
            ],
            announcement: { enabled: false, text: '', linkLabel: '', linkUrl: '' },
        },
        changed: () => invalidateSite('stream-site'),
    },
    'stream-ads': {
        // Free-tier advertising (MOU 3D, 3E); the account IDs are filled in once opened.
        defaults: {
            general: { enabled: false, frequencyCapPerHour: 4 },
            web: { adTagUrl: '', preroll: true, midrollEveryMinutes: 15, skippableAfterSeconds: 5 },
            app: { admobAppIdAndroid: '', admobAppIdIos: '', videoUnitAndroid: '', videoUnitIos: '' },
        },
        // The Studio's form, and the players that read the public part (stream/ads).
        changed: () => {
            invalidate('admin', ['admin', 'ads']);
            invalidateSite('ads');
        },
    },
};

const isSection = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** `patch` over `base`, one level deep. */
const merge = (base, patch) => {
    const next = { ...base };
    for (const [k, v] of Object.entries(patch)) next[k] = isSection(v) && isSection(base[k]) ? { ...base[k], ...v } : v;
    return next;
};

export const getDoc = async (id) => {
    const row = await prisma.settingsDoc.findUnique({ where: { id } });
    // Over the defaults, so a section added since it was saved still comes back whole.
    return merge(DOCS[id].defaults, row?.data ?? {});
};

export const updateDoc = async (id, patch) => {
    const next = merge(await getDoc(id), patch);
    await prisma.settingsDoc.upsert({ where: { id }, create: { id, data: next }, update: { data: next } });
    DOCS[id].changed();
    return next;
};

/* Stream site */

export const getStreamSite = () => getDoc('stream-site');

/** The hero can only feature titles that exist. */
export const updateStreamSite = async (patch) => {
    if (patch.hero?.featuredIds) {
        const ids = [...new Set(patch.hero.featuredIds)];
        const found = new Set((await prisma.streamTitle.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id));
        patch = { ...patch, hero: { ...patch.hero, featuredIds: ids.filter((i) => found.has(i)) } };
    }
    return updateDoc('stream-site', patch);
};

/** A deleted title leaves the hero. */
export const dropFromHero = async (titleId) => {
    const site = await getStreamSite();
    if (site.hero.featuredIds.includes(titleId)) await updateDoc('stream-site', { hero: { featuredIds: site.hero.featuredIds.filter((i) => i !== titleId) } });
};

/* Ads */

export const getAds = () => getDoc('stream-ads');
export const updateAds = (patch) => updateDoc('stream-ads', patch);

/**
 * What the players need (GET stream/ads): whether free viewers see ads, how
 * often, the web's ad tag and the app's AdMob ids. None of it is secret (it
 * ships inside every page and app); the Studio's form stays behind sign-in.
 */
export const getPublicAds = async () => {
    const { general, web, app } = await getAds();
    return { enabled: Boolean(general.enabled), frequencyCapPerHour: general.frequencyCapPerHour, web, app };
};
