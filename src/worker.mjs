import { env } from './env.mjs';
import { startVideoWorker, stopVideoWorker } from './jobs/videoQueue.mjs';
import { encodeAsset, giveUp } from './services/streaming/encoder.mjs';
import { isConfigured } from './services/storage/spaces.mjs';
import prisma from './utils/db.mjs';

/**
 * The encode worker on its own: `yarn worker`, with the same .env as the API
 * (database, Redis, Spaces) and ffmpeg installed. Run it on a droplet sized
 * for encoding and set VIDEO_WORKER=off on the API, so long encodes never
 * slow the site. A stop lets the encode in hand finish first; one cut short
 * (the process killed) is started again by the next worker that's free.
 */
if (!isConfigured()) {
    console.error('No Spaces bucket set up (SPACES_* in .env), so there is nothing to encode.');
    process.exit(1);
}

startVideoWorker({ encode: encodeAsset, onGiveUp: giveUp });
console.info(`Encode worker started (${env.NODE_ENV})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        console.log(`Received ${signal}, stopping the encode worker...`);
        await stopVideoWorker();
        await prisma.$disconnect();
        process.exit(0);
    });
}
