import crypto from 'crypto';
import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { hashToken } from '../../utils/tokens.mjs';
import { ROLE_LABELS, STAFF_ROLES, SUPER_ADMIN } from '../../utils/permissions.mjs';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.mjs';
import { revokeAllSessions, startSession } from '../auth/sessions.mjs';
import { toAdminUser } from '../auth/staff.mjs';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';

/**
 * Studio › Settings › Team, for a Super Admin: who has Studio access, with
 * which role. A new member gets a set-password link (emailed when Zoho is
 * set up, and shown once in the Studio to pass on by hand); the same link
 * resets a forgotten password. Links work once, for 7 days; only their hash
 * is stored.
 *
 * There's always at least one active Super Admin, and nobody changes their
 * own role or access here (that's how a Studio locks itself out).
 */

const INVITE_DAYS = 7;
const DAY = 24 * 3600 * 1000;

const notFound = () => new AppError('Team member not found.', 404);
const linkGone = () => new AppError("This link has already been used or has expired. Ask a Super Admin for a new one.", 410, { code: 'invite_gone' });

const toMember = (s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    role: s.role,
    status: s.status,
    lastSignInAt: s.lastSignInAt?.toISOString() ?? null,
    // Whether a set-password link is out and still usable.
    linkExpiresAt: s.inviteTokenHash && s.inviteExpiresAt > new Date() ? s.inviteExpiresAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
});

export const listTeam = async () => (await prisma.staff.findMany({ orderBy: [{ createdAt: 'asc' }] })).map(toMember);

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Emails the link. Never throws: the Super Admin still has it to copy. */
const emailLink = async (staff, url, { by, fresh }) => {
    if (!isMailConfigured()) return false;
    const heading = fresh ? 'You have been added to The Artistry360 Studio' : 'Set a new Studio password';
    const lines = fresh
        ? [`${by} added you to The Artistry360 Studio as ${ROLE_LABELS[staff.role]}.`, `Set your password to sign in. The link works once, within ${INVITE_DAYS} days.`]
        : [`${by} sent you a link to set a new password for The Artistry360 Studio.`, `It works once, within ${INVITE_DAYS} days. If you didn't ask for this, you can ignore it.`];
    try {
        await sendMail({
            to: staff.email,
            subject: heading,
            text: [`Hi ${staff.name},`, '', ...lines, '', `Set your password: ${url}`].join('\n'),
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">${escape(heading)}</h1>
<p>Hi ${escape(staff.name)},</p>
${lines.map((l) => `<p>${escape(l)}</p>`).join('\n')}
<p><a href="${escape(url)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Set your password</a></p>
</div>`,
        });
        return true;
    } catch (error) {
        console.error(`Studio link email to ${staff.id} failed:`, error.message);
        return false;
    }
};

/** A fresh link for someone, replacing any earlier one. */
const issueLink = async (staff, by, { fresh }) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const updated = await prisma.staff.update({ where: { id: staff.id }, data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * DAY) } });
    const link = `${env.APP_URL}/studio/invite/${token}`;
    const emailed = await emailLink(updated, link, { by: by.name, fresh });
    return { member: toMember(updated), link, emailed };
};

/** Add someone: they can't sign in until they've used their link. */
export const inviteMember = async ({ name, email, role }, by) => {
    if (!STAFF_ROLES.includes(role)) throw new AppError('Choose a role.', 422);
    const staff = await prisma.staff.create({ data: { name, email: email.trim().toLowerCase(), role, status: 'invited', passwordHash: '', invitedBy: by.id } }).catch((error) => {
        if (error.code === 'P2002') throw new AppError('Someone on the team already uses that email.', 409, { details: { fieldErrors: { email: ['Someone on the team already uses that email.'] } } });
        throw error;
    });
    return issueLink(staff, by, { fresh: true });
};

/** A new set-password link: for an invite that was lost or ran out, or a forgotten password. */
export const sendLink = async (id, by) => {
    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound();
    if (staff.status === 'suspended') throw new AppError('Restore their access first.', 409);
    return issueLink(staff, by, { fresh: staff.status === 'invited' });
};

const activeSuperAdmins = (exceptId) => prisma.staff.count({ where: { role: SUPER_ADMIN, status: 'active', id: { not: exceptId } } });

/** Change someone's role, or suspend and restore their access. */
export const updateMember = async (id, { role, status }, by) => {
    if (id === by.id) throw new AppError("You can't change your own role or access. Ask another Super Admin.", 409);
    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound();
    if (status && staff.status === 'invited') throw new AppError("They haven't set a password yet. Remove the invite instead.", 409);
    const losesSuperAdmin = staff.role === SUPER_ADMIN && staff.status === 'active' && ((role && role !== SUPER_ADMIN) || status === 'suspended');
    if (losesSuperAdmin && !(await activeSuperAdmins(id))) throw new AppError('The Studio needs at least one active Super Admin.', 409);
    const updated = await prisma.staff.update({
        where: { id },
        // A suspended account's link stops working too.
        data: { ...(role ? { role } : {}), ...(status ? { status } : {}), ...(status === 'suspended' ? { inviteTokenHash: null } : {}) },
    });
    // Signed out now rather than at their next request.
    if (status === 'suspended') await revokeAllSessions('admin', id, { reason: 'suspended' });
    return toMember(updated);
};

/** Take back an invite nobody used. People who have signed in are suspended instead, so their history keeps a name. */
export const removeInvite = async (id) => {
    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound();
    if (staff.status !== 'invited') throw new AppError('Only an unused invite can be removed. Suspend them instead.', 409);
    await prisma.staff.delete({ where: { id } });
};

/* The link itself (public) */

const liveLink = async (token) => {
    const row = token ? await prisma.staff.findFirst({ where: { inviteTokenHash: hashToken(token) } }) : null;
    if (!row || !row.inviteExpiresAt || row.inviteExpiresAt < new Date() || row.status === 'suspended') throw linkGone();
    return row;
};

/** Who a link is for, so the page can greet them. */
export const readLink = async (token) => {
    const { name, email, role, status } = await liveLink(token);
    return { name, email, role, roleLabel: ROLE_LABELS[role], fresh: status === 'invited' };
};

/** Use a link: set the password, and sign in. Any other session ends. */
export const acceptLink = async (token, { name, password }, { userAgent } = {}) => {
    const row = await liveLink(token);
    if (password.length < MIN_PASSWORD_LENGTH) throw new AppError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 422, { details: { fieldErrors: { password: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`] } } });
    // Single use: only the request that clears the hash goes on.
    const { count } = await prisma.staff.updateMany({
        where: { id: row.id, inviteTokenHash: row.inviteTokenHash },
        data: { passwordHash: await hashPassword(password), status: 'active', inviteTokenHash: null, inviteExpiresAt: null, lastSignInAt: new Date(), ...(name ? { name } : {}) },
    });
    if (!count) throw linkGone();
    await revokeAllSessions('admin', row.id, { reason: 'password_changed' });
    const session = await startSession({ realm: 'admin', subjectId: row.id, client: 'web', userAgent });
    return { ...session, admin: toAdminUser(await prisma.staff.findUnique({ where: { id: row.id } })) };
};
