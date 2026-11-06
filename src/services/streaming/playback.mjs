import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../env.mjs';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import * as spaces from '../storage/spaces.mjs';
import { countView, findWatchable } from './titles.mjs';
import { hasActivePlan, watchableUntil } from './access.mjs';
import { ppvStage } from './pricing.mjs';
import { getAds } from './settings.mjs';
import { assetPrefix } from './assets.mjs';

/**
 * Playing a locked video. POST streaming/playback checks who's asking and
 * answers with a link that works for a few hours:
 *
 *   /api/v1/streaming/play/<token>/master.m3u8         the sizes (from Spaces)
 *   /api/v1/streaming/play/<token>/<size>/index.m3u8   the pieces, as CDN links
 *   /api/v1/streaming/play/<token>/key                 the key to unlock them
 *
 * The player follows the playlists' relative links, so the token rides along
 * by itself. The pieces come from the CDN; only the small playlists and the
 * key come from here. Anyone may watch a free title; a subscription title
 * needs a paid-up plan, a pay-per-view one a rental (access.mjs).
 */

const LINK_HOURS = 6;
// Its own key, made from the member secret, so a playback link can never pass as a sign-in.
const secret = crypto.createHash('sha256').update(`artistry360:playback:${env.MEMBER_TOKEN_SECRET}`).digest();

const expired = () => new AppError('This playback link has expired. Press play again.', 403, { code: 'playback_expired' });
const notReady = () => new AppError("This video isn't ready to play yet.", 409, { code: 'not_ready' });

/**
 * Who may watch what: 401 to sign in first, then 403 `locked` with the way
 * in (`details.reason`: subscribe, or rent at the price of its `stage`, until
 * `nextChangeAt`), as agreed with the stream site and the app. → when access
 * ends (a rental's end), or null.
 */
const checkAccess = async (title, member) => {
    if (title.accessTier === 'free') return null;
    if (!member) throw new AppError('Sign in to watch this.', 401);
    const until = await watchableUntil(member.id, title);
    if (until !== false) return until;
    if (title.accessTier === 'ppv') {
        const { stage, priceUGX, nextChangeAt } = ppvStage(title);
        throw new AppError(`Rent this title to watch it (UGX ${priceUGX.toLocaleString('en-UG')}).`, 403, { code: 'locked', details: { reason: 'rent', stage, priceUGX, nextChangeAt } });
    }
    throw new AppError('Subscribe to watch this.', 403, { code: 'locked', details: { reason: 'subscribe' } });
};

/**
 * Where ads go, in seconds: a pre-roll ([0]) for a free title, unless the
 * viewer has a plan or ads are off (Studio › Streaming › Ads). Mid-rolls come later.
 */
const adBreaksFor = async (title, member) => {
    if (title.accessTier !== 'free') return [];
    const { general, web } = await getAds();
    if (!general.enabled || !web.preroll) return [];
    if (member && (await hasActivePlan(member.id))) return [];
    return [0];
};

/** → { url, expiresAt, duration, intro, captions, adBreaks } for a film (titleId) or an episode (titleId, episodeId). */
export const startPlayback = async (target, { member = null, admin = null } = {}) => {
    const { title, video, intro, captions } = await findWatchable(target, { studio: Boolean(admin) });
    const until = admin ? null : await checkAccess(title, member);
    const asset = await prisma.videoAsset.findUnique({ where: { id: video.assetId } });
    if (!asset || asset.status !== 'ready') throw notReady();
    // Trending counts plays by viewers, not the Studio's checks.
    if (!admin) countView(title.id);
    // A rental's link ends with the rental.
    const expiresAt = new Date(Math.min(Date.now() + LINK_HOURS * 3600 * 1000, until?.getTime() ?? Infinity));
    const token = await new SignJWT({ a: asset.id })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(member?.id ?? admin?.id ?? 'guest')
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(secret);
    return {
        url: `${env.API_URL}/api/v1/streaming/play/${token}/master.m3u8`,
        expiresAt: expiresAt.toISOString(),
        duration: asset.duration,
        intro,
        captions,
        adBreaks: admin ? [] : await adBreaksFor(title, member),
    };
};

/* Serving the playlists and the key. A ready video never changes, so both are kept in memory for a while. */

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await load();
    if (cache.size >= 2000) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: Date.now() + CACHE_MS });
    return value;
};

const assetFor = async (token) => {
    let id;
    try {
        id = (await jwtVerify(token, secret, { algorithms: ['HS256'] })).payload.a;
    } catch {
        throw expired();
    }
    const asset = await cached(`asset:${id}`, () => prisma.videoAsset.findUnique({ where: { id }, select: { id: true, status: true, keyHex: true, renditions: true } }));
    if (!asset || asset.status !== 'ready') throw notReady();
    return asset;
};

export const masterPlaylist = async (token) => {
    const asset = await assetFor(token);
    return cached(`master:${asset.id}`, () => spaces.getText(`${assetPrefix(asset.id)}master.m3u8`));
};

/** One size's playlist, its pieces pointed at the CDN (the key link, ../key, stays here). */
export const renditionPlaylist = async (token, name) => {
    const asset = await assetFor(token);
    if (!asset.renditions.some((r) => r.name === name)) throw new AppError('We could not find that.', 404);
    const base = `${assetPrefix(asset.id)}${name}/`;
    return cached(`rendition:${asset.id}:${name}`, async () => (await spaces.getText(`${base}index.m3u8`)).replace(/^(?!#)(\S+\.ts)$/gm, (piece) => spaces.cdnUrl(`${base}${piece}`)));
};

export const playbackKey = async (token) => {
    const asset = await assetFor(token);
    if (!asset.keyHex) throw new AppError('We could not find that.', 404);
    return Buffer.from(asset.keyHex, 'hex');
};
