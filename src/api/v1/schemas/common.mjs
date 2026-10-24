import { z } from 'zod';

/** A MongoDB id. Anything else is a 404 before it reaches Prisma (which would otherwise fail with a 500). */
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'We could not find that.');

/** `:id` in the path. */
export const idParam = z.object({ id: objectId });

const MAX_IMAGE_CHARS = 1_500_000;

/**
 * An image field: an https:// link, a JPEG/PNG/WebP data URL from the
 * Studio's uploader (until media uploads land), or empty. Never another
 * scheme: `javascript:` and `data:text/html` are refused (12-backend-integration.md, Security).
 */
export const imageField = (label) => z
    .string()
    .max(MAX_IMAGE_CHARS, `${label} is too large. Use a smaller image.`)
    .refine((v) => v === '' || /^https:\/\/[^\s]+$/.test(v) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v), `${label} must be an upload or an https:// link.`);

/** A plain text field: trimmed, capped, control characters other than newlines and tabs removed. */
export const text = (max) => z.string().max(max * 2).transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()).pipe(z.string().max(max, `Keep it under ${max.toLocaleString('en')} characters.`));
