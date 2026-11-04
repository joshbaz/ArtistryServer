import { z } from 'zod';
import { text } from './common.mjs';

/** POST /auth/google, /auth/apple: the ID token the provider gave the page or the app. */
export const idTokenBody = z.object({
    idToken: z.string().min(20, 'Sign-in didn’t go through. Please try again.').max(8000),
    // Apple only: the name it shows the page on the very first sign-in.
    name: text(120).optional(),
});

/** POST /auth/refresh, /auth/logout from the app, which holds its refresh token itself. */
export const refreshBody = z.object({ refreshToken: z.string().max(200).optional() }).optional();

/** PATCH /auth/me: the name other members see on comments. */
export const profileBody = z.object({ name: text(60).pipe(z.string().min(1, 'Enter your name.')) });

/** POST /auth/me/delete: typed out, so it never happens by accident. */
export const deleteAccountBody = z.object({ confirm: z.string().trim().toUpperCase().refine((v) => v === 'DELETE', 'Type DELETE to confirm.') });

/** DELETE /auth/sessions/:sessionId */
export const sessionParam = z.object({ sessionId: z.string().regex(/^[a-f0-9]{24}$/i, 'We could not find that.') });
