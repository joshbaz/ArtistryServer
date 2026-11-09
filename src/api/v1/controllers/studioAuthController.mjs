import { endSessionByToken } from '../../../services/auth/sessions.mjs';
import * as staff from '../../../services/auth/staff.mjs';
import * as notifications from '../../../services/studio/notifications.mjs';
import * as team from '../../../services/studio/team.mjs';
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
    signedIn(res, await staff.signInStaff(req.body, { userAgent: req.get('User-Agent') }));
};

/** POST /auth/studio/refresh: how the Studio stays signed in across reloads and expired access tokens. */
export const refresh = async (req, res) => {
    const token = readRefreshCookie(req, 'admin');
    try {
        signedIn(res, await staff.refreshStaff(token));
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

/* My account (Studio › Settings) */

/** PATCH /auth/studio/me */
export const updateMe = async (req, res) => res.json({ data: await staff.updateOwnProfile(req.admin.id, req.body) });

/** POST /auth/studio/password: this device stays signed in. */
export const changePassword = async (req, res) => res.json({ data: await staff.changeOwnPassword(req.admin.id, req.body, { sessionId: req.sessionId }) });

export const listSessions = async (req, res) => res.json({ data: await staff.listOwnSessions(req.admin.id, req.sessionId) });
export const endSession = async (req, res) => {
    await staff.endOwnSession(req.admin.id, req.params.sessionId, req.sessionId);
    res.status(204).end();
};
export const endOtherSessions = async (req, res) => res.json({ data: await staff.endOtherSessions(req.admin.id, req.sessionId) });

export const getNotifications = async (req, res) => res.json({ data: notifications.notificationSettings(await staff.findActiveStaff(req.admin.id)) });
export const setNotifications = async (req, res) => res.json({ data: await notifications.setNotifications(req.admin.id, req.body.events) });

/* The bell */
export const getInbox = async (req, res) => res.json({ data: await notifications.listInbox(req.admin.id) });
export const readInbox = async (req, res) => res.json({ data: await notifications.markInboxRead(req.admin.id, req.body.ids) });

/* The set-password link from Team (public) */

/** GET /auth/studio/invite/:token */
export const readLink = async (req, res) => res.json({ data: await team.readLink(req.params.token) });

/** POST /auth/studio/invite/:token: sets the password and signs in. */
export const acceptLink = async (req, res) => {
    signedIn(res, await team.acceptLink(req.params.token, req.body, { userAgent: req.get('User-Agent') }));
};

/* Team (Super Admin) */

export const listTeam = async (req, res) => res.json({ data: await team.listTeam() });
export const inviteMember = async (req, res) => res.status(201).json({ data: await team.inviteMember(req.body, req.admin) });
export const sendLink = async (req, res) => res.json({ data: await team.sendLink(req.params.id, req.admin) });
export const updateMember = async (req, res) => res.json({ data: await team.updateMember(req.params.id, req.body, req.admin) });
export const removeInvite = async (req, res) => {
    await team.removeInvite(req.params.id);
    res.status(204).end();
};
