import crypto from 'crypto';
import { SignJWT } from 'jose';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * Cloudflare Stream (Stream Live), behind services/video/index.mjs. Each class
 * gets a live input; viewers watch it by the input's id while it's live, and
 * its recording by the recording's own video id. Two webhooks reach us at the
 * same URL: Cloudflare Notifications for "connected" / "disconnected" (with
 * our shared secret in `cf-webhook-auth`), and Stream's own for a recording
 * that's ready (signed in `Webhook-Signature`).
 */

const API = () => `${env.CLOUDFLARE_API_URL ?? 'https://api.cloudflare.com/client/v4'}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`;
// A webhook older than this is refused, so a captured one can't be replayed later.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
// How long a signed playback link works: a long class, plus some (Cloudflare allows up to 24h).
const SIGNED_LINK_HOURS = 6;
// The shortest Cloudflare keeps a recording. A class not meant to be watched again is still
// recorded (with recording off, Cloudflare won't play the input live), just never shown.
const KEEP_RECORDING_DAYS = 30;

export const isConfigured = () => Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_STREAM_API_TOKEN && env.CLOUDFLARE_STREAM_CUSTOMER_CODE);
export const canSign = () => Boolean(env.CLOUDFLARE_STREAM_SIGNING_KEY_ID && env.CLOUDFLARE_STREAM_SIGNING_KEY);

const unreachable = () => new AppError("We couldn't reach the video service. Please try again in a moment.", 502, { code: 'video_provider_unreachable' });

const call = async (method, path, body) => {
    let res;
    try {
        res = await fetch(`${API()}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw unreachable();
    }
    if (res.status === 404) return null;
    const text = await res.text().catch(() => '');
    if (!res.ok) {
        console.error(`Cloudflare Stream ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
        // A request Cloudflare turned down (no Stream subscription, a token without Stream Write): only the Studio calls this, so say why.
        const reason = res.status < 500 && (() => { try { return JSON.parse(text).errors?.map((e) => e.message).join(' '); } catch { return null; } })();
        if (reason) throw new AppError(`Cloudflare turned this down: ${reason}`, 502, { code: 'video_provider_refused' });
        throw unreachable();
    }
    return text ? JSON.parse(text).result : null;
};

/** @param {{ title: string, record: boolean, signed: boolean }} options */
export const createLiveStream = async ({ title, record, signed }) => {
    const data = await call('POST', '/live_inputs', {
        // Shown in the Cloudflare dashboard, so an input can be told apart there.
        meta: { name: title.slice(0, 255) },
        recording: { mode: 'automatic', requireSignedURLs: signed, timeoutSeconds: 0 },
        ...(record ? {} : { deleteRecordingAfterDays: KEEP_RECORDING_DAYS }),
    });
    // Live, the input is watched by its own id.
    return { liveStreamId: data.uid, playbackId: data.uid };
};

export const getIngest = async (liveStreamId) => {
    const data = await call('GET', `/live_inputs/${encodeURIComponent(liveStreamId)}`);
    if (!data?.rtmps) return null;
    return { server: data.rtmps.url, streamKey: data.rtmps.streamKey };
};

export const deleteLiveStream = async (liveStreamId) => {
    await call('DELETE', `/live_inputs/${encodeURIComponent(liveStreamId)}`);
};

const sameText = (a, b) => {
    const x = Buffer.from(String(a ?? ''), 'utf8');
    const y = Buffer.from(String(b ?? ''), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const badSignature = () => new AppError('Bad signature.', 401);
const notSetUp = () => new AppError('Webhooks are not set up.', 503, { code: 'video_provider_not_configured' });

/**
 * Either Cloudflare webhook, checked first:
 *  - Notifications ("Stream Live Input"): `cf-webhook-auth` is the secret set on the webhook destination.
 *  - Stream: `Webhook-Signature` is `time=<seconds>,sig1=<hex HMAC-SHA256 of "time.body">`.
 * @param {Buffer} rawBody
 * @param {Record<string, string>} headers
 */
export const readWebhook = async (rawBody, headers) => {
    if (headers['webhook-signature']) {
        if (!env.CLOUDFLARE_STREAM_WEBHOOK_SECRET) throw notSetUp();
        const parts = Object.fromEntries(String(headers['webhook-signature']).split(',').map((p) => p.split('=')));
        const t = Number(parts.time);
        const expected = crypto.createHmac('sha256', env.CLOUDFLARE_STREAM_WEBHOOK_SECRET).update(`${parts.time}.${rawBody}`).digest('hex');
        const fresh = Number.isFinite(t) && Math.abs(Date.now() / 1000 - t) <= WEBHOOK_TOLERANCE_SECONDS;
        if (!fresh || !sameText(parts.sig1, expected)) throw badSignature();

        // A video finished processing: we only want a live input's recording, once it can play.
        const video = JSON.parse(rawBody.toString('utf8'));
        if (!video.uid || !video.readyToStream || video.status?.state !== 'ready') return null;
        const liveInput = video.liveInput ?? (await call('GET', `/${encodeURIComponent(video.uid)}`))?.liveInput;
        return liveInput ? { type: 'replay', liveStreamId: liveInput, playbackId: video.uid } : null;
    }

    if (!env.CLOUDFLARE_NOTIFICATION_SECRET) throw notSetUp();
    if (!sameText(headers['cf-webhook-auth'], env.CLOUDFLARE_NOTIFICATION_SECRET)) throw badSignature();
    const data = JSON.parse(rawBody.toString('utf8')).data ?? {};
    // Cloudflare's "Save and Test" sends one without an input: nothing to do.
    if (!data.input_id) return null;
    switch (data.event_type) {
        case 'live_input.connected':
            return { type: 'live', liveStreamId: data.input_id };
        case 'live_input.disconnected':
            return { type: 'idle', liveStreamId: data.input_id };
        default:
            return null;
    }
};

let signingKey = null;
// Cloudflare hands the key's pem base64-encoded (one line, "LS0tLS1CRUdJTi…"); a pasted PEM ("-----BEGIN…", \n for line breaks) works too.
const pem = (value) => (value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8'));
const key = () => (signingKey ??= crypto.createPrivateKey(pem(env.CLOUDFLARE_STREAM_SIGNING_KEY)));

/** An HLS link; a signed one has a token in place of the id, working for a few hours. */
export const playbackUrl = async (playbackId, { signed }) => {
    const base = `https://customer-${env.CLOUDFLARE_STREAM_CUSTOMER_CODE}.cloudflarestream.com`;
    if (!signed) return `${base}/${encodeURIComponent(playbackId)}/manifest/video.m3u8`;
    const token = await new SignJWT({ kid: env.CLOUDFLARE_STREAM_SIGNING_KEY_ID })
        .setProtectedHeader({ alg: 'RS256', kid: env.CLOUDFLARE_STREAM_SIGNING_KEY_ID })
        .setSubject(playbackId)
        .setExpirationTime(`${SIGNED_LINK_HOURS}h`)
        .sign(key());
    return `${base}/${token}/manifest/video.m3u8`;
};
