import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { STAFF_ROLES } from '../../utils/permissions.mjs';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.mjs';
import { deviceName, refreshSession, revokeAllSessions, startSession } from './sessions.mjs';

/**
 * Studio accounts (the admin realm): signing in, staying signed in, and
 * creating the first accounts. 2FA will slot in between checking the
 * password and starting the session.
 */

const wrongDetails = () => new AppError('Email or password is incorrect.', 401, { code: 'INVALID_CREDENTIALS' });
const turnedOff = () => new AppError('Your Studio access has been turned off. Ask a Super Admin.', 403, { code: 'ACCOUNT_SUSPENDED' });

/** A staff row as the client's AdminUser. Never the password hash. */
export const toAdminUser = ({ id, name, email, role }) => ({ id, name, email, role });

const normalEmail = (email) => String(email).trim().toLowerCase();

/**
 * Check an email and password and open a Studio session.
 * @param {{ email: string, password: string }} credentials
 * @param {{ userAgent?: string }} device
 */
export const signInStaff = async ({ email, password }, { userAgent } = {}) => {
    const staff = await prisma.staff.findUnique({ where: { email: normalEmail(email) }, omit: { passwordHash: false } });
    // verifyPassword runs even when there's no account, so timing doesn't reveal which emails exist.
    const ok = await verifyPassword(staff?.passwordHash, password);
    if (!staff || !ok) throw wrongDetails();
    if (staff.status !== 'active') throw turnedOff();

    const session = await startSession({ realm: 'admin', subjectId: staff.id, client: 'web', userAgent });
    await prisma.staff.update({ where: { id: staff.id }, data: { lastSignInAt: new Date() } });
    return { ...session, admin: toAdminUser(staff) };
};

/**
 * The staff member behind a token, if they may still use the Studio.
 * @param {string} id
 */
export const findActiveStaff = async (id) => {
    const staff = await prisma.staff.findUnique({ where: { id } });
    return staff?.status === 'active' ? staff : null;
};

/**
 * Swap the refresh cookie for a new access token. A suspended account's
 * sessions are all closed here.
 * @param {string} refreshToken
 */
export const refreshStaff = async (refreshToken) => {
    const session = await refreshSession('admin', refreshToken);
    const staff = await findActiveStaff(session.subjectId);
    if (!staff) {
        await revokeAllSessions('admin', session.subjectId, { reason: 'suspended' });
        throw turnedOff();
    }
    return { ...session, admin: toAdminUser(staff) };
};

/**
 * Create a Studio account (scripts/create-staff.mjs, and later the Team page).
 * @param {{ name: string, email: string, password: string, role: string }} input
 */
export const createStaff = async ({ name, email, password, role }) => {
    if (!STAFF_ROLES.includes(role)) throw new AppError(`Role must be one of: ${STAFF_ROLES.join(', ')}.`, 422);
    if (String(password).length < MIN_PASSWORD_LENGTH) throw new AppError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`, 422);
    const staff = await prisma.staff.create({
        data: { name: name.trim(), email: normalEmail(email), role, passwordHash: await hashPassword(password) },
    });
    return toAdminUser(staff);
};

/* My account (Studio › Settings) */

const fieldError = (field, message, status = 422) => new AppError(message, status, { details: { fieldErrors: { [field]: [message] } } });

const checkPassword = async (id, password) => {
    const row = await prisma.staff.findUnique({ where: { id }, omit: { passwordHash: false } });
    if (!(await verifyPassword(row?.passwordHash, password ?? ''))) throw fieldError('currentPassword', "That isn't your current password.", 403);
    return row;
};

const emailTaken = (error) => {
    if (error.code === 'P2002') throw fieldError('email', 'Another Studio account already uses that email.', 409);
    throw error;
};

/** Change your name, or your sign-in email (which asks for your password). */
export const updateOwnProfile = async (id, { name, email, currentPassword }) => {
    const me = await prisma.staff.findUniqueOrThrow({ where: { id } });
    const data = {};
    if (name !== undefined) data.name = name;
    if (email !== undefined && normalEmail(email) !== me.email) {
        await checkPassword(id, currentPassword);
        data.email = normalEmail(email);
    }
    if (!Object.keys(data).length) return toAdminUser(me);
    return toAdminUser(await prisma.staff.update({ where: { id }, data }).catch(emailTaken));
};

/** A new password, after the current one. Every other device is signed out; this one stays. */
export const changeOwnPassword = async (id, { currentPassword, newPassword }, { sessionId }) => {
    await checkPassword(id, currentPassword);
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw fieldError('newPassword', `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    await prisma.staff.update({ where: { id }, data: { passwordHash: await hashPassword(newPassword) } });
    const { count } = await revokeAllSessions('admin', id, { reason: 'password_changed', except: sessionId });
    return { signedOutDevices: count };
};

/** "Chrome on macOS" from a browser's user agent, as near as it can tell. */
/** Your open sessions, this device first, then most recently used. */
export const listOwnSessions = async (id, currentSessionId) => {
    const now = new Date();
    const rows = await prisma.session.findMany({ where: { realm: 'admin', subjectId: id, revokedAt: null, expiresAt: { gt: now } }, orderBy: { lastSeenAt: 'desc' } });
    return rows
        .map((s) => ({ id: s.id, device: deviceName(s.userAgent ?? ''), signedInAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), current: s.id === currentSessionId }))
        .sort((a, b) => b.current - a.current);
};

/** Sign one of your other devices out. */
export const endOwnSession = async (id, sessionId, currentSessionId) => {
    if (sessionId === currentSessionId) throw new AppError('Use Sign out to end this session.', 409);
    const { count } = await prisma.session.updateMany({ where: { id: sessionId, realm: 'admin', subjectId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'signed_out' } });
    if (!count) throw new AppError('That device is already signed out.', 404);
};

export const endOtherSessions = async (id, currentSessionId) => ({ signedOutDevices: (await revokeAllSessions('admin', id, { except: currentSessionId })).count });
