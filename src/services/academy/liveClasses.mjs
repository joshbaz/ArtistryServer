import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { activeProvider, notConfigured, videoProvider } from '../video/index.mjs';

/**
 * Live classes (MOU 3D): the Studio schedules them and the public /classes
 * timetable shows them. Each class gets its own stream at the video provider
 * (services/video) the first time the Studio opens its Streaming Setup; the
 * provider's webhook then marks it live and ended and hands over the
 * recording. Watching online is for free classes until memberships and class
 * payments exist.
 */

// "Watch again" stays on the timetable this long after a class.
const REPLAY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const notFound = () => new AppError('Live class not found.', 404);

/** What a viewer could watch now: the live stream, its recording, or nothing. */
const watchable = (c) => {
    if (c.status === 'cancelled') return null;
    if (c.status === 'live' && c.playbackId) return 'live';
    if (c.recordReplay && c.replayPlaybackId) return 'replay';
    return null;
};

/** As the site reads it: no stream ids. */
const toPublicClass = (c) => ({
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
    watch: watchable(c),
});

/** As the Studio reads it: also whether the stream is made and the recording is in. */
const toLiveClass = (c) => ({
    ...toPublicClass(c),
    streamReady: Boolean(c.liveStreamId),
    hasReplay: Boolean(c.replayPlaybackId),
    wentLiveAt: c.wentLiveAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
});

const changed = (id) => {
    invalidate('admin', ['admin', 'live-classes'], { id });
    invalidateSite('live-classes', { id });
};

// Only a pay-per-view class has a price of its own.
const priced = (data, tier) => (tier && tier !== 'ppv' ? { ...data, priceUGX: 0 } : data);

// Members-only and pay-per-view links expire, when the provider can sign them.
const wantsSigned = (tier, provider) => tier !== 'free' && provider.canSign();

/** Let go of a class's stream at the provider; a stream already gone there is fine. */
const releaseStream = async (c) => {
    if (!c.liveStreamId) return;
    await videoProvider(c.videoProvider)?.deleteLiveStream(c.liveStreamId).catch((error) => console.error(`Could not delete stream ${c.liveStreamId}:`, error.message));
};

/* Studio */

export const listLiveClasses = async () => (await prisma.liveClass.findMany({ orderBy: { startsAt: 'asc' } })).map(toLiveClass);

export const createLiveClass = async (data) => {
    const row = await prisma.liveClass.create({ data: priced(data, data.tier) });
    changed(row.id);
    return toLiveClass(row);
};

/**
 * A change to recording or to who may watch needs a stream made that way, so
 * the old one goes (while the class isn't live) and the next Streaming Setup
 * makes a new one, with a new key.
 */
export const updateLiveClass = async (id, patch) => {
    const current = await prisma.liveClass.findUnique({ where: { id } });
    if (!current) throw notFound();
    const next = { ...current, ...patch };
    const provider = current.liveStreamId ? videoProvider(current.videoProvider) : null;
    const remake = provider && current.status !== 'live' && (next.recordReplay !== current.recordReplay || wantsSigned(next.tier, provider) !== current.signedPlayback);
    if (remake) await releaseStream(current);
    const row = await prisma.liveClass.update({
        where: { id },
        data: { ...priced(patch, next.tier), ...(remake ? { liveStreamId: null, playbackId: null, videoProvider: null } : {}) },
    });
    changed(id);
    return toLiveClass(row);
};

export const deleteLiveClass = async (id) => {
    const current = await prisma.liveClass.findUnique({ where: { id } });
    if (!current) return;
    await releaseStream(current);
    await prisma.liveClass.delete({ where: { id } });
    changed(id);
};

/**
 * The OBS server and key for a class. Its stream is made the first time
 * (on the provider in use); the key is fetched from the provider each time
 * and never stored.
 */
