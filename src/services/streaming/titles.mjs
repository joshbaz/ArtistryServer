import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { withNextNumber } from '../system/counters.mjs';
import { dropFromHero } from './settings.mjs';
import { knownAdvisories, missingKeys } from './terms.mjs';
import { discardAssets, discardEpisodeAssets, discardTitleAssets, later } from './assets.mjs';
import { ratingCounts } from './library.mjs';
import { dropFiles, filesOf, storeCaptions, storeImages } from './media.mjs';

/**
 * The streaming library (Studio › Streaming › Library) and the catalogue the
 * stream site and the app read. A film has one video; a series has seasons of
 * episodes, each with its own. Videos and trailers are set only by uploads
 * and the encoder (uploads.mjs, encoder.mjs), never by a form, so "ready"
 * is always true. Removing or replacing one deletes its files from Spaces.
 *
 * A title is public once it's published (or scheduled and its time has come)
 * and has something to watch: a ready video, or for a series, a released
 * episode with one. What's public never includes a playback link (those come
 * from POST streaming/playback) or upload details.
 */

const notFound = () => new AppError('Title not found.', 404);
const notSeries = () => new AppError('That title is a film, not a series.', 409, { code: 'not_series' });
const fieldError = (field, message, status = 422) => new AppError(message, status, { details: { fieldErrors: { [field]: [message] } } });

const NO_VIDEO = { status: 'none' };
const iso = (d) => (d ? d.toISOString() : null);

/** As the Studio reads it. */
const toTitle = (t) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    format: t.format,
    synopsis: t.synopsis,
    description: t.description,
    categoryIds: t.categoryIds,
    language: t.language,
    ageRating: t.ageRating,
    advisories: t.advisories,
    releaseYear: t.releaseYear,
    cast: t.cast,
    crew: t.crew,
    poster: t.poster,
    backdrop: t.backdrop,
    video: t.video ?? NO_VIDEO,
    ...(t.trailer ? { trailer: t.trailer } : {}),
    captions: t.captions ?? [],
    ...(t.format === 'series' ? { seasons: t.seasons ?? [] } : {}),
    access: { tier: t.accessTier, priceUGX: t.priceUGX },
    publishStatus: t.publishStatus,
    releaseAt: iso(t.releaseAt),
    featured: t.featured,
    views: t.views,
    updatedAt: iso(t.updatedAt),
});

/* Public */

const isOut = (releaseAt, now) => !releaseAt || new Date(releaseAt).getTime() <= now;
const ready = (video) => video?.status === 'ready';
// What a viewer may know about a video: whether it plays, and how long it is.
const publicVideo = (v) => (ready(v) ? { status: 'ready', duration: v.duration ?? 0, ...(v.width ? { width: v.width, height: v.height } : {}) } : { status: 'none' });

/** Released episodes with a ready video, in seasons that have any. */
const publicSeasons = (seasons, now) =>
    (seasons ?? [])
        .map((s) => ({
            number: s.number,
            title: s.title,
            episodes: s.episodes
                .filter((e) => ready(e.video) && isOut(e.releaseAt, now))
                .map((e) => ({ id: e.id, number: e.number, title: e.title, synopsis: e.synopsis, still: e.still, video: publicVideo(e.video), intro: e.intro ?? null, releaseAt: e.releaseAt ?? null, captions: e.captions ?? [] })),
        }))
        .filter((s) => s.episodes.length);

const isLive = (t, now) => t.publishStatus === 'published' || (t.publishStatus === 'scheduled' && t.releaseAt && t.releaseAt.getTime() <= now);

