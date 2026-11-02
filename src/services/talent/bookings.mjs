import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { withNextNumber } from '../system/counters.mjs';
import { bookableIds } from './talent.mjs';

/**
 * Talent booking requests. A guest sends one from the public shortlist (no
 * sign-in; rate limited per IP in utils/rateLimits.js); the Studio works
 * through them. The history (`activity`) is written here only, with the
 * staff member's name from their session, never from the page.
 */

const STATUS_LABEL = { new: 'New', contacted: 'Contacted', confirmed: 'Confirmed', declined: 'Declined' };
const notFound = () => new AppError('Booking not found.', 404);

const toBooking = (b) => ({
    id: b.id,
    reference: b.reference,
    talentIds: b.talentIds,
    name: b.name,
    email: b.email,
    phone: b.phone,
    organisation: b.organisation,
    projectType: b.projectType,
    dates: b.dates,
    message: b.message,
    status: b.status,
    talentOutcomes: b.talentOutcomes ?? {},
    activity: Array.isArray(b.activity) ? b.activity : [],
    createdAt: b.createdAt.toISOString(),
});

const changed = (id) => invalidate('admin', ['admin', 'bookings'], { id });

const highestReference = async () => {
    const top = await prisma.booking.findFirst({ orderBy: { reference: 'desc' }, select: { reference: true } });
    return Math.max(1000, Number(top?.reference.slice(3)) || 0);
};

/* Public */

/**
 * A guest's request for one or more published talents. What comes back is
 * enough for their confirmation, nothing private.
 */
export const requestBooking = async ({ talentIds, ...request }) => {
    const bookable = await bookableIds([...new Set(talentIds)]);
    const kept = [...new Set(talentIds)].filter((id) => bookable.includes(id));
    if (!kept.length) throw new AppError('Choose at least one talent.', 422, { details: { fieldErrors: { talentIds: ['Choose at least one talent.'] } } });
    const createdAt = new Date();
    const row = await withNextNumber('booking', highestReference, (n) => prisma.booking.create({
        data: {
            ...request,
            talentIds: kept,
            reference: `BK-${n}`,
            activity: [{ at: createdAt.toISOString(), kind: 'received', text: 'Request received from the website' }],
            createdAt,
        },
    }));
    changed(row.id);
    return { id: row.id, reference: row.reference, status: 'received', talentIds: kept, name: row.name, email: row.email, phone: row.phone };
};

/* Studio */

export const listBookings = async () => (await prisma.booking.findMany({ orderBy: { createdAt: 'desc' }, take: 2000 })).map(toBooking);

/**
 * Change a request and add to its history, from what it was. Two staff at
 * once: the second write sees the first (it retries on a changed row), so
 * no history line is lost.
 */
const edit = async (id, change) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await prisma.booking.findUnique({ where: { id } });
        if (!current) throw notFound();
        const row = toBooking(current);
        const data = change(row);
        if (!data) return row;
        const { count } = await prisma.booking.updateMany({ where: { id, updatedAt: current.updatedAt }, data });
        if (count) return toBooking(await prisma.booking.findUnique({ where: { id } }));
    }
    throw new AppError('Someone else is editing this request. Try again.', 409);
};

/** Status, per-talent outcomes and a reply (`via`), each written into the history. */
export const updateBooking = async (id, { status, talentOutcomes, via }, by) => {
    const row = await edit(id, (b) => {
        const at = new Date().toISOString();
        const log = [...b.activity];
        if (via) log.push({ at, kind: 'reply', text: `Replied by ${via}`, by });
        if (status && status !== b.status) log.push({ at, kind: 'status', text: `${STATUS_LABEL[b.status]} → ${STATUS_LABEL[status]}`, by });
        for (const [talentId, outcome] of Object.entries(talentOutcomes ?? {})) {
            if ((b.talentOutcomes[talentId] ?? 'pending') !== outcome) log.push({ at, kind: 'talent', text: `${talentId} ${outcome}`, by });
        }
        if (log.length === b.activity.length && !status) return null;
        return { status: status ?? b.status, talentOutcomes: { ...b.talentOutcomes, ...talentOutcomes }, activity: log };
    });
    changed(id);
    return row;
};

export const addBookingNote = async (id, text, by) => {
    const row = await edit(id, (b) => ({ activity: [...b.activity, { at: new Date().toISOString(), kind: 'note', text, by }] }));
    changed(id);
    return row;
};

/** One status for several requests; each that changes gets its history line. */
export const setBookingsStatus = async (ids, status, by) => {
    const rows = [];
    for (const id of ids) rows.push(await updateBooking(id, { status }, by).catch((e) => (e.statusCode === 404 ? null : Promise.reject(e))));
    return rows.filter(Boolean);
};

export const deleteBookings = async (ids) => {
    const { count } = await prisma.booking.deleteMany({ where: { id: { in: ids } } });
    if (count) changed();
};
