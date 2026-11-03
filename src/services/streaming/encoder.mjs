import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { UnrecoverableError } from 'bullmq';
import { env } from '../../env.mjs';
import prisma from '../../utils/db.mjs';
import * as spaces from '../storage/spaces.mjs';
import { setSlot } from './titles.mjs';
import { assetPrefix, discardAssets } from './assets.mjs';

/**
 * Turns an uploaded original into HLS with ffmpeg: up to four sizes (1080p
 * down to 360p, never above the source) in 6-second pieces, so players switch
 * size as the connection changes. One read of the original makes them all.
 *
 * A film or episode is locked with AES-128: the pieces are public on the CDN
 * but useless without the key, which playback.mjs hands only to viewers
 * allowed to watch. A trailer is left open, with a public playlist the stream
 * site's hero plays straight from the CDN.
 *
 *   videos/<asset>/master.m3u8, <size>/index.m3u8, <size>/seg_00000.ts, thumb.jpg
 */

const LADDER = [
    { name: '1080p', height: 1080, bitrate: 5000 },
    { name: '720p', height: 720, bitrate: 2800 },
    { name: '480p', height: 480, bitrate: 1400 },
    { name: '360p', height: 360, bitrate: 800 },
];
const SEGMENT_SECONDS = 6;
const UPLOAD_CONCURRENCY = 8;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** The sizes worth making from a source this tall (a little short of 1080 still counts as 1080). */
export const pickLadder = (height) => {
    const fits = LADDER.filter((r) => r.height <= height * 1.05);
    return fits.length ? fits : [{ name: `${even(height)}p`, height: even(height), bitrate: 600 }];
};

// ffmpeg outlives a Node process that exits without asking it to stop; this asks.
const children = new Set();
process.once('exit', () => children.forEach((child) => child.kill('SIGKILL')));

const run = (cmd, args, { onLine } = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        child.on('close', () => children.delete(child));
        let out = '';
        let err = '';
        let pending = '';
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (!onLine) {
                out += text;
                return;
            }
            pending += text;
            const lines = pending.split('\n');
            pending = lines.pop();
            lines.forEach(onLine);
        });
        child.stderr.on('data', (chunk) => {
            err = (err + chunk.toString()).slice(-4000);
        });
        child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error(`${cmd} isn't installed on this server`) : error));
        // ffmpeg names its input, which is a signed link; that stays out of messages and logs.
        const said = () => err.replace(/\?X-Amz-[^\s:]+/g, '').trim().split('\n').slice(-3).join(' ');
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(said() || `${cmd} stopped (${code})`))));
    });

/** Length, picture size and whether there's sound. A file with no picture can't be fixed by trying again. */
const probe = async (src) => {
    let info;
    try {
        info = JSON.parse(await run(env.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', src]));
    } catch (error) {
        console.error('ffprobe:', error.message);
        throw new UnrecoverableError("That file couldn't be read as a video. Export it as an MP4 and upload it again.");
    }
    const video = info.streams?.find((s) => s.codec_type === 'video' && s.width);
    if (!video) throw new UnrecoverableError('That file has no picture in it.');
    const duration = Number(info.format?.duration) || 0;
    if (!duration) throw new UnrecoverableError("That file's length couldn't be read.");
    return { duration, width: video.width, height: video.height, hasAudio: info.streams.some((s) => s.codec_type === 'audio') };
};

const hlsArgs = ({ src, dir, ladder, hasAudio, keyInfo }) => {
    const split = `[0:v]format=yuv420p,split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')}`;
    const scales = ladder.map((r, i) => `[s${i}]scale=-2:${r.height}[v${i}]`);
    return [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1',
        '-i', src,
        '-filter_complex', [split, ...scales].join(';'),
        ...ladder.flatMap((_, i) => ['-map', `[v${i}]`, ...(hasAudio ? ['-map', '0:a:0'] : [])]),
        '-c:v', 'libx264', '-preset', env.VIDEO_ENCODE_PRESET, '-profile:v', 'high',
        ...ladder.flatMap((r, i) => [`-b:v:${i}`, `${r.bitrate}k`, `-maxrate:v:${i}`, `${Math.round(r.bitrate * 1.1)}k`, `-bufsize:v:${i}`, `${r.bitrate * 2}k`]),
        // A key frame at every piece boundary, so every size cuts in the same places.
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []),
        '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
        ...(keyInfo ? ['-hls_key_info_file', keyInfo] : []),
        '-hls_segment_filename', path.join(dir, '%v', 'seg_%05d.ts'),
        '-master_pl_name', 'master.m3u8',
        '-var_stream_map', ladder.map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(' '),
        path.join(dir, '%v', 'index.m3u8'),
    ];
};

const walk = async (dir, base = dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])));
    return files.flat();
};

