import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import * as spaces from '../storage/spaces.mjs';
import { queueEncode } from '../../jobs/videoQueue.mjs';
import { setSlot } from './titles.mjs';
import { discardAssets, later, originalPrefix } from './assets.mjs';

/**
 * Studio uploads to Spaces. The Studio asks to start one for a slot (a
 * film, an episode or a trailer), sends the file in parts straight to the
 * bucket with links signed here, then says it's done; the parts are checked
 * with Spaces, the file is put together and queued for the encoder.
 *
 * The slot shows each step (uploading, processing, ready or failed), so the
 * library and the dock agree. Starting an upload replaces what was in the
 * slot, and the old video's files are deleted.
 */

const MB = 1024 ** 2;
// Parts of 32 MB or more, and never more than 9,000 (Spaces allows 10,000).
const partSizeFor = (size) => Math.max(32 * MB, Math.ceil(size / 9000 / MB) * MB);
const STALE_AFTER_MS = 24 * 3600 * 1000;

const notFound = () => new AppError('Upload not found.', 404);

const safeName = (name) => name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-120) || 'video';

const targetOf = (a) => ({ titleId: a.titleId, episodeId: a.episodeId, kind: a.kind });

/** What the title shows for this upload at each step. */
const slotVideo = (a, status, extra = {}) => ({ status, assetId: a.id, fileName: a.fileName, size: a.size, ...extra });

/** As the Studio reads an upload. */
const toUpload = (a) => ({
    assetId: a.id,
    status: a.status,
    progress: a.progress,
    partSize: a.partSize,
    partCount: Math.ceil(a.size / a.partSize),
    duration: a.duration,
    error: a.error,
});

const findUpload = async (id) => {
    const asset = await prisma.videoAsset.findUnique({ where: { id } });
    if (!asset) throw notFound();
    return asset;
};

/**
 * Starts an upload into a slot: → { assetId, partSize, partCount }. The
 * slot must exist (an episode of this series, say) before any bytes move.
 */
export const startUpload = async ({ titleId, episodeId = null, kind = 'video', fileName, size, contentType }, admin) => {
    if (!spaces.isConfigured()) throw new AppError("Video uploads aren't connected yet. The rest of the title saves as normal.", 503, { code: 'uploads_not_connected' });
    const id = `ast_${crypto.randomBytes(8).toString('hex')}`;
    const originalKey = `${originalPrefix(id)}${safeName(fileName)}`;
    const asset = { id, titleId, episodeId: kind === 'trailer' ? null : episodeId, kind, fileName, size, contentType, originalKey, partSize: partSizeFor(size) };

    // Claim the slot first: a missing title or episode stops here, before anything is made in Spaces.
    const { previous } = await setSlot(targetOf(asset), slotVideo(asset, 'uploading'));
    try {
        const uploadId = await spaces.startMultipart(originalKey, contentType);
        const row = await prisma.videoAsset.create({ data: { ...asset, uploadId, createdBy: admin?.id ?? null } });
        later(discardAssets([previous]));
        return toUpload(row);
    } catch (error) {
        await setSlot(targetOf(asset), slotVideo(asset, 'failed', { error: 'The upload could not start.' }), { onlyIf: id }).catch(() => {});
        later(discardAssets([previous]));
        throw error.statusCode ? error : new AppError("We couldn't reach the video storage. Please try again in a moment.", 502, { code: 'storage_unreachable' });
    }
};

/** Links to PUT these parts to, valid for an hour: → [{ partNumber, url }]. */
export const signParts = async (id, partNumbers) => {
    const asset = await findUpload(id);
    if (asset.status !== 'uploading') throw new AppError('This upload has finished.', 409, { code: 'upload_closed' });
    const count = Math.ceil(asset.size / asset.partSize);
    const bad = partNumbers.find((n) => n > count);
    if (bad) throw new AppError(`This upload has ${count} parts.`, 422);
    // Still moving: a slow 20 GB upload mustn't be closed as stale while it's going.
    await prisma.videoAsset.update({ where: { id }, data: { progress: Math.round((Math.max(...partNumbers) / count) * 100) } });
    return Promise.all(partNumbers.map(async (partNumber) => ({ partNumber, url: await spaces.signPart(asset.originalKey, asset.uploadId, partNumber) })));
};

/**
 * Every part is in: put the file together and queue the encode. The parts
 * are checked against Spaces, so a missing or short one is said plainly.
 */
export const completeUpload = async (id) => {
    const asset = await findUpload(id);
    if (asset.status !== 'uploading') return toUpload(asset);
    const parts = await spaces.listParts(asset.originalKey, asset.uploadId);
    const count = Math.ceil(asset.size / asset.partSize);
    const received = parts.reduce((sum, p) => sum + p.Size, 0);
    if (parts.length !== count || received !== asset.size) {
        throw new AppError(`Spaces has ${parts.length} of ${count} parts. Send the rest, then finish.`, 409, { code: 'parts_missing', details: { have: parts.map((p) => p.PartNumber) } });
    }
    await spaces.completeMultipart(asset.originalKey, asset.uploadId, parts);
    const { count: moved } = await prisma.videoAsset.updateMany({ where: { id, status: 'uploading' }, data: { status: 'processing', uploadId: null } });
    if (moved) {
        await setSlot(targetOf(asset), slotVideo(asset, 'processing'), { onlyIf: id }).catch(() => {});
        await queueEncode(id);
    }
    return toUpload(await findUpload(id));
};

/** The Studio cancelled, or the transfer failed: the slot is emptied or marked failed, and the parts deleted. */
export const abortUpload = async (id, { failed = false, error } = {}) => {
    const asset = await prisma.videoAsset.findUnique({ where: { id } });
    if (!asset || asset.status !== 'uploading') return;
    await prisma.videoAsset.update({ where: { id }, data: { status: failed ? 'failed' : 'cancelled', error: failed ? error ?? 'The upload stopped.' : null } });
    const video = failed ? slotVideo(asset, 'failed', { error: error ?? 'The upload stopped.' }) : { status: 'none' };
    await setSlot(targetOf(asset), video, { onlyIf: id }).catch(() => {});
    // Nothing plays from it, so it can all go; a failed slot keeps the name, not the files.
    later(discardAssets([id]));
};

export const getUpload = async (id) => toUpload(await findUpload(id));

/** Uploads left open for a day (the tab closed mid-way): close them, so the slot stops saying "uploading". */
export const closeStaleUploads = async () => {
    const stale = await prisma.videoAsset.findMany({ where: { status: 'uploading', updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } }, select: { id: true } });
    for (const { id } of stale) await abortUpload(id, { failed: true, error: "The upload didn't finish. Try again." });
    return stale.length;
};
