import { z } from 'zod';
import { text } from './common.mjs';
import { LIST_KEYS } from '../../../services/system/options.mjs';

/** `:list` in studio/options/:list */
export const listParam = z.object({ list: z.enum(LIST_KEYS) });

/** POST studio/options/:list: one value, spaces tidied. */
export const addOptionBody = z.object({
    value: text(80).transform((v) => v.replace(/\s+/g, ' ')).pipe(z.string().min(1, 'Type a name first.').max(40, 'Keep it under 40 characters.')),
});