/** As the stream site and the app read it, or null when it isn't public. */
const toPublicTitle = (t, now = Date.now()) => {
    if (!isLive(t, now)) return null;
    const { seasons, video, trailer, ...rest } = toTitle(t);
    let shown;
    if (t.format === 'series') {
        const out = publicSeasons(seasons, now);
        if (!out.length) return null;
        const duration = out.reduce((sum, s) => sum + s.episodes.reduce((n, e) => n + e.video.duration, 0), 0);
        shown = { video: { status: 'ready', duration }, seasons: out };
    } else {
        if (!ready(video)) return null;
        shown = { video: publicVideo(video) };
    }
    return {
        ...rest,
        ...shown,
        // A trailer is public by nature (the hero plays it to everyone).
        ...(ready(trailer) && trailer.playbackUrl ? { trailer: { status: 'ready', playbackUrl: trailer.playbackUrl, duration: trailer.duration ?? 0, autoplay: trailer.autoplay !== false } } : {}),
    };
};

/** Every public title; `q` searches the name, story, cast and crew. */
export const listPublicTitles = async ({ q } = {}) => {
    const now = Date.now();
    const rows = await prisma.streamTitle.findMany({ where: { publishStatus: { in: ['published', 'scheduled'] } }, orderBy: { createdAt: 'asc' } });
    let titles = rows.map((t) => toPublicTitle(t, now)).filter(Boolean);
    const needle = q?.trim().toLowerCase();
    if (needle) {
        titles = titles.filter((t) => [t.title, t.synopsis, ...t.cast.map((c) => c.name), ...t.crew.map((c) => c.name)].join(' ').toLowerCase().includes(needle));
    }
    return withRatings(titles);
};

const NO_RATINGS = { meh: 0, like: 0, love: 0 };
/** Adds what members rated each title. */
const withRatings = async (titles) => {
    const counts = await ratingCounts(titles.map((t) => t.id));
    return titles.map((t) => ({ ...t, ratings: counts[t.id] ?? NO_RATINGS }));
};

/** One more play, for Trending. Never holds up the player. */
export const countView = (id) => {
    prisma.streamTitle.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {});
};

/** One public title; anything else is a 404, so drafts can't be guessed at. */
export const getPublicTitle = async (id) => {
    const row = await prisma.streamTitle.findUnique({ where: { id } });
    const title = row && toPublicTitle(row);
    if (!title) throw new AppError("That title isn't available.", 404);
    return (await withRatings([title]))[0];
};

/* Studio */

const changed = (id) => invalidateSite('titles', { id });

export const listTitles = async () => (await prisma.streamTitle.findMany({ orderBy: { createdAt: 'asc' } })).map(toTitle);

export const getTitle = async (id) => {
    const row = await prisma.streamTitle.findUnique({ where: { id } });
    if (!row) throw notFound();
    return toTitle(row);
};

/** The type and categories must be on their lists; warnings keep their saved spelling. */
const checkLists = async (data) => {
    if (data.type && (await missingKeys('type', [data.type])).length) throw fieldError('type', 'Choose a type from the list.');
    if (data.categoryIds?.length && (await missingKeys('category', data.categoryIds)).length) throw fieldError('categoryIds', 'One of those categories was deleted. Choose again.');
    if (data.advisories) data.advisories = await knownAdvisories(data.advisories);
};

/**
 * The rules the form also checks, against the title as it will be: only
 * pay-per-view has a price (UGX 500 or more), and a scheduled title needs a
 * time (in the future when it's being set).
 */
