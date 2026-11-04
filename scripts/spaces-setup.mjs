/**
 * Gets the Spaces bucket ready for streaming, once (and again whenever the
 * sites' addresses change). Reads SPACES_* from .env.
 *
 *   yarn spaces:setup
 *
 * - CORS: the Studio's pages may PUT upload parts straight to the bucket, and
 *   any site may GET the public pieces (hls.js fetches them with CORS). The
 *   Studio's rule allows GET too: Spaces answers a site with the first rule
 *   naming it, so without GET there the Studio's Preview can't play.
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
                { AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedOrigins: studioOrigins, AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
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
    if (error.name === 'AccessDenied') {
        // A key limited to one bucket may use its files but not change its settings.
        console.error('Spaces said no: this key may not change bucket settings (a "Limited Access" key can\'t).');
        console.error('Either set CORS in the control panel (bucket > Settings > CORS Configurations), or run this once');
        console.error('with a Full Access key in SPACES_KEY / SPACES_SECRET, then switch back and delete that key.');
        process.exit(1);
    }
    console.error('Spaces said no:', error.name, error.message);
    process.exit(1);
}
