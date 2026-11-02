import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { getOptionLists } from '../system/options.mjs';

/**
 * The gallery: one list of photos. The Studio edits it; /gallery shows the
 * Visible ones, "Alumni" in the slider and the rest in the categorised grid.
 */

export const ALUMNI = 'Alumni';

const notFound = () => new AppError('Photo not found.', 404);

const toItem = (p) => ({ id: p.id, title: p.title, category: p.category, image: p.image, status: p.status });

const changed = (id) => {
    invalidate('admin', ['admin', 'gallery'], { id });
    invalidateSite('gallery', { id });
};

/* Studio */

export const listPhotos = async () => (await prisma.galleryPhoto.findMany({ orderBy: { createdAt: 'desc' } })).map(toItem);

export const createPhoto = async (data) => {
    const row = await prisma.galleryPhoto.create({ data });
    changed(row.id);
    return toItem(row);
};

export const updatePhoto = async (id, patch) => {
    if (!(await prisma.galleryPhoto.count({ where: { id } }))) throw notFound();
    const row = await prisma.galleryPhoto.update({ where: { id }, data: patch });
    changed(id);
    return toItem(row);
};

export const deletePhoto = async (id) => {
    const { count } = await prisma.galleryPhoto.deleteMany({ where: { id } });
    if (count) changed(id);
};

/* Public */

/** "All" first, then the grid's categories (in the Studio's order) that have photos. */
export const getGallery = async () => {
    const [visible, lists] = await Promise.all([
        prisma.galleryPhoto.findMany({ where: { status: 'Visible' }, orderBy: { createdAt: 'desc' } }),
        getOptionLists(),
    ]);
    const grid = visible.filter((p) => p.category !== ALUMNI);
    const used = new Set(grid.map((p) => p.category));
    return {
        alumniImages: visible.filter((p) => p.category === ALUMNI).map(({ id, title, image }) => ({ id, name: title, image })),
        talentImages: grid.map(({ id, title, category, image }) => ({ id, title, category, image })),
        categories: ['All', ...lists.galleryCategories.filter((c) => c !== ALUMNI && used.has(c)), ...[...used].filter((c) => !lists.galleryCategories.includes(c))],
    };
};