const toData = (patch, current) => {
    const { access, ...data } = patch;
    const tier = access?.tier ?? current?.accessTier ?? 'subscription';
    const price = access?.priceUGX ?? current?.priceUGX ?? 0;
    if (access || patch.publishStatus) {
        if (tier === 'ppv' && price < 500) throw fieldError('access.priceUGX', 'Pay-per-view needs a price of at least UGX 500.');
        Object.assign(data, { accessTier: tier, priceUGX: tier === 'ppv' ? price : 0 });
    }
    if ('releaseAt' in data) data.releaseAt = data.releaseAt ? new Date(data.releaseAt) : null;
    const status = data.publishStatus ?? current?.publishStatus ?? 'draft';
    const releaseAt = 'releaseAt' in data ? data.releaseAt : current?.releaseAt ?? null;
    if (status === 'scheduled') {
        if (!releaseAt) throw fieldError('releaseAt', 'Pick a release time.');
        // Only a time being set now must be ahead: re-saving one that has since passed is fine (it's out).
        const settingIt = current?.publishStatus !== 'scheduled' || ('releaseAt' in data && releaseAt.getTime() !== current?.releaseAt?.getTime());
        if (settingIt && releaseAt.getTime() <= Date.now()) throw fieldError('releaseAt', 'Pick a release time in the future.');
    }
    // Published without a time: out now.
    if (status === 'published' && !releaseAt) data.releaseAt = new Date();
    return data;
};

const highestTitleNumber = async () =>
    Math.max(0, ...(await prisma.streamTitle.findMany({ select: { id: true } })).map((t) => Number(/^ttl_(\d+)$/.exec(t.id)?.[1] ?? 0)));

/** A new title is a draft with no video; the upload attaches one. A series starts with an empty Season 1. */
export const createTitle = async ({ format = 'film', ...input }) => {
    const series = format === 'series';
    const fields = { type: series ? 'series' : 'film', ...input };
    await checkLists(fields);
    await storeImages(fields, ['poster', 'backdrop']);
    const data = toData({ access: { tier: 'subscription', priceUGX: 0 }, ...fields }, null);
    const row = await withNextNumber('streamTitle', highestTitleNumber, (n) =>
        prisma.streamTitle.create({
            data: {
                releaseYear: new Date().getFullYear(),
                ...data,
                id: `ttl_${String(n).padStart(3, '0')}`,
                format,
                video: NO_VIDEO,
                seasons: series ? [{ number: 1, title: 'Season 1', episodes: [] }] : undefined,
            },
        }),
    );
    changed(row.id);
    return toTitle(row);
};

export const updateTitle = async (id, patch) => {
    const current = await prisma.streamTitle.findUnique({ where: { id } });
    if (!current) throw notFound();
    await checkLists(patch);
    await storeImages(patch, ['poster', 'backdrop']);
    const row = await prisma.streamTitle.update({ where: { id }, data: toData(patch, current) });
    changed(id);
    // A replaced picture goes from Spaces.
    dropFiles(['poster', 'backdrop'].filter((f) => current[f] !== row[f]).map((f) => current[f]));
    return toTitle(row);
};

export const deleteTitle = async (id) => {
    const row = await prisma.streamTitle.findUnique({ where: { id } });
    const { count } = await prisma.streamTitle.deleteMany({ where: { id } });
    if (!count) return;
    await dropFromHero(id);
    changed(id);
    later(discardTitleAssets(id));
    if (row) dropFiles(filesOf(row));
};

/**
 * A change worked out from the title as it is now, saved only if nobody saved
 * in between (seasons and episodes live in one field, so two editors at once
 * must not overwrite each other). `change` returns the fields to save, or
 * null for nothing to do.
 */
const edit = async (id, change) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await prisma.streamTitle.findUnique({ where: { id } });
        if (!current) throw notFound();
        const data = change(current);
        if (!data) return toTitle(current);
        const { count } = await prisma.streamTitle.updateMany({ where: { id, updatedAt: current.updatedAt }, data });
        if (count) {
            changed(id);
            return toTitle(await prisma.streamTitle.findUnique({ where: { id } }));
        }
    }
    throw new AppError('Someone else is editing this title. Try again.', 409);
};

/** Runs `change` on a copy of a series' seasons, then saves them in order. */
const editSeasons = (id, change) =>
    edit(id, (t) => {
        if (t.format !== 'series') throw notSeries();
        const seasons = structuredClone(t.seasons ?? []);
        const next = change(seasons) ?? seasons;
        next.sort((a, b) => a.number - b.number).forEach((s) => s.episodes.sort((a, b) => a.number - b.number));
        return { seasons: next };
    });

