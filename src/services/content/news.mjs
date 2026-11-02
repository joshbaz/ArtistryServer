import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * News & Events. The Studio edits every article; the home page's News &
 * Events strip and /events/:id show the published ones, newest first.
 * Drafts never leave the Studio.
 */

const notFound = () => new AppError('Article not found.', 404);
const endsBeforeStart = () => new AppError('An event must end on or after the day it starts.', 422, { details: { fieldErrors: { endDate: ['Pick a day on or after the start.'] } } });

/** As the Studio reads it. */
const toArticle = (a) => ({
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    content: a.content,
    location: a.location,
    category: a.category,
    date: a.date,
    endDate: a.endDate,
    image: a.image,
    status: a.status,
});

/** As the site reads it. */
const toEvent = (a) => ({
    id: a.id,
    title: a.title,
    description: a.excerpt,
    content: a.content || a.excerpt,
    location: a.location,
    category: a.category,
    date: a.date,
    endDate: a.endDate,
    image: a.image,
});

const changed = (id) => {
    invalidate('admin', ['admin', 'news'], { id });
    invalidateSite('events', { id });
};

const checkDates = ({ date, endDate }) => {
    if (endDate && date && endDate < date) throw endsBeforeStart();
};

/* Studio */

export const listArticles = async () => (await prisma.article.findMany({ orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] })).map(toArticle);

export const createArticle = async (data) => {
    checkDates(data);
    const row = await prisma.article.create({ data });
    changed(row.id);
    return toArticle(row);
};

export const updateArticle = async (id, patch) => {
    const current = await prisma.article.findUnique({ where: { id } });
    if (!current) throw notFound();
    checkDates({ ...current, ...patch });
    const row = await prisma.article.update({ where: { id }, data: patch });
    changed(id);
    return toArticle(row);
};

export const deleteArticle = async (id) => {
    const { count } = await prisma.article.deleteMany({ where: { id } });
    if (count) changed(id);
};

/* Public */

export const listEvents = async () =>
    (await prisma.article.findMany({ where: { status: 'Published' }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 })).map(toEvent);

/** One published article; a draft or a deleted one is a 404. */
export const getEvent = async (id) => {
    const row = await prisma.article.findFirst({ where: { id, status: 'Published' } });
    if (!row) throw notFound();
    return toEvent(row);
};
