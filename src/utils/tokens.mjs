import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env.mjs';

/** The two sign-in realms. A token for one never works on the other's routes. */
export const REALMS = ['member', 'admin'];

const ACCESS_TTL_SECONDS = 15 * 60;

// Each realm signs with its own secret, so even a forged `aud` can't cross over.
const SECRETS = {
    admin: env.ADMIN_TOKEN_SECRET,
    member: env.MEMBER_TOKEN_SECRET,
};

/**
 * Sign a 15-minute access token. `aud` is the realm, `sid` the session it
 * belongs to, and `client` is web or mobile.
 * @param {{ id: string, realm: 'member' | 'admin', sid: string, client?: 'web' | 'mobile' }} who
 * @returns {{ accessToken: string, expiresIn: number }}
 */
export const signAccessToken = ({ id, realm, sid, client = 'web' }) => ({
    accessToken: jwt.sign({ id, sid, client }, SECRETS[realm], { audience: realm, expiresIn: ACCESS_TTL_SECONDS, algorithm: 'HS256' }),
    expiresIn: ACCESS_TTL_SECONDS,
});

/**
 * The token's payload with its realm, or null when it is missing, expired or
 * forged. Pass `realm` to accept only that realm's tokens.
 * @param {string} token
 * @param {'member' | 'admin'} [realm]
 * @returns {{ id: string, sid: string, realm: 'member' | 'admin', client: string } | null}
 */
export const verifyAccessToken = (token, realm) => {
    if (!token) return null;
    const claimed = jwt.decode(token)?.aud;
    if (!REALMS.includes(claimed) || (realm && claimed !== realm)) return null;
    try {
        const payload = jwt.verify(token, SECRETS[claimed], { audience: claimed, algorithms: ['HS256'] });
        return { id: payload.id, sid: payload.sid, realm: claimed, client: payload.client };
    } catch {
        return null;
    }
};

/**
 * A new refresh token for a session: `<sessionId>.<secret>`. Only its hash is
 * stored, and the session id in front lets a refresh find its row directly.
 * @param {string} sessionId
 */
export const newRefreshToken = (sessionId) => `${sessionId}.${crypto.randomBytes(32).toString('base64url')}`;

/** The session id a refresh token claims, or null when it isn't shaped like one. */
export const sessionIdOf = (token) => {
    const match = /^([a-f0-9]{24})\.[\w-]{43}$/.exec(String(token ?? ''));
    return match ? match[1] : null;
};

/** Refresh tokens are long and random, so a fast hash is enough (no need for argon2). */
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Compare two hex hashes without leaking how much matched. */
export const sameHash = (a, b) => Boolean(a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)));
