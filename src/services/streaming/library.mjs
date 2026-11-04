import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateMember } from '../../utils/sockets.js';

/**
 * What a member keeps on the stream site and the app: My List, their
 * ratings, and where they stopped (Continue watching, and each episode's
 * bar). The member is always the signed-in one. Each change but the
 * player's own progress saves (every few seconds) is sent to their other devices.
 */

const iso = (d) => d.toISOString();
// Past this share of the video, it counts as watched.
const DONE_AT = 0.95;

const titleExists = async (titleId) => {
    if (!(await prisma.streamTitle.findUnique({ where: { id: titleId }, select: { id: true } }))) throw new AppError("That title isn't available.", 404);
};

/* My List */

export const getWatchlist = async (memberId) =>
    (await prisma.watchlistItem.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' }, select: { titleId: true } })).map((w) => w.titleId);

export const addToWatchlist = async (memberId, titleId) => {
    await titleExists(titleId);
    await prisma.watchlistItem.upsert({ where: { memberId_titleId: { memberId, titleId } }, create: { memberId, titleId }, update: {} });
    invalidateMember(memberId);
    return getWatchlist(memberId);
};

export const removeFromWatchlist = async (memberId, titleId) => {
    await prisma.watchlistItem.deleteMany({ where: { memberId, titleId } });
    invalidateMember(memberId);
    return getWatchlist(memberId);
};

/* Ratings: meh (Not for me), like, love */

export const getRatings = async (memberId) =>
    Object.fromEntries((await prisma.titleRating.findMany({ where: { memberId } })).map((r) => [r.titleId, r.rating]));

export const setRating = async (memberId, titleId, rating) => {
    await titleExists(titleId);
    await prisma.titleRating.upsert({ where: { memberId_titleId: { memberId, titleId } }, create: { memberId, titleId, rating }, update: { rating } });
    invalidateMember(memberId);
    return getRatings(memberId);
};

export const clearRating = async (memberId, titleId) => {
    await prisma.titleRating.deleteMany({ where: { memberId, titleId } });
    invalidateMember(memberId);
    return getRatings(memberId);
};

/** { titleId: { meh, like, love } } for the public catalogue. */
export const ratingCounts = async (titleIds) => {
    const rows = await prisma.titleRating.groupBy({ by: ['titleId', 'rating'], where: { titleId: { in: titleIds } }, _count: { _all: true } });
    const counts = {};
    for (const r of rows) (counts[r.titleId] ??= { meh: 0, like: 0, love: 0 })[r.rating] = r._count._all;
    return counts;
};

/* Progress */

/** { titleId: { seconds, duration, updatedAt, episodeId? } }: Continue watching. */
export const getProgress = async (memberId) =>
    Object.fromEntries(
        (await prisma.watchProgress.findMany({ where: { memberId }, orderBy: { updatedAt: 'desc' } })).map((p) => [
            p.titleId,
            { seconds: p.seconds, duration: p.duration, updatedAt: iso(p.updatedAt), ...(p.episodeId ? { episodeId: p.episodeId } : {}) },
        ]),
    );

/** { episodeId: { seconds, duration, done, updatedAt } }: each episode's bar. */
export const getEpisodeProgress = async (memberId) =>
    Object.fromEntries((await prisma.episodeProgress.findMany({ where: { memberId } })).map((e) => [e.episodeId, { seconds: e.seconds, duration: e.duration, done: e.done, updatedAt: iso(e.updatedAt) }]));

/**
 * The player saves where it is every few seconds. A finished title drops out
 * of Continue watching; a finished episode is marked done (the series moves
 * on with "next episode"). Answers with Continue watching.
 */
export const saveProgress = async (memberId, { titleId, episodeId = null, seconds, duration }) => {
    const done = duration > 0 && seconds / duration > DONE_AT;
    if (episodeId) {
        const before = await prisma.episodeProgress.findUnique({ where: { memberId_episodeId: { memberId, episodeId } } });
        const data = { titleId, seconds: done ? 0 : seconds, duration, done: done || Boolean(before?.done) };
        await prisma.episodeProgress.upsert({ where: { memberId_episodeId: { memberId, episodeId } }, create: { memberId, episodeId, ...data }, update: data });
    }
    if (done) await prisma.watchProgress.deleteMany({ where: { memberId, titleId } });
    else await prisma.watchProgress.upsert({ where: { memberId_titleId: { memberId, titleId } }, create: { memberId, titleId, episodeId, seconds, duration }, update: { episodeId, seconds, duration } });
    return getProgress(memberId);
};

/** Takes one title off Continue watching. */
export const clearTitleProgress = async (memberId, titleId) => {
    await prisma.watchProgress.deleteMany({ where: { memberId, titleId } });
    invalidateMember(memberId);
    return getProgress(memberId);
};

/** Account › Clear watch history: Continue watching and every episode bar. */
export const clearHistory = async (memberId) => {
    await prisma.$transaction([prisma.watchProgress.deleteMany({ where: { memberId } }), prisma.episodeProgress.deleteMany({ where: { memberId } })]);
    invalidateMember(memberId);
};

/** Everything at once: GET library. */
export const getLibrary = async (memberId) => {
    const [watchlist, ratings, progress, episodes] = await Promise.all([getWatchlist(memberId), getRatings(memberId), getProgress(memberId), getEpisodeProgress(memberId)]);
    return { watchlist, ratings, progress, episodes };
};
