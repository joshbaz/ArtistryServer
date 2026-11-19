/**
 * Moves pictures kept inside the database (image data from before they
 * went to Spaces) into the Spaces bucket, leaving each with its CDN link:
 * streaming posters, backdrops and episode stills, News & Events images,
 * ticket posters, campaign covers and logos, contestant photos, organiser
 * logos, talent photos and project images, gallery photos and class photos.
 * Safe to run again: a link is left as it is. Only picture fields are
 * written (never votes or anything else), and only on a row nobody saved
 * while it ran: a busy one is skipped, to be moved on the next run.
 *
 *   yarn images:move
 */
import prisma from '../src/utils/db.mjs';
import { isConfigured } from '../src/services/storage/spaces.mjs';
import { dropFiles, storeImage } from '../src/services/streaming/media.mjs';

if (!isConfigured()) {
    console.error('Set SPACES_* in .env first: there is nowhere to move the pictures to.');
    process.exit(1);
}

const isData = (v) => typeof v === 'string' && v.startsWith('data:image/');
let moved = 0;
let skipped = 0;
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
    // Plain picture fields; only if nobody saved the row meanwhile.
    const plain = [
        [prisma.article, 'news', ['image']],
        [prisma.ticketEvent, 'ticket', ['image']],
        [prisma.campaign, 'campaign', ['image', 'logo']],
        [prisma.contestant, 'contestant', ['photo']],
        [prisma.organizer, 'organiser', ['logo']],
        [prisma.galleryPhoto, 'gallery', ['image']],
        [prisma.classYear, 'class photo', ['image']],
    ];
    for (const [model, label, fields] of plain) {
        const select = Object.fromEntries(['id', 'updatedAt', ...fields].map((f) => [f, true]));
        for (const row of await model.findMany({ select })) {
            const data = {};
            for (const field of fields) if (isData(row[field])) data[field] = await storeImage(row[field]);
            if (!Object.keys(data).length) continue;
            const { count } = await model.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data });
            if (count) moved += Object.keys(data).length;
            else {
                dropFiles(Object.values(data));
                skipped += 1;
                console.log(`The ${label} ${row.id} was saved meanwhile: run again to move its picture.`);
            }
        }
    }

    // Talent: two photos and an image per project.
    for (const t of await prisma.talent.findMany({ select: { id: true, updatedAt: true, profileImg: true, headerImage: true, projects: true } })) {
        const uploaded = [];
        const store = async (value) => {
            const url = await storeImage(value);
            uploaded.push(url);
            return url;
        };
        const data = {};
        for (const field of ['profileImg', 'headerImage']) if (isData(t[field])) data[field] = await store(t[field]);
        const projects = Array.isArray(t.projects) ? t.projects : [];
        if (projects.some((p) => isData(p?.image))) {
            data.projects = [];
            for (const p of projects) data.projects.push(isData(p?.image) ? { ...p, image: await store(p.image) } : p);
        }
        if (!uploaded.length) continue;
        const { count } = await prisma.talent.updateMany({ where: { id: t.id, updatedAt: t.updatedAt }, data });
        if (count) moved += uploaded.length;
        else {
            // Only the files just made: the talent's existing links stay in use.
            dropFiles(uploaded);
            skipped += 1;
            console.log(`The talent ${t.id} was saved meanwhile: run again to move their pictures.`);
        }
    }
    console.log(`Moved ${moved} picture${moved === 1 ? '' : 's'} to Spaces.${skipped ? ` ${skipped} skipped: run again.` : ''}`);
} finally {
    await prisma.$disconnect();
}
