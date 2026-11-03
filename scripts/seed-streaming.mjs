/**
 * Load the client's demo streaming catalogue into the database: the same
 * video types, categories, content warnings, titles (films and a series),
 * plans, stream site home page and ad settings Studio › Streaming shows on
 * mocks. Development only.
 *
 *   yarn seed:streaming            only if there are no titles yet
 *   yarn seed:streaming --reset    delete all of it first
 *
 * Titles and plans keep their ids (ttl_001, plan_monthly), so stream site
 * links still work. The demo titles' "ready" videos aren't at any video
 * provider, so they show in the catalogue but won't play once playback is
 * real; upload a file to a title to try that.
 */
import { parseArgs } from 'node:util';
import prisma from '../src/utils/db.mjs';
import { streamingTypesSeed } from '../../client/src/data/streamingTypes.js';
import { streamingCategoriesSeed } from '../../client/src/data/streamingCategories.js';
import { streamingAdvisoriesSeed } from '../../client/src/data/streamingAdvisories.js';
import { streamingTitlesSeed } from '../../client/src/data/streamingTitles.js';
import { streamingPlansSeed } from '../../client/src/data/streamingPlans.js';
import { streamSiteSeed } from '../../client/src/data/streamSite.js';
import { adSettingsSeed } from '../../client/src/data/adSettings.js';

const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
}

// Playback links come from the video provider, never from stored data.
const withoutLink = ({ playbackUrl, ...rest }) => rest;

const toTitle = (t) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    format: t.format ?? 'film',
    synopsis: t.synopsis ?? '',
    description: t.description ?? '',
    categoryIds: t.categoryIds ?? [],
    language: t.language ?? 'English',
    ageRating: t.ageRating ?? 'PG',
    advisories: t.advisories ?? [],
    releaseYear: t.releaseYear,
    cast: t.cast ?? [],
    crew: t.crew ?? [],
    poster: t.poster ?? '',
    backdrop: t.backdrop ?? '',
    video: t.video ?? { status: 'none' },
    trailer: t.trailer ?? undefined,
    captions: t.captions ?? [],
    seasons: t.seasons?.map((s) => ({ ...s, episodes: s.episodes.map(withoutLink) })),
    accessTier: t.access?.tier ?? 'subscription',
    priceUGX: t.access?.priceUGX ?? 0,
    publishStatus: t.publishStatus === 'unpublished' ? 'archived' : t.publishStatus,
    releaseAt: t.releaseAt ? new Date(t.releaseAt) : null,
    featured: Boolean(t.featured),
    views: t.views ?? 0,
});

try {
    if (values.reset) {
        await prisma.$transaction([
            prisma.streamTitle.deleteMany(),
            prisma.streamTerm.deleteMany(),
            prisma.streamPlan.deleteMany(),
            prisma.settingsDoc.deleteMany({ where: { id: { in: ['stream-site', 'stream-ads'] } } }),
            prisma.counter.deleteMany({ where: { id: 'streamTitle' } }),
        ]);
        console.log('Cleared streaming.');
    } else if (await prisma.streamTitle.count()) {
        console.log('There are titles already; nothing done. Use --reset to start over.');
        process.exit(0);
    }

    const terms = [
        ...streamingTypesSeed.map((t) => ['type', t]),
        ...streamingCategoriesSeed.map((t) => ['category', t]),
        ...streamingAdvisoriesSeed.map((t) => ['advisory', t]),
    ];
    for (const [kind, t] of terms) {
        await prisma.streamTerm.upsert({
            where: { kind_key: { kind, key: t.id } },
            create: { kind, key: t.id, name: t.name, nameKey: t.name.toLowerCase(), slug: t.slug },
            update: {},
        });
    }

    for (const t of streamingTitlesSeed) await prisma.streamTitle.create({ data: toTitle(t) });

    for (const [position, p] of streamingPlansSeed.entries()) {
        const { id, ...plan } = p;
        await prisma.streamPlan.upsert({ where: { id }, create: { id, ...plan, position }, update: {} });
    }

    await prisma.settingsDoc.upsert({ where: { id: 'stream-site' }, create: { id: 'stream-site', data: streamSiteSeed }, update: {} });
    await prisma.settingsDoc.upsert({ where: { id: 'stream-ads' }, create: { id: 'stream-ads', data: adSettingsSeed }, update: {} });

    console.log(`Seeded ${terms.length} types, categories and warnings, ${streamingTitlesSeed.length} titles, ${streamingPlansSeed.length} plans, the stream site and ad settings.`);
} finally {
    await prisma.$disconnect();
}
