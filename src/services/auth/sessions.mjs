import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { hashToken, newRefreshToken, sameHash, sessionIdOf, signAccessToken } from '../../utils/tokens.mjs';

/**
 * Sessions for both realms: one row per signed-in device, holding the hash
 * of its current refresh token (17-api-server.md, section 5).
 *
 * Every refresh rotates the token. The one before stays valid for 30 seconds,
 * so two tabs refreshing at once don't sign each other out; that late
 * request gets a new access token and keeps the cookie the first one set.
 * After those 30 seconds, an old token can only be a stolen one, and the
 * session is revoked.
 */

const DAY = 24 * 60 * 60 * 1000;
const GRACE_MS = 30 * 1000;
// The token hashes are left out of every query by default (utils/db.mjs); these reads need them.
const WITH_HASHES = { tokenHash: false, previousHash: false };

/** How long a session lasts without use, and at most, per realm. */
const LIFETIMES = {
    admin: { idle: 7 * DAY, max: 30 * DAY },
    member: { idle: 30 * DAY, max: 180 * DAY },
};

const ended = () => new AppError('Your session has ended. Sign in again.', 401, { code: 'SESSION_ENDED' });

const issue = (session, refreshToken) => ({
    ...signAccessToken({ id: session.subjectId, realm: session.realm, sid: session.id, client: session.client }),
    refreshToken,
    subjectId: session.subjectId,
    sessionId: session.id,
    expiresAt: session.expiresAt,
});

/**
 * Open a session for someone who just signed in.
 * @param {{ realm: 'member' | 'admin', subjectId: string, client?: 'web' | 'mobile', userAgent?: string }} who
 */
export const startSession = async ({ realm, subjectId, client = 'web', userAgent }) => {
    const now = Date.now();
    const life = LIFETIMES[realm];
    // The id is made here so it can go inside the refresh token before the row is written.
    const id = crypto.randomBytes(12).toString('hex');
    const refreshToken = newRefreshToken(id);
    const session = await prisma.session.create({
        data: {
            id,
            realm,
            subjectId,
            client,
            userAgent: userAgent?.slice(0, 300) ?? null,
            tokenHash: hashToken(refreshToken),
            expiresAt: new Date(now + life.idle),
            maxExpiresAt: new Date(now + life.max),
            // Written out as null: on MongoDB, Prisma's `revokedAt: null` filter doesn't match a missing field.
            revokedAt: null,
        },
    });
    return issue(session, refreshToken);
};

/**
 * Swap a refresh token for a new access token and, normally, a new refresh
 * token. `refreshToken` is null in the grace case: keep the one already held.
 * @param {'member' | 'admin'} realm
 * @param {string} presented
 */
export const refreshSession = async (realm, presented) => {
    const id = sessionIdOf(presented);
    if (!id) throw ended();
    const session = await prisma.session.findUnique({ where: { id }, omit: WITH_HASHES });
    const now = new Date();
    if (!session || session.realm !== realm || session.revokedAt || session.expiresAt <= now) throw ended();

    const hash = hashToken(presented);

    if (sameHash(hash, session.tokenHash)) {
        const refreshToken = newRefreshToken(session.id);
        const expiresAt = new Date(Math.min(now.getTime() + LIFETIMES[realm].idle, session.maxExpiresAt.getTime()));
        // Only rotate if nobody else rotated it since we read it.
        const { count } = await prisma.session.updateMany({
            where: { id: session.id, tokenHash: session.tokenHash, revokedAt: null },
            data: { tokenHash: hashToken(refreshToken), previousHash: session.tokenHash, rotatedAt: now, lastSeenAt: now, expiresAt },
        });
        if (count === 1) return issue({ ...session, expiresAt }, refreshToken);
        // A parallel refresh won the race: treat this one like a request in the grace window.
        return issue(session, null);
    }

    if (sameHash(hash, session.previousHash)) {
        if (session.rotatedAt && now.getTime() - session.rotatedAt.getTime() <= GRACE_MS) return issue(session, null);
        await revokeSession(session.id, 'reuse');
        console.warn(`Refresh token reused on ${realm} session ${session.id}; session revoked`);
    }

    throw ended();
};

/** End one session. Quietly does nothing if it has already ended. */
export const revokeSession = (id, reason = 'signed_out') =>
    prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });

/**
 * End the session a refresh token belongs to, for signing out. Only the
 * current or previous token can do it, so a guessed id can't sign anyone out.
 * @param {'member' | 'admin'} realm
 * @param {string} presented
 */
export const endSessionByToken = async (realm, presented) => {
    const id = sessionIdOf(presented);
    if (!id) return;
    const session = await prisma.session.findUnique({ where: { id }, omit: WITH_HASHES });
    if (!session || session.realm !== realm) return;
    const hash = hashToken(presented);
    if (sameHash(hash, session.tokenHash) || sameHash(hash, session.previousHash)) await revokeSession(id);
};

/** End every session someone has in a realm, optionally keeping one (the device asking). */
export const revokeAllSessions = (realm, subjectId, { reason = 'signed_out_everywhere', except } = {}) =>
    prisma.session.updateMany({
        where: { realm, subjectId, revokedAt: null, ...(except ? { id: { not: except } } : {}) },
        data: { revokedAt: new Date(), revokedReason: reason },
    });

/** Whether a session is still open, for the auth guards. */
export const isSessionOpen = async (id) => {
    if (!id) return false;
    const session = await prisma.session.findUnique({ where: { id }, select: { revokedAt: true, expiresAt: true } });
    return Boolean(session && !session.revokedAt && session.expiresAt > new Date());
};
