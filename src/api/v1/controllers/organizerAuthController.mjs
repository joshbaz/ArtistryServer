import { endSessionByToken } from '../../../services/auth/sessions.mjs';
import * as accounts from '../../../services/organisers/accounts.mjs';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../../../utils/cookies.mjs';

/**
 * The organiser's door (organizer realm), shaped like the Studio's: the
 * access token in the body, the refresh token only in the a360_rt_organizer cookie.
 */

const signedIn = (res, { accessToken, expiresIn, refreshToken, expiresAt, organizer }) => {
    // A refresh in the grace window has no new token: the cookie already holds the newest one.
    if (refreshToken) setRefreshCookie(res, 'organizer', refreshToken, expiresAt);
    res.json({ data: { accessToken, expiresIn, organizer } });
};

const device = (req) => ({ userAgent: req.get('User-Agent') });

/** POST /auth/organizer/login */
export const login = async (req, res) => {
    signedIn(res, await accounts.signInOrganizer(req.body, device(req)));
};

/** POST /auth/organizer/refresh */
export const refresh = async (req, res) => {
    try {
        signedIn(res, await accounts.refreshOrganizer(readRefreshCookie(req, 'organizer')));
    } catch (error) {
        clearRefreshCookie(res, 'organizer');
        throw error;
    }
};

/** POST /auth/organizer/logout: always succeeds, and always clears the cookie. */
export const logout = async (req, res) => {
    const token = readRefreshCookie(req, 'organizer');
    if (token) await endSessionByToken('organizer', token);
    clearRefreshCookie(res, 'organizer');
    res.status(204).end();
};

/** GET /auth/organizer/me */
export const me = (req, res) => {
    res.json({ data: accounts.toOrganizerUser(req.organizer) });
};

/** GET /auth/organizer/invite/:token → { orgName, contactName, email } */
export const readInvite = async (req, res) => {
    res.json({ data: await accounts.readInvite(req.params.token) });
};

/** POST /auth/organizer/invite/:token { contactName, password }: sets the password and signs in. */
export const acceptInvite = async (req, res) => {
    signedIn(res, await accounts.acceptInvite(req.params.token, req.body, device(req)));
};