const findEpisode = (seasons, episodeId) => {
    for (const season of seasons) {
        const episode = season.episodes.find((e) => e.id === episodeId);
        if (episode) return { season, episode };
    }
    throw new AppError('Episode not found.', 404);
};

const findSeason = (seasons, number) => {
    const season = seasons.find((s) => s.number === number);
    if (!season) throw new AppError('Season not found.', 404);
    return season;
};

const numberTaken = (season, number, ownId) => {
    if (season.episodes.some((e) => e.number === number && e.id !== ownId)) throw fieldError('number', `Season ${season.number} already has an episode ${number}.`, 409);
};

export const addSeason = (id) =>
    editSeasons(id, (seasons) => {
        const number = Math.max(0, ...seasons.map((s) => s.number)) + 1;
        seasons.push({ number, title: `Season ${number}`, episodes: [] });
    });

export const renameSeason = (id, number, title) =>
    editSeasons(id, (seasons) => {
        findSeason(seasons, number).title = title || `Season ${number}`;
    });

/** Only an empty season can go, so episodes are never lost by accident. */
export const removeSeason = (id, number) =>
    editSeasons(id, (seasons) => {
        if (findSeason(seasons, number).episodes.length) throw new AppError("Delete or move this season's episodes first.", 409, { code: 'season_not_empty' });
        return seasons.filter((s) => s.number !== number);
    });

/** → { title, episodeId }. No video yet: the upload attaches it. */
export const addEpisode = async (id, seasonNo, data) => {
    const episodeId = `ep_${crypto.randomBytes(5).toString('hex')}`;
    await storeImages(data, ['still']);
    const title = await editSeasons(id, (seasons) => {
        const season = findSeason(seasons, seasonNo);
        numberTaken(season, data.number);
        season.episodes.push({ id: episodeId, ...data, video: NO_VIDEO });
    });
    return { title, episodeId };
};

export const updateEpisode = async (id, episodeId, patch) => {
    await storeImages(patch, ['still']);
    let before;
    const title = await editSeasons(id, (seasons) => {
        const { season, episode } = findEpisode(seasons, episodeId);
        if (patch.number !== undefined) numberTaken(season, patch.number, episodeId);
        before = episode.still;
        Object.assign(episode, patch);
    });
    if ('still' in patch && before !== patch.still) dropFiles([before]);
    return title;
};

export const deleteEpisode = async (id, episodeId) => {
    let gone;
    const title = await editSeasons(id, (seasons) => {
        const { season, episode } = findEpisode(seasons, episodeId);
        gone = [episode.still, ...(episode.captions ?? []).map((c) => c.src)];
        season.episodes = season.episodes.filter((e) => e.id !== episodeId);
    });
    later(discardEpisodeAssets(id, episodeId));
    dropFiles(gone);
    return title;
};

/* Captions: one file per language, on a film or an episode */

/** Adds or replaces the captions in `lang`; the old file goes. */
export const setCaptions = async ({ titleId, episodeId = null }, lang, { label, text }) => {
    const src = await storeCaptions(titleId, lang, text);
    let before = null;
    const put = (list = []) => {
        before = list.find((c) => c.lang === lang)?.src ?? null;
        return [...list.filter((c) => c.lang !== lang), { lang, label, src }].sort((a, b) => a.label.localeCompare(b.label));
    };
    let title;
    try {
        title = episodeId
            ? await editSeasons(titleId, (seasons) => {
                const { episode } = findEpisode(seasons, episodeId);
                episode.captions = put(episode.captions);
            })
            : await edit(titleId, (t) => ({ captions: put(t.captions) }));
    } catch (error) {
        dropFiles([src]);
        throw error;
    }
    dropFiles([before]);
    return title;
};

