import { endSessionByToken } from '../../../services/auth/sessions.mjs';
import { refreshStaff, signInStaff } from '../../../services/auth/staff.mjs';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../../../utils/cookies.mjs';

/**
 * The Studio door (admin realm). The access token goes in the body and the
 * client holds it in memory; the refresh token only ever travels in the
 * a360_rt_staff cookie.
 */

const signedIn = (res, { accessToken, expiresIn, refreshToken, expiresAt, admin }) => {
    // A refresh in the grace window has no new token: the cookie already holds the newest one.
    if (refreshToken) setRefreshCookie(res, 'admin', refreshToken, expiresAt);
    res.json({ data: { accessToken, expiresIn, admin } });
};

/** POST /auth/studio/login */
export const login = async (req, res) => {
    signedIn(res, await signInStaff(req.body, { userAgent: req.get('User-Agent') }));
};

/** POST /auth/studio/refresh: how the Studio stays signed in across reloads and expired access tokens. */
export const refresh = async (req, res) => {
    const token = readRefreshCookie(req, 'admin');
    try {
        signedIn(res, await refreshStaff(token));
    } catch (error) {
        clearRefreshCookie(res, 'admin');
        throw error;
    }
};

/** POST /auth/studio/logout: always succeeds, and always clears the cookie. */
export const logout = async (req, res) => {
    const token = readRefreshCookie(req, 'admin');
    if (token) await endSessionByToken('admin', token);
    clearRefreshCookie(res, 'admin');
    res.status(204).end();
};

/** GET /auth/studio/me */
export const me = (req, res) => {
    res.json({ data: req.admin });
};
