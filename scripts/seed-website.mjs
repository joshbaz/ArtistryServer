/**
 * Load the client's demo website content into the database: the same
 * talent, monologues, booking requests, news, gallery photos and live
 * classes Studio › Website shows on mocks. Development only.
 *
 *   yarn seed:website            only if there is no talent yet
 *   yarn seed:website --reset    delete all of it first (option lists too)
 *
 * Talent keep their references and slugs (T-001, t-001), so profile links
 * still work; everything else gets a MongoDB id.
 */
import { parseArgs } from 'node:util';
import prisma from '../src/utils/db.mjs';
import { talentSeed } from '../../client/src/data/talent.js';
import { monologuesSeed } from '../../client/src/data/monologues.js';
import { bookingsSeed } from '../../client/src/data/bookings.js';
import { newsEventsData } from '../../client/src/data/studioNews.js';
import { galleryItems } from '../../client/src/data/studioGallery.js';
import { liveClassesSeed } from '../../client/src/data/liveClasses.js';

const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
}

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row[k] !== undefined && row[k] !== null).map((k) => [k, row[k]]));

const TALENT_KEYS = ['talentId', 'firstName', 'lastName', 'primaryRole', 'otherRoles', 'skills', 'experience', 'base', 'languages', 'availability', 'published', 'phone', 'email', 'shortBio', 'profileImg', 'headerImage', 'projects'];
const BOOKING_KEYS = ['reference', 'talentIds', 'name', 'email', 'phone', 'organisation', 'projectType', 'dates', 'message', 'status', 'talentOutcomes', 'activity'];
const ARTICLE_KEYS = ['title', 'excerpt', 'content', 'location', 'category', 'date', 'endDate', 'image', 'status'];
const LIVE_KEYS = ['title', 'instructor', 'durationMinutes', 'tier', 'priceUGX', 'description', 'status', 'recordReplay'];

try {
    if (values.reset) {
        await prisma.$transaction([
            prisma.monologue.deleteMany(),
            prisma.talent.deleteMany(),
            prisma.booking.deleteMany(),
            prisma.article.deleteMany(),
            prisma.galleryPhoto.deleteMany(),
            prisma.liveClass.deleteMany(),
            prisma.optionLists.deleteMany(),
            prisma.counter.deleteMany({ where: { id: { in: ['talent', 'booking'] } } }),
        ]);
    } else if (await prisma.talent.count()) {
        console.info('Talent already exists; nothing seeded. Use --reset to start over.');
        process.exit(0);
    }

    await prisma.talent.createMany({ data: talentSeed.map((t) => ({ ...pick(t, TALENT_KEYS), slug: t.id })) });
    await prisma.monologue.createMany({ data: monologuesSeed.map((m) => ({ ...pick(m, ['talentId', 'title', 'source', 'url', 'duration']), createdAt: new Date(m.createdAt) })) });
    await prisma.booking.createMany({ data: bookingsSeed.map((b) => ({ ...pick(b, BOOKING_KEYS), createdAt: new Date(b.createdAt) })) });
    // Oldest first, so "newest first" keeps the seed's order.
    for (const a of [...newsEventsData].reverse()) await prisma.article.create({ data: pick(a, ARTICLE_KEYS) });
    for (const g of [...galleryItems].reverse()) await prisma.galleryPhoto.create({ data: pick(g, ['title', 'category', 'image', 'status']) });
    await prisma.liveClass.createMany({ data: liveClassesSeed.map((c) => ({ ...pick(c, LIVE_KEYS), startsAt: new Date(c.startsAt) })) });

    console.info(`Seeded ${talentSeed.length} talent, ${monologuesSeed.length} monologues, ${bookingsSeed.length} booking requests, ${newsEventsData.length} articles, ${galleryItems.length} photos and ${liveClassesSeed.length} live classes.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
