import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import * as mux from './mux.mjs';

/**
 * The seam between the app and the video provider (MOU 4.3). Live classes
 * only talk to the provider through here, so switching (say, to Cloudflare
 * Stream) is one more module with the same exports and VIDEO_PROVIDER set to
 * its name. Each class remembers the provider its stream was made on, so an
 * old recording keeps playing after a switch.
 *
 * A provider module exports:
 *   isConfigured()                              → boolean
 *   canSign()                                   → boolean: playback links can be made to expire
 *   createLiveStream({ title, record, signed }) → { liveStreamId, playbackId }
 *   getIngest(liveStreamId)                     → { server, streamKey } for OBS
 *   deleteLiveStream(liveStreamId)
 *   readWebhook(rawBody, headers)               → a checked event, or null for one we don't use:
 *       { type: 'live' | 'idle' | 'replay', liveStreamId, playbackId? }
 *     (throws a 401 AppError when the signature is wrong)
 *   playbackUrl(playbackId, { signed })         → an HLS (.m3u8) link
 */
const PROVIDERS = { mux };

/** The provider by name: the one in use, or the one an older class was streamed on. */
export const videoProvider = (name = env.VIDEO_PROVIDER) => PROVIDERS[name] ?? null;

export const notConfigured = () =>
    new AppError("Streaming isn't set up yet: each class gets its OBS server and key once the video provider is connected.", 503, { code: 'video_provider_not_configured' });

/** The provider in use, ready to call. */
export const activeProvider = () => {
    const provider = videoProvider();
    if (!provider?.isConfigured()) throw notConfigured();
    return { name: env.VIDEO_PROVIDER, provider };
};
