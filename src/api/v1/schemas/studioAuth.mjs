import { z } from 'zod';

// Matches the Studio's studioLoginSchema (client/src/StudioDashboard/pages/1.auth/schemas.js).
export const loginBody = z.object({
    email: z.string({ error: 'Enter your email address.' }).trim().min(1, 'Enter your email address.').max(254).pipe(z.email('Enter a valid email address.')),
    password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(200),
});
