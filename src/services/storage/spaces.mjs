import fs from 'fs';
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * DigitalOcean Spaces, through its S3 API: where the streaming videos live.
 * The Studio sends originals straight to the bucket in parts, with links this
 * module signs, so gigabytes never pass through the API. The encoder writes
 * the HLS versions back beside them; viewers fetch the pieces from the CDN.
 *
 * Objects are private unless written `public`: originals and the playlists of
 * paid videos stay private, encrypted pieces and trailers are public.
 */

export const isConfigured = () => Boolean(env.SPACES_KEY && env.SPACES_SECRET && env.SPACES_BUCKET && (env.SPACES_REGION || env.SPACES_ENDPOINT));

const notConnected = () => new AppError("Video uploads aren't connected yet. The rest of the title saves as normal.", 503, { code: 'uploads_not_connected' });

let client;
const s3 = () => {
    if (!isConfigured()) throw notConnected();
    client ??= new S3Client({
        // Spaces signs as us-east-1 whatever the bucket's region; the endpoint picks the region.
        region: 'us-east-1',
        endpoint: env.SPACES_ENDPOINT ?? `https://${env.SPACES_REGION}.digitaloceanspaces.com`,
        forcePathStyle: Boolean(env.SPACES_ENDPOINT),
        credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET },
        // Spaces doesn't take the SDK's newer default checksums.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return client;
};

const Bucket = () => env.SPACES_BUCKET;

/** Where a public object is served from. */
export const cdnUrl = (key) => {
    const base = env.SPACES_CDN_URL ?? (env.SPACES_ENDPOINT ? `${env.SPACES_ENDPOINT}/${env.SPACES_BUCKET}` : `https://${env.SPACES_BUCKET}.${env.SPACES_REGION}.cdn.digitaloceanspaces.com`);
    return `${base.replace(/\/$/, '')}/${key}`;
};

/* Multipart uploads, signed for the browser */

export const startMultipart = async (key, contentType) =>
    (await s3().send(new CreateMultipartUploadCommand({ Bucket: Bucket(), Key: key, ContentType: contentType }))).UploadId;

/** A link the browser PUTs one part to. */
export const signPart = (key, uploadId, partNumber, expiresIn = 3600) =>
    getSignedUrl(s3(), new UploadPartCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });

/** Every part that arrived, as Spaces has it (the browser's word isn't needed). */
export const listParts = async (key, uploadId) => {
    const parts = [];
    let marker;
    do {
        const page = await s3().send(new ListPartsCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker }));
        parts.push(...(page.Parts ?? []).map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size })));
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
};

export const completeMultipart = (key, uploadId, parts) =>
    s3().send(new CompleteMultipartUploadCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) } }));

export const abortMultipart = (key, uploadId) => s3().send(new AbortMultipartUploadCommand({ Bucket: Bucket(), Key: key, UploadId: uploadId }));

/* Objects */

/** A time-limited link to read a private object (ffmpeg reads originals this way). */
export const signGet = (key, expiresIn = 12 * 3600) => getSignedUrl(s3(), new GetObjectCommand({ Bucket: Bucket(), Key: key }), { expiresIn });

export const putFile = (key, filePath, { contentType, cacheControl, isPublic = false }) =>
    s3().send(new PutObjectCommand({
        Bucket: Bucket(),
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: fs.statSync(filePath).size,
        ContentType: contentType,
        CacheControl: cacheControl,
        ...(isPublic ? { ACL: 'public-read' } : {}),
    }));

/** Writes a small file from memory (an image, a captions file). */
export const putBuffer = (key, body, { contentType, cacheControl, isPublic = false }) =>
    s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: body, ContentLength: body.length, ContentType: contentType, CacheControl: cacheControl, ...(isPublic ? { ACL: 'public-read' } : {}) }));

/** The key behind one of our public links, or null for anything else. */
export const keyOf = (url) => {
    if (typeof url !== 'string' || !isConfigured()) return null;
    const base = cdnUrl('');
    return url.startsWith(base) ? url.slice(base.length) : null;
};

export const deleteKeys = async (keys) => {
    for (let i = 0; i < keys.length; i += 1000) {
        await s3().send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
};

export const getText = async (key) => (await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }))).Body.transformToString();

/** Deletes everything under a prefix, a thousand at a time. */
export const deletePrefix = async (prefix) => {
    let token;
    do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
        if (keys.length) await s3().send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: keys, Quiet: true } }));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
};

/** The raw client, for the setup script (CORS, lifecycle). */
export const spacesClient = () => s3();
