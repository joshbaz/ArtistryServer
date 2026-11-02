import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';
import { allDisciplines, getOptionLists } from '../system/options.mjs';
import { withNextNumber } from '../system/counters.mjs';

/**
 * The talent roster: one list for the Studio and the site. The Studio sees
 * every field; the public roster only PUBLIC_FIELDS (never the surname, phone
 * or email). Each talent gets a reference (T-001) and a URL slug (t-001)
 * that never change and are never reused.
 */

export const PROFILES_PAGE_SIZE = 20;
const PUBLIC_FIELDS = ['id', 'talentId', 'firstName', 'primaryRole', 'otherRoles', 'skills', 'experience', 'base', 'languages', 'availability', 'shortBio', 'profileImg', 'headerImage', 'projects'];

const notFound = () => new AppError('Talent not found.', 404);
const profileNotFound = () => new AppError('Profile not found.', 404);

/** As the Studio reads it: `id` is the slug, the same one in the profile's URL. */
const toTalent = ({ id: _id, slug, createdAt: _c, updatedAt: _u, ...t }) => ({ ...t, id: slug, projects: Array.isArray(t.projects) ? t.projects : [] });

/** The allowlist: when a field is added to Talent, nothing reaches the site unless it's named here. */
const toProfile = (row) => {
    const t = toTalent(row);
    const out = Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, t[k]]));
    // The header photo is optional; the profile photo stands in for it.
    return { ...out, headerImage: t.headerImage || t.profileImg };
};

const changed = (slug) => {
    invalidate('admin', ['admin', 'talent'], { id: slug });
    invalidate('admin', ['admin', 'public-talent'], { id: slug });
    invalidateSite('profiles', { id: slug });
};

const checkDiscipline = async (primaryRole) => {
    if (primaryRole === undefined) return;
    if (!allDisciplines(await getOptionLists()).includes(primaryRole)) {
        throw new AppError('Choose a discipline from the list.', 422, { details: { fieldErrors: { primaryRole: ['Choose a discipline from the list.'] } } });
    }
};

const highestTalentNumber = async () => {
    const top = await prisma.talent.findFirst({ orderBy: { talentId: 'desc' }, select: { talentId: true } });
    return Number(top?.talentId.slice(2)) || 0;
};

/* Studio */

export const listTalent = async () => (await prisma.talent.findMany({ orderBy: { talentId: 'asc' } })).map(toTalent);

export const createTalent = async (data) => {
    await checkDiscipline(data.primaryRole);
    const row = await withNextNumber('talent', highestTalentNumber, (n) => {
        const talentId = `T-${String(n).padStart(3, '0')}`;
        return prisma.talent.create({ data: { ...data, projects: data.projects ?? [], talentId, slug: talentId.toLowerCase() } });
    });
    changed(row.slug);
    return toTalent(row);
};

export const updateTalent = async (slug, patch) => {
    const current = await prisma.talent.findUnique({ where: { slug }, select: { published: true, shortBio: true } });
    if (!current) throw notFound();
    await checkDiscipline(patch.primaryRole);
    // Publishing from the list's toggle sends only `published`: the bio checked is the stored one.
    const next = { ...current, ...patch };
    if (next.published && next.shortBio.length < 40) {
        throw new AppError('Published talent needs a bio of at least 40 characters.', 422, { details: { fieldErrors: { shortBio: ['Published talent needs a bio of at least 40 characters.'] } } });
    }
    const row = await prisma.talent.update({ where: { slug }, data: patch });
    changed(slug);
    return toTalent(row);
};

/** Their monologues go with them; booking requests keep the reference, as history. */
export const deleteTalent = async (slug) => {
    const current = await prisma.talent.findUnique({ where: { slug } });
    if (!current) return;
    await prisma.$transaction([
        prisma.monologue.deleteMany({ where: { talentId: current.talentId } }),
        prisma.talent.delete({ where: { slug } }),
    ]);
    invalidate('admin', ['admin', 'monologues']);
    changed(slug);
};

/* Public */

/** One page of the published roster, by reference. */
export const listProfiles = async ({ page = 1, pageSize = PROFILES_PAGE_SIZE }) => {
    const where = { published: true };
    const total = await prisma.talent.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), pageCount);
    const rows = await prisma.talent.findMany({ where, orderBy: { talentId: 'asc' }, skip: (current - 1) * pageSize, take: pageSize });
    return { items: rows.map(toProfile), page: current, pageCount, total };
};

/** A published profile by its slug; an unpublished one is a 404. */
export const getProfile = async (slug) => {
    const row = await prisma.talent.findFirst({ where: { slug, published: true } });
    if (!row) throw profileNotFound();
    return toProfile(row);
};

/** The published talent references among `talentIds` (for booking requests). */
export const bookableIds = async (talentIds) =>
    (await prisma.talent.findMany({ where: { talentId: { in: talentIds }, published: true }, select: { talentId: true } })).map((t) => t.talentId);
