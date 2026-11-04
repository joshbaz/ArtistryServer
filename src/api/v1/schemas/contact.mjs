import { z } from 'zod';
import { text } from './common.mjs';

/** POST enquiries: the public contact form. `website` is the honeypot. */
export const enquiryBody = z.object({
    name: text(80).pipe(z.string().min(1, 'Enter your name.')),
    email: z.string().trim().max(120).email('Enter a valid email address.'),
    subject: text(80).optional().default(''),
    message: text(5000).pipe(z.string().min(10, 'Tell us a little more (10 characters or more).')),
    website: z.string().max(500).optional(),
});

/** PATCH enquiries/:id */
export const readBody = z.object({ read: z.boolean() });
