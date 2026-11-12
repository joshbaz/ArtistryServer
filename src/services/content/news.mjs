import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { dropFiles, storeImages } from '../streaming/media.mjs';

/**
 * News & Events. The Studio edits every article; the home page's News &
 * Events strip and /events/:id show the published ones, newest first.
 * Drafts never leave the Studio.
 *
 * An Event can point at the ticket sold for it (`ticketEventId`, one article
 * per ticket) and carry an https link to pay for it outside the ticket
 * system (`paymentUrl`); any other category keeps both null. The public
 * pages see the ticket only while it isn't a Draft. An uploaded image goes
 * to Spaces and the article keeps its CDN link (as tickets and titles do).
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
    ticketEventId: a.ticketEventId ?? null,
    paymentUrl: a.paymentUrl ?? null,
});

/** As the site reads it. `shown`: the ticket ids that exist and aren't drafts. */
const toEvent = (a, shown) => ({
    id: a.id,
    title: a.title,
    description: a.excerpt,
    content: a.content || a.excerpt,
    location: a.location,
    category: a.category,
    date: a.date,
    endDate: a.endDate,
    image: a.image,
    ticketEventId: a.ticketEventId && shown.has(a.ticketEventId) ? a.ticketEventId : null,
    paymentUrl: a.paymentUrl ?? null,
});

/** Of these articles' tickets, the ones the public may see. */
const publicTickets = async (rows) => {
    const ids = [...new Set(rows.map((a) => a.ticketEventId).filter(Boolean))];
    if (!ids.length) return new Set();
    const found = await prisma.ticketEvent.findMany({ where: { id: { in: ids }, status: { not: 'Draft' } }, select: { id: true } });
    return new Set(found.map((t) => t.id));
};

const changed = (id) => {
    invalidate('admin', ['admin', 'news'], { id });
    invalidateSite('events', { id });
};

const checkDates = ({ date, endDate }) => {
    if (endDate && date && endDate < date) throw endsBeforeStart();
};

const fieldError = (field, message, status = 422, code) => new AppError(message, status, { ...(code ? { code } : {}), details: { fieldErrors: { [field]: [message] } } });

/**
 * The event-only fields as they'll be stored: null for anything but an
 * Event. A ticket being linked must exist and not belong to another
 * article; a stored link to a ticket deleted since is dropped quietly, so
 * the post can still be edited.
 * @param {object} data - what's being saved (merged with the stored article on an update)
 * @param {string} [id] - the article being updated
 * @param {boolean} [linking] - the ticket is being set now (not just kept)
 */
const checkEventLinks = async (data, id, linking = true) => {
    if (data.category !== 'Event') return { ticketEventId: null, paymentUrl: null };
    let ticketEventId = data.ticketEventId ?? null;
    if (ticketEventId && !linking && !(await prisma.ticketEvent.findUnique({ where: { id: ticketEventId }, select: { id: true } }))) ticketEventId = null;
    if (ticketEventId) {
        const [ticket, other] = await Promise.all([
            prisma.ticketEvent.findUnique({ where: { id: ticketEventId }, select: { id: true } }),
            prisma.article.findFirst({ where: { ticketEventId, ...(id ? { id: { not: id } } : {}) }, select: { title: true } }),
        ]);
        if (!ticket) throw fieldError('ticketEventId', 'We could not find that ticket.');
        if (other) throw fieldError('ticketEventId', `That ticket is already linked to "${other.title}". Remove it there first.`, 409, 'ticket_linked');
    }
    return { ticketEventId, paymentUrl: data.paymentUrl ?? null };
};

/* Studio */

export const listArticles = async () => (await prisma.article.findMany({ orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] })).map(toArticle);

export const createArticle = async (data) => {
    checkDates(data);
    Object.assign(data, await checkEventLinks(data));
    await storeImages(data, ['image']);
    const row = await prisma.article.create({ data });
    changed(row.id);
    return toArticle(row);
};

export const updateArticle = async (id, patch) => {
    const current = await prisma.article.findUnique({ where: { id } });
    if (!current) throw notFound();
    checkDates({ ...current, ...patch });
    const links = await checkEventLinks({ ...current, ...patch }, id, 'ticketEventId' in patch);
    const data = { ...patch, ...links };
    await storeImages(data, ['image']);
    const row = await prisma.article.update({ where: { id }, data });
    if (current.image !== row.image) dropFiles([current.image]);
    changed(id);
    return toArticle(row);
};

export const deleteArticle = async (id) => {
    const current = await prisma.article.findUnique({ where: { id }, select: { image: true } });
    const { count } = await prisma.article.deleteMany({ where: { id } });
    if (!count) return;
    dropFiles([current?.image]);
    changed(id);
};

/* Public */

export const listEvents = async () => {
    const rows = await prisma.article.findMany({ where: { status: 'Published' }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 });
    const shown = await publicTickets(rows);
    return rows.map((a) => toEvent(a, shown));
};

/** One published article; a draft or a deleted one is a 404. */
export const getEvent = async (id) => {
    const row = await prisma.article.findFirst({ where: { id, status: 'Published' } });
    if (!row) throw notFound();
    return toEvent(row, await publicTickets([row]));
};
