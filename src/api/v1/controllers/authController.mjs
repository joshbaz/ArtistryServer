import { endSessionByToken, revokeAllSessions } from '../../../services/auth/sessions.mjs';
import * as members from '../../../services/auth/members.mjs';
import * as access from '../../../services/streaming/access.mjs';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../../../utils/cookies.mjs';

/**
 * The members' door (member realm): voters now, the stream site and the app
 * later. On the web the refresh token only travels in the a360_rt_member
 * cookie; the app (X-Client: mobile) has no cookies, so it gets the refresh
 * token in the body and sends it back the same way.
 */

const clientOf = (req) => (req.get('X-Client') === 'mobile' ? 'mobile' : 'web');

const signedIn = (req, res, { accessToken, expiresIn, refreshToken, expiresAt, member }) => {
    if (clientOf(req) === 'mobile') return res.json({ data: { accessToken, expiresIn, refreshToken, member } });
    // A refresh in the grace window has no new token: the cookie already holds the newest one.
    if (refreshToken) setRefreshCookie(res, 'member', refreshToken, expiresAt);
    res.json({ data: { accessToken, expiresIn, member } });
};

const device = (req) => ({ client: clientOf(req), userAgent: req.get('User-Agent') });

const presented = (req) => (clientOf(req) === 'mobile' ? req.body?.refreshToken : readRefreshCookie(req, 'member')) ?? null;

/** POST /auth/google { idToken } */
export const google = async (req, res) => {
    signedIn(req, res, await members.signInWithProvider('google', req.body, device(req)));
};

/** POST /auth/apple { idToken, name? } */
export const apple = async (req, res) => {
    signedIn(req, res, await members.signInWithProvider('apple', req.body, device(req)));
};

/** POST /auth/refresh */
export const refresh = async (req, res) => {
    try {
        signedIn(req, res, await members.refreshMember(presented(req)));
    } catch (error) {
        clearRefreshCookie(res, 'member');
        throw error;
    }
};

/** POST /auth/logout: always succeeds, and always clears the cookie. */
export const logout = async (req, res) => {
    const token = presented(req);
    if (token) await endSessionByToken('member', token);
    clearRefreshCookie(res, 'member');
    res.status(204).end();
};

/**
 * GET /auth/me: the member, how they sign in (`methods`), and what they may
 * watch on the stream site and in the app (`subscription`, `purchases`).
 */
export const me = async (req, res) => {
    const [methods, { subscription, purchases }] = await Promise.all([members.signInMethods(req.member.id), access.getAccess(req.member.id)]);
    res.json({ data: { ...members.toMemberUser(req.member), methods, subscription: subscription && { ...subscription, source: 'web' }, purchases } });
};

/** PATCH /auth/me { name } */
export const updateMe = async (req, res) => {
    res.json({ data: await members.updateProfile(req.member.id, req.body) });
};

/** POST /auth/sessions/revoke-all: every device signs out, this one too. */
export const revokeAll = async (req, res) => {
    await revokeAllSessions('member', req.member.id);
    clearRefreshCookie(res, 'member');
    res.status(204).end();
};

/** POST /auth/me/delete { confirm: "DELETE" } */
export const deleteMe = async (req, res) => {
    await members.deleteAccount(req.member.id);
    clearRefreshCookie(res, 'member');
    res.status(204).end();
};
