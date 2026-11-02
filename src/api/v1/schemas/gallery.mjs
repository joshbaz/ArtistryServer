import { z } from 'zod';
import { imageField, text } from './common.mjs';

const photoFields = {
    title: text(120),
    category: text(40).pipe(z.string().min(1, 'Choose a category.')),
    image: imageField('The photo').pipe(z.string().min(1, 'Add the photo.')),
    status: z.enum(['Visible', 'Hidden'], { error: 'Choose Visible or Hidden.' }),
};

/** POST gallery */
export const createPhotoBody = z.object({
    ...photoFields,
    title: photoFields.title.default(''),
    status: photoFields.status.default('Visible'),
});

/** PATCH gallery/:id */
export const updatePhotoBody = z.object(photoFields).partial();
