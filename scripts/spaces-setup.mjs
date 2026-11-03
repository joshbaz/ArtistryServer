/**
 * Gets the Spaces bucket ready for streaming, once (and again whenever the
 * sites' addresses change). Reads SPACES_* from .env.
 *
 *   yarn spaces:setup
 *
 * - CORS: the Studio's pages may PUT upload parts straight to the bucket, and
 *   any site may GET the public pieces (hls.js fetches them with CORS).
 * - Lifecycle: an upload nobody finished is deleted after 2 days, so stray
 *   parts never sit in the bucket costing money.
 */
import { GetBucketCorsCommand, PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.mjs';
import { corsOptions } from '../src/utils/corsOptions.js';
import { isConfigured, spacesClient } from '../src/services/storage/spaces.mjs';

if (!isConfigured()) {
    console.error('Set SPACES_REGION, SPACES_BUCKET, SPACES_KEY and SPACES_SECRET in .env first.');
    process.exit(1);
}

const s3 = spacesClient();
const Bucket = env.SPACES_BUCKET;
const studioOrigins = [...new Set([...corsOptions.origin, env.APP_URL])];

try {
    await s3.send(new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
            CORSRules: [
                { AllowedMethods: ['PUT'], AllowedOrigins: studioOrigins, AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
                { AllowedMethods: ['GET', 'HEAD'], AllowedOrigins: ['*'], AllowedHeaders: ['*'], MaxAgeSeconds: 86400 },
            ],
        },
    }));
    const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket }));
    console.log(`CORS set on ${Bucket}: uploads from ${studioOrigins.length} sites, playback from anywhere (${CORSRules.length} rules).`);

    await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket,
        LifecycleConfiguration: {
            Rules: [{ ID: 'abandoned-uploads', Status: 'Enabled', Filter: { Prefix: 'originals/' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }],
        },
    }));
    console.log('Unfinished uploads are deleted after 2 days.');
} catch (error) {
    console.error('Spaces said no:', error.name, error.message);
    process.exit(1);
}
