import { z } from 'zod';
import { imageField, text } from './common.mjs';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30.');

const articleFields = {
    title: text(160).pipe(z.string().min(1, 'Give it a title.')),
    excerpt: text(400),
    content: text(20_000),
    location: text(160),
    category: text(40).pipe(z.string().min(1, 'Choose a category.')),
    date: day,
    // Empty for a one-day event or a story.
    endDate: z.union([z.literal(''), day]),
    image: imageField('The image'),
    status: z.enum(['Published', 'Draft'], { error: 'Choose Published or Draft.' }),
};

/** POST content/news */
export const createArticleBody = z.object({
    ...articleFields,
    excerpt: articleFields.excerpt.default(''),
    content: articleFields.content.default(''),
    location: articleFields.location.default(''),
    endDate: articleFields.endDate.default(''),
    image: articleFields.image.default(''),
    status: articleFields.status.default('Draft'),
});

/** PATCH content/news/:id. Unknown fields are dropped. */
export const updateArticleBody = z.object(articleFields).partial();
