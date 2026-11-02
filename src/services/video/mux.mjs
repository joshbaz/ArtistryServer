import crypto from 'crypto';
import { SignJWT } from 'jose';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * Mux (mux.com), behind services/video/index.mjs. Live streams are made per
 * class; Mux records them when asked and tells us through its webhook when
 * one goes live, goes idle and has its recording ready.
 */

const API = `${env.MUX_API_URL ?? 'https://api.mux.com'}/video/v1`;
// Mux's one ingest address for RTMPS (port 443, so it gets through most networks).
const INGEST_SERVER = 'rtmps://global-live.mux.com:443/app';
// A presenter whose connection drops has this long to reconnect before the stream counts as over.
const RECONNECT_SECONDS = 60;
// A webhook older than this is refused, so a captured one can't be replayed later.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
// How long a signed playback link works: a long class, plus some.
const SIGNED_LINK_HOURS = 6;

export const isConfigured = () => Boolean(env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET);
export const canSign = () => Boolean(env.MUX_SIGNING_KEY_ID && env.MUX_SIGNING_PRIVATE_KEY);

const unreachable = () => new AppError("We couldn't reach the video service. Please try again in a moment.", 502, { code: 'video_provider_unreachable' });

const call = async (method, path, body) => {
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Basic ${Buffer.from(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`).toString('base64')}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw unreachable();
    }
    if (res.status === 404) return null;
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`Mux ${method} ${path} answered ${res.status}: ${detail.slice(0, 300)}`);
        throw unreachable();
    }
    return res.status === 204 ? null : (await res.json()).data;
};

/** @param {{ title: string, record: boolean, signed: boolean }} options */
export const createLiveStream = async ({ title, record, signed }) => {
    const policy = [signed ? 'signed' : 'public'];
    const data = await call('POST', '/live-streams', {
        playback_policy: policy,
        ...(record ? { new_asset_settings: { playback_policy: policy } } : {}),
        reconnect_window: RECONNECT_SECONDS,
        latency_mode: 'standard',
        // Shown in the Mux dashboard, so a stream can be told apart there.
        passthrough: title.slice(0, 255),
    });
    return { liveStreamId: data.id, playbackId: data.playback_ids?.[0]?.id ?? null };
};

export const getIngest = async (liveStreamId) => {
    const data = await call('GET', `/live-streams/${encodeURIComponent(liveStreamId)}`);
    if (!data) return null;
    return { server: INGEST_SERVER, streamKey: data.stream_key };
};

export const deleteLiveStream = async (liveStreamId) => {
    await call('DELETE', `/live-streams/${encodeURIComponent(liveStreamId)}`);
};

/**
 * A Mux webhook, checked against MUX_WEBHOOK_SECRET: the `Mux-Signature`
 * header is `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`.
 * @param {Buffer} rawBody
 * @param {Record<string, string>} headers
 */
export const readWebhook = (rawBody, headers) => {
    if (!env.MUX_WEBHOOK_SECRET) throw new AppError('Webhooks are not set up.', 503, { code: 'video_provider_not_configured' });
    const parts = Object.fromEntries(String(headers['mux-signature'] ?? '').split(',').map((p) => p.split('=')));
    const t = Number(parts.t);
    const expected = crypto.createHmac('sha256', env.MUX_WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
    const given = Buffer.from(String(parts.v1 ?? ''), 'utf8');
    const fresh = Number.isFinite(t) && Math.abs(Date.now() / 1000 - t) <= WEBHOOK_TOLERANCE_SECONDS;
    if (!fresh || given.length !== expected.length || !crypto.timingSafeEqual(given, Buffer.from(expected, 'utf8'))) {
        throw new AppError('Bad signature.', 401);
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const data = event.data ?? {};
    switch (event.type) {
        case 'video.live_stream.active':
            return { type: 'live', liveStreamId: data.id };
        case 'video.live_stream.idle':
            return { type: 'idle', liveStreamId: data.id };
        // The recording of a stream that has finished: what "Watch again" plays.
        case 'video.asset.live_stream_completed':
            return data.live_stream_id ? { type: 'replay', liveStreamId: data.live_stream_id, playbackId: data.playback_ids?.[0]?.id ?? null } : null;
        default:
            return null;
    }
};

let signingKey = null;
// Mux shows the key base64-encoded (one line, "LS0tLS1CRUdJTi…"); a pasted PEM ("-----BEGIN…", \n for line breaks) works too.
const pem = (value) => (value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8'));
const key = () => (signingKey ??= crypto.createPrivateKey(pem(env.MUX_SIGNING_PRIVATE_KEY)));

/** An HLS link; a signed one carries a token that works for a few hours. */
export const playbackUrl = async (playbackId, { signed }) => {
    const url = `https://stream.mux.com/${encodeURIComponent(playbackId)}.m3u8`;
    if (!signed) return url;
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: env.MUX_SIGNING_KEY_ID })
        .setSubject(playbackId)
        .setAudience('v')
        .setExpirationTime(`${SIGNED_LINK_HOURS}h`)
        .sign(key());
    return `${url}?token=${token}`;
};
