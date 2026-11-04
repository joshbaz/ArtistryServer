import crypto from 'crypto';
import { AppError } from '../../utils/AppError.js';
import * as spaces from '../storage/spaces.mjs';
import { later } from './assets.mjs';

/**
 * A title's pictures and captions, kept in Spaces and served from its CDN.
 *
 * Pictures: the Studio sends a poster, backdrop or episode still as image
 * data (resized in the browser, as before); it's written to Spaces here and
 * the title keeps the CDN link, so the catalogue stays small and every image
 * is cached near the viewer. A link is kept as it is. Without a bucket set
 * up, the data is kept as it came.
 *
 * Captions: WebVTT (an SRT file is turned into one), one file per language.
 *
 * Each file has its own name, so a replaced one is simply deleted: nothing
 * else points at it.
 */

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const name = () => crypto.randomBytes(10).toString('hex');

/** Image data → its CDN link; anything else back as it was. */
export const storeImage = async (value) => {
    const m = DATA_URL.exec(value ?? '');
    if (!m || !spaces.isConfigured()) return value;
    const type = m[1];
    const key = `images/${name()}.${type === 'jpeg' ? 'jpg' : type}`;
    await spaces.putBuffer(key, Buffer.from(m[2], 'base64'), { contentType: `image/${type}`, cacheControl: IMMUTABLE, isPublic: true });
    return spaces.cdnUrl(key);
};

/** Stores each of these fields of `data` that holds image data, in place. */
export const storeImages = async (data, fields) => {
    for (const field of fields) if (typeof data[field] === 'string') data[field] = await storeImage(data[field]);
    return data;
};

/** Deletes files of ours that nothing uses any more (links elsewhere and image data are left alone). */
export const dropFiles = (urls) => {
    const keys = [...new Set(urls.map(spaces.keyOf).filter(Boolean))];
    if (keys.length) later(spaces.deleteKeys(keys));
};

/** Every file a title holds: pictures, stills, captions (to delete with it). */
export const filesOf = (t) => [
    t.poster,
    t.backdrop,
    ...(t.captions ?? []).map((c) => c.src),
    ...(t.seasons ?? []).flatMap((s) => s.episodes.flatMap((e) => [e.still, ...(e.captions ?? []).map((c) => c.src)])),
];

/* Captions */

const SRT_TIME = /(\d{2}:\d{2}:\d{2}),(\d{3})/g;

/** WebVTT as it came, or an SRT file turned into it. Refuses anything without cue times. */
export const toVtt = (text) => {
    const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    if (!/-->/.test(body)) throw new AppError("That file has no subtitle timings in it. Use a .vtt or .srt file.", 422, { details: { fieldErrors: { file: ['Use a .vtt or .srt file.'] } } });
    if (body.startsWith('WEBVTT')) return `${body}\n`;
    // SRT: commas in the times become dots; the cue numbers can stay (WebVTT allows them).
    return `WEBVTT\n\n${body.replace(SRT_TIME, '$1.$2')}\n`;
};

/** Writes a captions file: → its CDN link. */
export const storeCaptions = async (titleId, lang, text) => {
    if (!spaces.isConfigured()) throw new AppError("Captions need the video storage, which isn't connected yet.", 503, { code: 'uploads_not_connected' });
    const key = `captions/${titleId}/${lang}-${name()}.vtt`;
    await spaces.putBuffer(key, Buffer.from(toVtt(text), 'utf8'), { contentType: 'text/vtt; charset=utf-8', cacheControl: IMMUTABLE, isPublic: true });
    return spaces.cdnUrl(key);
};
