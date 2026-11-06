import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * Class year photos (Studio › Website › Class Photos): one photo per class.
 * The Classes page shows the Visible ones, oldest first.
 */

const notFound = () => new AppError('Class photo not found.', 404);
const yearTaken = () => new AppError('That year already has a photo.', 409, { details: { fieldErrors: { year: ['That year already has a photo.'] } } });

const toItem = (c) => ({ id: c.id, year: c.year, linkText: c.linkText, image: c.image, status: c.status });
const byYear = (a, b) => a.year.localeCompare(b.year, undefined, { numeric: true });

const changed = (id) => {
    invalidate('admin', ['admin', 'class-years'], { id });
    invalidateSite('class-years', { id });
};

const saving = async (write) => {
    try {
        return await write();
    } catch (error) {
        if (error.code === 'P2002') throw yearTaken();
        throw error;
    }
};

/* Public */

export const listVisible = async () =>
    (await prisma.classYear.findMany({ where: { status: 'Visible' } })).sort(byYear).map(({ id, year, linkText, image }) => ({ id, year, linkText, image }));

/* Studio: newest first */

export const listAll = async () => (await prisma.classYear.findMany()).sort(byYear).reverse().map(toItem);

export const create = async (data) => {
    const row = await saving(() => prisma.classYear.create({ data }));
    changed(row.id);
    return toItem(row);
};

export const update = async (id, patch) => {
    if (!(await prisma.classYear.count({ where: { id } }))) throw notFound();
    const row = await saving(() => prisma.classYear.update({ where: { id }, data: patch }));
    changed(id);
    return toItem(row);
};

export const remove = async (id) => {
    const { count } = await prisma.classYear.deleteMany({ where: { id } });
    if (count) changed(id);
};
