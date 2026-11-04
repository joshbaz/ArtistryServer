import { z } from 'zod';

// Matches the Studio's studioLoginSchema (client/src/StudioDashboard/pages/1.auth/schemas.js).
export const loginBody = z.object({
    email: z.string({ error: 'Enter your email address.' }).trim().min(1, 'Enter your email address.').max(254).pipe(z.email('Enter a valid email address.')),
    password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(200),
});

const email = z.string().trim().min(1, 'Enter an email address.').max(254).pipe(z.email('Enter a valid email address.'));
const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Keep it under 80 characters.');
const password = z.string().max(200);

/** PATCH /auth/studio/me: a new email needs the current password. */
export const profileBody = z.object({ name: name.optional(), email: email.optional(), currentPassword: password.optional() });

/** POST /auth/studio/password */
export const passwordBody = z.object({ currentPassword: password.min(1, 'Enter your current password.'), newPassword: password });

/** PUT /auth/studio/notifications */
export const notificationsBody = z.object({ events: z.array(z.string().max(40)).max(20) });

export const sessionParam = z.object({ sessionId: z.string().regex(/^[a-f0-9]{24}$/i, 'We could not find that.') });

/** The set-password link (Team) */
export const linkParam = z.object({ token: z.string().regex(/^[\w-]{20,64}$/, "This link isn't valid.") });
export const acceptLinkBody = z.object({ name: name.optional(), password });

/** Studio › Settings › Team */
export const inviteBody = z.object({ name, email, role: z.enum(['super-admin', 'content-manager', 'finance', 'moderator'], { error: 'Choose a role.' }) });
export const memberBody = z.object({
    role: z.enum(['super-admin', 'content-manager', 'finance', 'moderator']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
}).refine((b) => b.role || b.status, 'Nothing to change.');
