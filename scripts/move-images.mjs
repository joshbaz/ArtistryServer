/**
 * Moves pictures kept inside the database (image data from before they
 * went to Spaces) into the Spaces bucket, leaving each with its CDN link:
 * streaming posters, backdrops and episode stills, News & Events images and
 * ticket posters. Safe to run again: a link is left as it is.
 *
 *   yarn images:move
 */
import prisma from '../src/utils/db.mjs';
import { isConfigured } from '../src/services/storage/spaces.mjs';
import { storeImage } from '../src/services/streaming/media.mjs';

if (!isConfigured()) {
    console.error('Set SPACES_* in .env first: there is nowhere to move the pictures to.');
    process.exit(1);
}

const isData = (v) => typeof v === 'string' && v.startsWith('data:image/');
let moved = 0;
try {
    for (const t of await prisma.streamTitle.findMany()) {
        const data = {};
        for (const field of ['poster', 'backdrop']) {
            if (isData(t[field])) {
                data[field] = await storeImage(t[field]);
                moved += 1;
            }
        }
        if (t.seasons?.some((s) => s.episodes.some((e) => isData(e.still)))) {
            data.seasons = structuredClone(t.seasons);
            for (const e of data.seasons.flatMap((s) => s.episodes)) {
                if (isData(e.still)) {
                    e.still = await storeImage(e.still);
                    moved += 1;
                }
            }
        }
        // Only if nobody saved the title meanwhile; run again to pick it up.
        if (Object.keys(data).length) await prisma.streamTitle.updateMany({ where: { id: t.id, updatedAt: t.updatedAt }, data });
    }
    // One image each; only if nobody saved it meanwhile.
    for (const [model, label] of [[prisma.article, 'news'], [prisma.ticketEvent, 'ticket']]) {
        for (const row of await model.findMany({ select: { id: true, image: true, updatedAt: true } })) {
            if (!isData(row.image)) continue;
            const image = await storeImage(row.image);
            const { count } = await model.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { image } });
            if (count) moved += 1;
            else console.log(`The ${label} image of ${row.id} was saved meanwhile: run again to move it.`);
        }
    }
    console.log(`Moved ${moved} picture${moved === 1 ? '' : 's'} to Spaces.`);
} finally {
    await prisma.$disconnect();
}
