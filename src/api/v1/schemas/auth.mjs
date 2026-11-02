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
