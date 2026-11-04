/**
 * Moves streaming pictures kept inside titles (image data from before they
 * went to Spaces) into the Spaces bucket, leaving each title with its CDN
 * link: posters, backdrops and episode stills. Safe to run again: a link is
 * left as it is.
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
    console.log(`Moved ${moved} picture${moved === 1 ? '' : 's'} to Spaces.`);
} finally {
    await prisma.$disconnect();
}
