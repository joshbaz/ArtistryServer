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

/* Class year photos */

const classYearFields = {
    year: z.string().trim().regex(/^\d{4}$/, 'Use a four-digit year, like 2025.'),
    linkText: text(80),
    image: imageField('The photo').pipe(z.string().min(1, 'Add the photo.')),
    status: z.enum(['Visible', 'Hidden'], { error: 'Choose Visible or Hidden.' }),
};

/** POST content/class-years */
export const createClassYearBody = z.object({ ...classYearFields, linkText: classYearFields.linkText.default(''), status: classYearFields.status.default('Visible') });

/** PATCH content/class-years/:id */
export const updateClassYearBody = z.object(classYearFields).partial();
