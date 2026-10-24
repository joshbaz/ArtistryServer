import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis } from './redis.mjs';
import { corsOptions } from './corsOptions.js';
import { verifyAccessToken } from './tokens.mjs';

let io = null;

/**
 * Live updates over Socket.IO, in three namespaces (17-api-server.md, section 8):
 * `/public` for anyone, `/member` for signed-in members (each also in their own
 * `member:<id>` room) and `/admin` for the Studio. The only event is
 * `invalidate { entity, id? }`: it names what changed and never carries data,
 * so clients refetch through the normal, access-checked routes.
 * The Redis adapter carries each event to every process.
 * @param {import('http').Server} server
 * @param {import('express').Application} app
 * @returns {Promise<Server>}
 */
export const setupSocketIO = async (server, app) => {
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    // Without a listener, a Redis outage would crash the process; the main client already logs it.
    for (const client of [pub, sub]) client.on('error', () => {});
    await Promise.all([pub.connect(), sub.connect()]);
    io = new Server(server, {
        cors: { origin: corsOptions.origin, credentials: corsOptions.credentials },
        adapter: createAdapter(pub, sub),
    });

    io.of('/public');

    // The token is checked once, when the socket connects; a bad or expired one is a connect_error and the client reconnects with a fresh one.
    for (const realm of ['member', 'admin']) {
        const nsp = io.of(`/${realm}`);
        nsp.use((socket, next) => {
            const payload = verifyAccessToken(socket.handshake.auth?.token ?? '');
            if (payload?.realm !== realm) return next(new Error('Sign in first.'));
            socket.data.id = payload.id;
            next();
        });
        nsp.on('connection', (socket) => {
            if (realm === 'member') socket.join(`member:${socket.data.id}`);
        });
    }

    app.set('io', io);
    return io;
};

const DEBOUNCE_MS = 250;
const pending = new Map();

/**
 * Tell a namespace's clients that `entity` changed. Call it after the write
 * commits, never before. Identical events within 250 ms go out once, so a bulk
 * edit doesn't fan out a hundred refetches. Does nothing before start-up.
 * @param {'public' | 'member' | 'admin'} namespace
 * @param {string[]} entity - e.g. ['site', 'titles']
 * @param {{ id?: string, room?: string }} [options]
 */
export const invalidate = (namespace, entity, { id, room } = {}) => {
    if (!io) return;
    const key = `${namespace}|${room ?? ''}|${entity.join('/')}`;
    if (pending.has(key)) return;
    pending.set(key, setTimeout(() => {
        pending.delete(key);
        const target = room ? io.of(`/${namespace}`).to(room) : io.of(`/${namespace}`);
        target.emit('invalidate', { entity, id });
    }, DEBOUNCE_MS));
};

/** A change every visitor sees: goes to `/public` and `/member` as ['site', ...], and to `/admin` as ['admin', ...]. */
export const invalidateSite = (module, { id } = {}) => {
    invalidate('public', ['site', module], { id });
    invalidate('member', ['site', module], { id });
    invalidate('admin', ['admin', module], { id });
};

/** A change to one member's own library, progress or purchases, on every device they're signed in on. */
export const invalidateMember = (memberId, { id } = {}) => {
    if (memberId) invalidate('member', ['member', memberId], { id, room: `member:${memberId}` });
};
