import prisma from '../../utils/db.mjs';
import * as spaces from '../storage/spaces.mjs';
import { dropEncode } from '../../jobs/videoQueue.mjs';

/**
 * Removing uploaded videos from Spaces: the original, its HLS versions, an
 * unfinished upload, a queued encode, and the record. Called when a video is
 * removed or replaced, or its episode or title is deleted. Runs after the
 * title is saved, so a slow bucket never holds up the Studio; a failure is
 * logged and the files are left for a later clean-up.
 */

export const assetPrefix = (id) => `videos/${id}/`;
export const originalPrefix = (id) => `originals/${id}/`;

const discard = async (asset) => {
    try {
        await dropEncode(asset.id).catch(() => {});
        if (asset.status === 'uploading' && asset.uploadId) await spaces.abortMultipart(asset.originalKey, asset.uploadId).catch(() => {});
        if (spaces.isConfigured()) {
            await spaces.deletePrefix(originalPrefix(asset.id));
            await spaces.deletePrefix(assetPrefix(asset.id));
        }
        await prisma.videoAsset.deleteMany({ where: { id: asset.id } });
    } catch (error) {
        console.error(`Could not remove video ${asset.id} from Spaces:`, error.message);
    }
};

/** Removes these assets (ids that aren't assets, like the demo videos', are skipped). */
export const discardAssets = async (ids) => {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return;
    const assets = await prisma.videoAsset.findMany({ where: { id: { in: wanted } } });
    await Promise.all(assets.map(discard));
};

/** Every video a deleted title had: its film or episodes, and its trailer. */
export const discardTitleAssets = async (titleId) => {
    const assets = await prisma.videoAsset.findMany({ where: { titleId } });
    await Promise.all(assets.map(discard));
};

/** For a deleted episode. */
export const discardEpisodeAssets = async (titleId, episodeId) => {
    const assets = await prisma.videoAsset.findMany({ where: { titleId, episodeId } });
    await Promise.all(assets.map(discard));
};

/** Starts the clean-up without waiting for it. */
export const later = (work) => {
    work.catch((error) => console.error('Video clean-up failed:', error.message));
};