const TYPES = { '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl', '.jpg': 'image/jpeg' };

/** Sends the encode to Spaces. Pieces and the thumbnail are public; a locked video's playlists are not. */
const publish = async (dir, prefix, { open }) => {
    const files = await walk(dir);
    for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
        await Promise.all(files.slice(i, i + UPLOAD_CONCURRENCY).map((rel) => {
            const ext = path.extname(rel);
            const playlist = ext === '.m3u8';
            return spaces.putFile(`${prefix}${rel.split(path.sep).join('/')}`, path.join(dir, rel), {
                contentType: TYPES[ext] ?? 'application/octet-stream',
                cacheControl: playlist ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
                isPublic: !playlist || open,
            });
        }));
    }
};

/** Encodes one asset, start to finish. Safe to run again: a ready one is left alone. */
export const encodeAsset = async (id, { onProgress } = {}) => {
    const asset = await prisma.videoAsset.findUnique({ where: { id } });
    if (!asset || asset.status === 'ready' || asset.status === 'cancelled') return;
    const trailer = asset.kind === 'trailer';
    const target = { titleId: asset.titleId, episodeId: asset.episodeId, kind: asset.kind };

    const work = await fs.mkdtemp(path.join(env.VIDEO_WORK_DIR ?? os.tmpdir(), `a360-${id}-`));
    const out = path.join(work, 'out');
    try {
        const src = await spaces.signGet(asset.originalKey);
        const source = await probe(src);
        const ladder = pickLadder(source.height);

        let keyInfo = null;
        const key = trailer ? null : crypto.randomBytes(16);
        if (key) {
            // The key stays off Spaces: it's in the database, and playback serves it.
            await fs.writeFile(path.join(work, 'key.bin'), key);
            keyInfo = path.join(work, 'key.info');
            await fs.writeFile(keyInfo, `../key\n${path.join(work, 'key.bin')}\n${crypto.randomBytes(16).toString('hex')}\n`);
        }

        await fs.mkdir(out);
        let reported = 0;
        await run(env.FFMPEG_PATH, hlsArgs({ src, dir: out, ladder, hasAudio: source.hasAudio, keyInfo }), {
            onLine: (line) => {
                const us = /^out_time_us=(\d+)/.exec(line)?.[1];
                if (!us) return;
                const pct = Math.min(99, Math.floor((Number(us) / 1e6 / source.duration) * 100));
                if (pct < reported + 2) return;
                reported = pct;
                onProgress?.(pct);
                prisma.videoAsset.update({ where: { id }, data: { progress: pct } }).catch(() => {});
            },
        });
        await run(env.FFMPEG_PATH, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', String(Math.min(10, source.duration * 0.1)), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', path.join(out, 'thumb.jpg')]).catch(() => {});

        // Removed while it was encoding: don't send anything.
        if (!(await prisma.videoAsset.findUnique({ where: { id }, select: { id: true } }))) return;

        const prefix = assetPrefix(id);
        await publish(out, prefix, { open: trailer });

        const done = { duration: source.duration, width: source.width, height: source.height, renditions: ladder, keyHex: key?.toString('hex') ?? null, progress: 100, error: null };
        const { count } = await prisma.videoAsset.updateMany({ where: { id }, data: { ...done, status: 'ready' } });
        const video = {
            status: 'ready',
            assetId: id,
            fileName: asset.fileName,
            size: asset.size,
            duration: Math.round(source.duration),
            width: source.width,
            height: source.height,
            thumbnail: spaces.cdnUrl(`${prefix}thumb.jpg`),
            ...(trailer ? { playbackUrl: spaces.cdnUrl(`${prefix}master.m3u8`) } : {}),
        };
        const applied = count && (await setSlot(target, video, { onlyIf: id }).then((r) => r.applied, () => false));
        // Replaced or removed while encoding: this one isn't wanted.
        if (!applied) await discardAssets([id]);
    } finally {
        await fs.rm(work, { recursive: true, force: true });
    }
};

/** The last try failed: say why on the title, for whoever uploaded it. */
export const giveUp = async (id, error) => {
    const asset = await prisma.videoAsset.findUnique({ where: { id } });
    if (!asset) return;
    const message = error?.name === 'UnrecoverableError' ? error.message : "The video couldn't be converted. Try uploading it again.";
    await prisma.videoAsset.update({ where: { id }, data: { status: 'failed', error: message } });
    await setSlot({ titleId: asset.titleId, episodeId: asset.episodeId, kind: asset.kind }, { status: 'failed', assetId: id, fileName: asset.fileName, size: asset.size, error: message }, { onlyIf: id }).catch(() => {});
};
