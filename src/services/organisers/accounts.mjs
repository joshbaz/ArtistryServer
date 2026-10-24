import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { hashToken } from '../../utils/tokens.mjs';
import { invalidateSite } from '../../utils/sockets.js';
import { hashPassword, verifyPassword } from '../auth/passwords.mjs';
import { refreshSession, revokeAllSessions, startSession } from '../auth/sessions.mjs';

/**
 * Organiser accounts (organizer realm). Nobody signs up: a Super Admin makes
 * the account from an approved request and sends an invite link, which sets
 * the password. A fresh invite is also how a forgotten password is reset.
 * Only the invite's hash is stored; the link is shown once, to the Studio.
 */

const INVITE_DAYS = 7;
export const MIN_ORGANIZER_PASSWORD = 8;

const wrongDetails = () => new AppError('Email or password is incorrect.', 401, { code: 'INVALID_CREDENTIALS' });
const turnedOff = () => new AppError('Your access has been turned off. Contact The Artistry360 team.', 403, { code: 'ACCOUNT_DISABLED' });
const inviteGone = (message) => new AppError(message, 410, { code: 'INVITE_INVALID' });

/** The signed-in organiser, as their own session sees itself. */
export const toOrganizerUser = ({ id, orgName, contactName, email }) => ({ id, orgName, contactName, email, role: 'organizer' });

/** The account as the organiser's profile page shows it: no password, no invite. */
export const toProfile = ({ id, orgName, contactName, email, phone, status, sharePercent, logo, createdAt }) => ({
    id, orgName, contactName, email, phone, status, sharePercent, logo, invite: null, createdAt: createdAt.toISOString(),
});

/** When the current invite runs out, for the Studio. Never the link itself. */
export const inviteOf = (o) => (o.inviteExpiresAt ? { expiresAt: o.inviteExpiresAt.toISOString(), usedAt: o.inviteUsedAt?.toISOString() ?? null } : null);

export const normalEmail = (email) => String(email).trim().toLowerCase();

/**
 * Start a new invite; the old link stops working. Returns the raw token for
 * the Studio's invite panel: it is never stored or shown again.
 * @param {string} organizerId
 */
export const issueInvite = async (organizerId) => {
    const token = crypto.randomBytes(24).toString('base64url');
    await prisma.organizer.update({
        where: { id: organizerId },
        data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000), inviteUsedAt: null },
    });
    return token;
};

/** The organiser an invite link belongs to, if it can still be used. */
const liveInvite = async (token) => {
    const row = token ? await prisma.organizer.findFirst({ where: { inviteTokenHash: hashToken(token) } }) : null;
    if (!row || row.inviteUsedAt) throw inviteGone("This invite link has already been used or isn't valid. Ask The Artistry360 team for a new one.");
    if (!row.inviteExpiresAt || row.inviteExpiresAt < new Date()) throw inviteGone('This invite link has expired. Ask The Artistry360 team for a new one.');
    return row;
};

/** Who an invite is for, so the page can greet them. */
export const readInvite = async (token) => {
    const { orgName, contactName, email } = await liveInvite(token);
    return { orgName, contactName, email };
};

/**
 * Accept an invite: set the password (and the contact name), and sign in.
 * Single use. Accepting a reset invite signs out every other session.
 */
export const acceptInvite = async (token, { contactName, password }, { userAgent } = {}) => {
    const row = await liveInvite(token);
    const updated = await prisma.organizer.update({
        where: { id: row.id },
        data: {
            passwordHash: await hashPassword(password),
            contactName: contactName || row.contactName,
            status: row.status === 'disabled' ? 'disabled' : 'active',
            inviteTokenHash: null,
            inviteUsedAt: new Date(),
        },
    });
    await revokeAllSessions('organizer', row.id, { reason: 'password_changed' });
    if (updated.status === 'disabled') throw turnedOff();
    const session = await startSession({ realm: 'organizer', subjectId: row.id, userAgent });
    return { ...session, organizer: toOrganizerUser(updated) };
};

export const signInOrganizer = async ({ email, password }, { userAgent } = {}) => {
    const row = await prisma.organizer.findUnique({ where: { email: normalEmail(email) }, omit: { passwordHash: false } });
    // Runs even with no account or no password yet, so timing doesn't reveal which emails exist.
    const ok = await verifyPassword(row?.passwordHash, password);
    if (!row || !ok) throw wrongDetails();
    if (row.status !== 'active') throw turnedOff();
    const session = await startSession({ realm: 'organizer', subjectId: row.id, userAgent });
    return { ...session, organizer: toOrganizerUser(row) };
};

/** The organiser behind a token, if they may still use /organizer. */
export const findActiveOrganizer = async (id) => {
    const row = await prisma.organizer.findUnique({ where: { id } });
    return row?.status === 'active' ? row : null;
};

export const refreshOrganizer = async (refreshToken) => {
    const session = await refreshSession('organizer', refreshToken);
    const row = await findActiveOrganizer(session.subjectId);
    if (!row) {
        await revokeAllSessions('organizer', session.subjectId, { reason: 'suspended' });
        throw turnedOff();
    }
    return { ...session, organizer: toOrganizerUser(row) };
};

/** Contact name, phone and logo are theirs to keep current; the organisation's name is the Studio's. */
export const updateProfile = async (id, patch) => {
    const row = await prisma.organizer.update({ where: { id }, data: patch });
    // A campaign without its own logo shows this one.
    if (patch.logo !== undefined) invalidateSite('campaigns');
    return toProfile(row);
};

export const getProfile = async (id) => toProfile(await prisma.organizer.findUniqueOrThrow({ where: { id } }));

/** Change the password; every other session is signed out. */
export const changePassword = async (id, sessionId, { current, next }) => {
    const row = await prisma.organizer.findUnique({ where: { id }, omit: { passwordHash: false } });
    if (!(await verifyPassword(row?.passwordHash, current))) throw new AppError("Your current password isn't right.", 403, { code: 'WRONG_PASSWORD' });
    if (next === current) throw new AppError('Choose a password different from your current one.', 422);
    await prisma.organizer.update({ where: { id }, data: { passwordHash: await hashPassword(next) } });
    await revokeAllSessions('organizer', id, { reason: 'password_changed', except: sessionId });
};