export const getIngest = async (id) => {
    let c = await prisma.liveClass.findUnique({ where: { id } });
    if (!c) throw notFound();
    const { name, provider } = activeProvider();
    // Made on a provider we've since moved off: a fresh stream on the current one (its recording stays playable).
    const usable = c.liveStreamId && c.videoProvider === name;
    if (usable) {
        const ingest = await provider.getIngest(c.liveStreamId);
        if (ingest) return ingest;
        // Deleted at the provider (from its dashboard): make another.
    }
    const signed = wantsSigned(c.tier, provider);
    const stream = await provider.createLiveStream({ title: c.title, record: c.recordReplay, signed });
    // Two people opening Streaming Setup at once: the first stream saved wins, and the other is let go.
    const { count } = await prisma.liveClass.updateMany({
        // On MongoDB a `null` filter doesn't match a field never written, as on classes made before streams existed.
        where: { id, ...(c.liveStreamId ? { liveStreamId: c.liveStreamId } : { OR: [{ liveStreamId: null }, { liveStreamId: { isSet: false } }] }) },
        data: { videoProvider: name, liveStreamId: stream.liveStreamId, playbackId: stream.playbackId, signedPlayback: signed },
    });
    if (!count) {
        await provider.deleteLiveStream(stream.liveStreamId).catch(() => {});
        c = await prisma.liveClass.findUnique({ where: { id } });
        return provider.getIngest(c.liveStreamId);
    }
    changed(id);
    return provider.getIngest(stream.liveStreamId);
};

/**
 * The provider's webhook: a class's stream went live, went idle, or has its
 * recording. `rawBody` is checked against the provider's signature first.
 * @returns {Promise<void>}
 */
export const handleWebhook = async (providerName, rawBody, headers) => {
    const provider = videoProvider(providerName);
    if (!provider) throw new AppError('Unknown video provider.', 404);
    const event = provider.readWebhook(rawBody ?? Buffer.alloc(0), headers);
    if (!event) return;
    const where = { videoProvider: providerName, liveStreamId: event.liveStreamId };
    const now = new Date();
    let count = 0;
    if (event.type === 'live') {
        // A cancelled class stays cancelled, whatever OBS does.
        ({ count } = await prisma.liveClass.updateMany({ where: { ...where, status: { in: ['scheduled', 'ended'] } }, data: { status: 'live', wentLiveAt: now, endedAt: null } }));
    } else if (event.type === 'idle') {
        ({ count } = await prisma.liveClass.updateMany({ where: { ...where, status: 'live' }, data: { status: 'ended', endedAt: now } }));
    } else if (event.type === 'replay' && event.playbackId) {
        // Streamed in two sittings: the later recording is the one kept.
        ({ count } = await prisma.liveClass.updateMany({ where, data: { replayPlaybackId: event.playbackId } }));
    }
    if (count) {
        const row = await prisma.liveClass.findFirst({ where, select: { id: true } });
        changed(row?.id);
    }
};

/* Public */

/**
 * The timetable: classes not yet over and any live now, soonest first, then
 * recent ones with a recording to watch again, newest first.
 */
export const listPublicClasses = async () => {
    const now = Date.now();
    const rows = await prisma.liveClass.findMany({
        where: {
            OR: [
                // The longest class can't run past a day; anything that started earlier is over.
                { startsAt: { gt: new Date(now - DAY_MS) } },
                { status: 'live' },
                { replayPlaybackId: { not: null }, endedAt: { gt: new Date(now - REPLAY_DAYS * DAY_MS) } },
            ],
        },
        orderBy: { startsAt: 'asc' },
    });
    const ahead = (c) => c.status === 'live' || (c.status !== 'ended' && c.startsAt.getTime() + c.durationMinutes * 60_000 > now);
    const upcoming = rows.filter(ahead);
    const replays = rows.filter((c) => !ahead(c) && watchable(c) === 'replay').reverse();
    return { upcoming: upcoming.map(toPublicClass), replays: replays.map(toPublicClass) };
};

/**
 * A link to watch a class now. Free classes only, until memberships and
 * class payments exist; signed links for the rest are ready for then.
 */
export const getPlayback = async (id) => {
    const c = await prisma.liveClass.findUnique({ where: { id } });
    if (!c || c.status === 'cancelled') throw notFound();
    if (c.tier !== 'free') throw new AppError('This class is for members. Watching online opens with membership.', 403, { code: 'members_only' });
    const kind = watchable(c);
    if (!kind) throw new AppError("This class isn't live yet. Come back when it starts.", 409, { code: 'not_live' });
    const provider = videoProvider(c.videoProvider);
    if (!provider?.isConfigured()) throw notConfigured();
    const playbackId = kind === 'live' ? c.playbackId : c.replayPlaybackId;
    return { kind, url: await provider.playbackUrl(playbackId, { signed: c.signedPlayback }) };
};
