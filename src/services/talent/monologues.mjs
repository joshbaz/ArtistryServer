import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * A talent's showcase clips on their public profile: a YouTube link (it
 * must carry a video id) or an upload's https playback URL. The schemas
 * check the link; this checks the talent.
 */

const notFound = () => new AppError('Monologue not found.', 404);

const toMonologue = (m) => ({
    id: m.id,
    talentId: m.talentId,
    title: m.title,
    source: m.source,
    url: m.url,
    ...(m.duration != null && { duration: m.duration }),
    createdAt: m.createdAt.toISOString(),
});

const changed = (id) => {
    invalidate('admin', ['admin', 'monologues'], { id });
    invalidateSite('profiles', { id });
};

const assertTalent = async (talentId) => {
    if (talentId !== undefined && !(await prisma.talent.count({ where: { talentId } }))) {
        throw new AppError('Choose a talent from the roster.', 422, { details: { fieldErrors: { talentId: ['Choose a talent from the roster.'] } } });
    }
};

/* Studio */

export const listAllMonologues = async () => (await prisma.monologue.findMany({ orderBy: { createdAt: 'desc' } })).map(toMonologue);

export const createMonologue = async (data) => {
    await assertTalent(data.talentId);
    const row = await prisma.monologue.create({ data });
    changed(row.id);
    return toMonologue(row);
};

export const updateMonologue = async (id, patch) => {
    if (!(await prisma.monologue.count({ where: { id } }))) throw notFound();
    await assertTalent(patch.talentId);
    const row = await prisma.monologue.update({ where: { id }, data: patch });
    changed(id);
    return toMonologue(row);
};

export const deleteMonologue = async (id) => {
    const { count } = await prisma.monologue.deleteMany({ where: { id } });
    if (count) changed(id);
};

/* Public: a published talent's clips, newest first (none for anyone else). */
export const listMonologues = async (talentId) => {
    if (!(await prisma.talent.count({ where: { talentId, published: true } }))) return [];
    return (await prisma.monologue.findMany({ where: { talentId }, orderBy: { createdAt: 'desc' } })).map(toMonologue);
};