export const removeCaptions = async ({ titleId, episodeId = null }, lang) => {
    let gone = null;
    const take = (list = []) => {
        gone = list.find((c) => c.lang === lang)?.src ?? null;
        return list.filter((c) => c.lang !== lang);
    };
    const title = episodeId
        ? await editSeasons(titleId, (seasons) => {
            const { episode } = findEpisode(seasons, episodeId);
            episode.captions = take(episode.captions);
        })
        : await edit(titleId, (t) => (t.captions?.some((c) => c.lang === lang) ? { captions: take(t.captions) } : null));
    dropFiles([gone]);
    return title;
};

/* Videos: each upload fills a slot (a film's video, an episode's, or the trailer) */

/**
 * Puts `video` in a slot and answers `{ title, applied, previous }`, where
 * previous is the asset the slot held before. With `onlyIf`, only while the
 * slot still holds that asset: an encode that finishes after its upload was
 * replaced or removed changes nothing. A trailer keeps its autoplay setting.
 */
export const setSlot = async ({ titleId, episodeId = null, kind = 'video' }, video, { onlyIf } = {}) => {
    let previous = null;
    let applied = true;
    const pick = (current) => {
        previous = current?.assetId ?? null;
        applied = !onlyIf || previous === onlyIf;
        return applied;
    };
    const title = await edit(titleId, (t) => {
        if (kind === 'trailer') {
            if (!pick(t.trailer)) return null;
            return { trailer: video.status === 'none' ? null : { autoplay: t.trailer?.autoplay ?? true, ...video } };
        }
        if (episodeId) {
            if (t.format !== 'series') throw notSeries();
            const seasons = structuredClone(t.seasons ?? []);
            const { episode } = findEpisode(seasons, episodeId);
            if (!pick(episode.video)) return null;
            episode.video = video;
            return { seasons };
        }
        if (!pick(t.video)) return null;
        return { video };
    });
    return { title, applied, previous };
};

/** Empties a slot and deletes the video that was in it. */
const clearSlot = async (target) => {
    const { title, previous } = await setSlot(target, NO_VIDEO);
    later(discardAssets([previous]));
    return title;
};

export const removeTitleVideo = (id) => clearSlot({ titleId: id });

export const removeEpisodeVideo = (id, episodeId) => clearSlot({ titleId: id, episodeId });

export const removeTrailer = (id) => clearSlot({ titleId: id, kind: 'trailer' });

/** Whether the stream site's hero may autoplay this title's trailer. */
export const setTrailerAutoplay = (id, autoplay) =>
    edit(id, (t) => {
        if (!t.trailer) throw new AppError('This title has no trailer yet.', 409, { code: 'no_trailer' });
        return { trailer: { ...t.trailer, autoplay } };
    });

/**
 * What a viewer asked to play: the title as stored and the slot's video,
 * when the title is out and the video ready. The Studio may play drafts and
 * unreleased episodes, to check them.
 */
export const findWatchable = async ({ titleId, episodeId = null }, { studio = false } = {}) => {
    const unavailable = () => new AppError("That title isn't available.", 404);
    const t = await prisma.streamTitle.findUnique({ where: { id: titleId } });
    const now = Date.now();
    if (!t || (!studio && !isLive(t, now))) throw unavailable();
    let video = t.video;
    let intro = null;
    let captions = t.captions ?? [];
    if (t.format === 'series') {
        if (!episodeId) throw fieldError('episodeId', 'Choose an episode to play.');
        const episode = (t.seasons ?? []).flatMap((s) => s.episodes).find((e) => e.id === episodeId);
        if (!episode || (!studio && !isOut(episode.releaseAt, now))) throw new AppError("That episode isn't available.", 404);
        video = episode.video;
        intro = episode.intro ?? null;
        captions = episode.captions ?? [];
    }
    if (!ready(video) || !video.assetId) throw new AppError("This video isn't ready to play yet.", 409, { code: 'not_ready' });
    return { title: t, video, intro, captions };
};
