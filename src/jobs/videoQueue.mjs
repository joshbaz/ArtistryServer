import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env.mjs';

/**
 * The encode queue (BullMQ on the shared Redis). A finished upload adds a job
 * named for its asset, so the same video is never queued twice; the worker
 * converts one at a time unless VIDEO_ENCODE_CONCURRENCY says otherwise.
 * The worker runs in the API process, or with VIDEO_WORKER=off in its own
 * (`yarn worker`), so a long encode can move off the server that answers the site.
 */
const NAME = 'video-encode';

let connection;
// BullMQ needs its own ioredis connections, and ones that wait rather than fail while Redis is away.
const conn = () => (connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }));

let queue;
const encodeQueue = () =>
    (queue ??= new Queue(NAME, {
        connection: conn(),
        // A second try covers a dropped connection mid-encode; a file ffmpeg can't read fails at once (UnrecoverableError).
        defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 60_000 }, removeOnComplete: 200, removeOnFail: 500 },
    }));

export const queueEncode = (assetId) => encodeQueue().add('encode', { assetId }, { jobId: assetId });

/** Takes a waiting job off the queue. A running one finishes, finds its video gone and tidies up. */
export const dropEncode = async (assetId) => {
    const job = await encodeQueue().getJob(assetId);
    if (job && !(await job.isActive())) await job.remove().catch(() => {});
};

let worker;

/**
 * Starts taking jobs. `encode(assetId, { onProgress })` does the work;
 * `onGiveUp(assetId, error)` runs once the last try has failed.
 */
export const startVideoWorker = ({ encode, onGiveUp }) => {
    if (worker) return worker;
    worker = new Worker(NAME, (job) => encode(job.data.assetId, { onProgress: (p) => job.updateProgress(p) }), {
        connection: conn(),
        concurrency: env.VIDEO_ENCODE_CONCURRENCY,
        // ffmpeg keeps the event loop free, so the lock is renewed throughout; this is just headroom.
        lockDuration: 5 * 60_000,
    });
    worker.on('failed', (job, error) => {
        if (!job) return;
        const last = job.attemptsMade >= (job.opts.attempts ?? 1) || error?.name === 'UnrecoverableError';
        console.error(`Encode ${job.data.assetId} failed${last ? '' : ', trying again'}:`, error?.message);
        if (last) onGiveUp(job.data.assetId, error);
    });
    worker.on('error', (error) => console.error('Video worker:', error.message));
    console.info(`Video worker: converting up to ${env.VIDEO_ENCODE_CONCURRENCY} upload${env.VIDEO_ENCODE_CONCURRENCY === 1 ? '' : 's'} at a time`);
    return worker;
};

export const stopVideoWorker = async () => {
    await worker?.close();
    worker = undefined;
};
