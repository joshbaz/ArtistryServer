import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { verifyIdToken } from './providers.mjs';
import { refreshSession, revokeAllSessions, startSession } from './sessions.mjs';

/**
 * Member accounts (member realm). For now a member is a voter who signed in
 * with Google or Apple from the vote window; the stream site and the app
 * reuse the same accounts later. Nobody picks a password here: the provider
 * vouches for them, and their account is found by the provider's own id.
 */

const suspended = () => new AppError('This account has been suspended. Contact The Artistry360 team.', 403, { code: 'ACCOUNT_SUSPENDED' });

/** The signed-in member, as their own session sees itself. */
export const toMemberUser = ({ id, name, email, avatar, lastSignInWith }) => ({
    id,
    name,
    email: email ?? '',
    avatar,
    provider: lastSignInWith ?? undefined,
    role: 'member',
});

/**
 * The member a verified provider identity belongs to: the one already linked
 * to it; otherwise the member with the same verified email (signing in with
 * Apple after Google, say), which is then linked; otherwise a new member.
 */
const memberFor = async (who) => {
    const identity = await prisma.memberIdentity.findUnique({ where: { provider_subject: { provider: who.provider, subject: who.subject } } });
    if (identity) return prisma.member.findUnique({ where: { id: identity.memberId } });

    // Only a verified email may join an existing account, or anyone could claim one by typing it.
    const sameEmail = who.email && who.emailVerified
        ? await prisma.member.findFirst({ where: { email: who.email, emailVerified: true }, orderBy: { createdAt: 'asc' } })
        : null;
    const member = sameEmail ?? await prisma.member.create({
        data: { name: who.name, email: who.email, emailVerified: who.emailVerified, avatar: who.picture },
    });
    try {
        await prisma.memberIdentity.create({ data: { memberId: member.id, provider: who.provider, subject: who.subject, email: who.email } });
    } catch (error) {
        // Two first sign-ins at once: the other one linked it first. Use its member, drop ours if we made one.
        if (error?.code !== 'P2002') throw error;
        if (!sameEmail) await prisma.member.delete({ where: { id: member.id } });
        const linked = await prisma.memberIdentity.findUnique({ where: { provider_subject: { provider: who.provider, subject: who.subject } } });
        return prisma.member.findUnique({ where: { id: linked.memberId } });
    }
    return member;
};

/**
 * Sign in with a provider's ID token. Apple gives the name only on the very
 * first sign-in, and only to the page, so the page passes it along.
 * @param {'google' | 'apple'} provider
 * @param {{ idToken: string, name?: string }} body
 * @param {{ client?: 'web' | 'mobile', userAgent?: string }} device
 */
export const signInWithProvider = async (provider, { idToken, name }, { client, userAgent } = {}) => {
    const who = await verifyIdToken(provider, idToken);
    if (!who.name && name) who.name = name;
    const found = await memberFor(who);
    if (found.status !== 'active') throw suspended();

    const member = await prisma.member.update({
        where: { id: found.id },
        data: {
            lastSignInWith: provider,
            lastSignInAt: new Date(),
            // Fill in what was missing; never overwrite what the member already has.
            ...(!found.name && who.name ? { name: who.name } : {}),
            ...(!found.avatar && who.picture ? { avatar: who.picture } : {}),
            ...(!found.email && who.email ? { email: who.email, emailVerified: who.emailVerified } : {}),
        },
    });
    const session = await startSession({ realm: 'member', subjectId: member.id, client, userAgent });
    return { ...session, member: toMemberUser(member) };
};

/** The member behind a token, if they may still sign in. */
export const findActiveMember = async (id) => {
    const row = await prisma.member.findUnique({ where: { id } });
    return row?.status === 'active' ? row : null;
};

export const refreshMember = async (refreshToken) => {
    const session = await refreshSession('member', refreshToken);
    const row = await findActiveMember(session.subjectId);
    if (!row) {
        await revokeAllSessions('member', session.subjectId, { reason: 'suspended' });
        throw suspended();
    }
    return { ...session, member: toMemberUser(row) };
};
