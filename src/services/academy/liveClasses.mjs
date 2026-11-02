import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * Live classes (MOU 3D): the Studio schedules them and the public /classes
 * timetable shows the upcoming ones, soonest first. The stream itself, and
 * so each class's OBS server and key, comes from the video provider, which
 * isn't chosen yet (MOU 4.3).
 */

const notFound = () => new AppError('Live class not found.', 404);

const toLiveClass = (c) => ({
    id: c.id,
    title: c.title,
    instructor: c.instructor,
    startsAt: c.startsAt.toISOString(),
    durationMinutes: c.durationMinutes,
    tier: c.tier,
    priceUGX: c.priceUGX,
    description: c.description,
    status: c.status,
    recordReplay: c.recordReplay,
});

const changed = (id) => {
    invalidate('admin', ['admin', 'live-classes'], { id });
    invalidateSite('live-classes', { id });
};

// Only a pay-per-view class has a price of its own.
const priced = (data, tier) => (tier && tier !== 'ppv' ? { ...data, priceUGX: 0 } : data);

/* Studio */

export const listLiveClasses = async () => (await prisma.liveClass.findMany({ orderBy: { startsAt: 'asc' } })).map(toLiveClass);

export const createLiveClass = async (data) => {
    const row = await prisma.liveClass.create({ data: priced(data, data.tier) });
    changed(row.id);
    return toLiveClass(row);
};

export const updateLiveClass = async (id, patch) => {
    const current = await prisma.liveClass.findUnique({ where: { id } });
    if (!current) throw notFound();
    const row = await prisma.liveClass.update({ where: { id }, data: priced(patch, patch.tier ?? current.tier) });
    changed(id);
    return toLiveClass(row);
};

export const deleteLiveClass = async (id) => {
    const { count } = await prisma.liveClass.deleteMany({ where: { id } });
    if (count) changed(id);
};

/** The OBS server and key for a class: from the video provider, once there is one. */
export const getIngest = async (id) => {
    if (!(await prisma.liveClass.count({ where: { id } }))) throw notFound();
    throw new AppError("Streaming isn't set up yet: each class gets its OBS server and key once the video provider is connected.", 503, { code: 'video_provider_not_configured' });
};

/* Public: classes not yet over, soonest first. */
export const listUpcomingClasses = async () => {
    // The longest class can't run past a day; anything that started earlier is over.
    const rows = await prisma.liveClass.findMany({ where: { startsAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }, orderBy: { startsAt: 'asc' } });
    return rows.filter((c) => c.startsAt.getTime() + c.durationMinutes * 60_000 > Date.now()).map(toLiveClass);
};
