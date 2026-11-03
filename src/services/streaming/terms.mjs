import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';

/**
 * Studio › Streaming › Types & Categories: video types (every title has one),
 * categories (any number) and content warnings (shown with the age rating).
 * Clients know each by its key, which stays when it's renamed. Titles store
 * type and category keys, and warning names.
 */

export const KINDS = {
    type: { prefix: '', module: 'types', noun: 'type', label: 'Video type' },
    category: { prefix: 'cat_', module: 'categories', noun: 'category', label: 'Category' },
    advisory: { prefix: 'adv_', module: 'advisories', noun: 'warning', label: 'Content warning' },
};

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const toTerm = (t) => ({ id: t.key, name: t.name, slug: t.slug });
const taken = (kind) => new AppError(`That ${KINDS[kind].noun} already exists.`, 409, { details: { fieldErrors: { name: [`That ${KINDS[kind].noun} already exists.`] } } });
const notFound = (kind) => new AppError(`${KINDS[kind].label} not found.`, 404);

const changed = (kind, { titles = false } = {}) => {
    invalidateSite(KINDS[kind].module);
    if (titles) invalidateSite('titles');
};

export const listTerms = async (kind) => (await prisma.streamTerm.findMany({ where: { kind }, orderBy: { createdAt: 'asc' } })).map(toTerm);

/** Whether every key is on the list: the ones that aren't. */
export const missingKeys = async (kind, keys) => {
    if (!keys.length) return [];
    const found = new Set((await prisma.streamTerm.findMany({ where: { kind, key: { in: keys } }, select: { key: true } })).map((t) => t.key));
    return keys.filter((k) => !found.has(k));
};

/** Content warnings as saved, in their saved spelling; names not on the list are dropped. */
export const knownAdvisories = async (names) => {
    if (!names.length) return [];
    const rows = await prisma.streamTerm.findMany({ where: { kind: 'advisory' }, select: { name: true, nameKey: true } });
    const byKey = new Map(rows.map((r) => [r.nameKey, r.name]));
    return [...new Set(names.map((n) => byKey.get(n.toLowerCase())).filter(Boolean))];
};

export const createTerm = async (kind, name) => {
    const nameKey = name.toLowerCase();
    if (await prisma.streamTerm.findUnique({ where: { kind_nameKey: { kind, nameKey } } })) throw taken(kind);
    const slug = slugify(name) || Date.now().toString(36);
    // Like the first ones: "short-film" for a type, "cat_makingof" for a category.
    const { prefix } = KINDS[kind];
    const base = (prefix ? `${prefix}${slug.replace(/-/g, '')}` : slug).slice(0, 50);
    // Then "cat_drama-2" if an old one (since renamed) holds that key.
    for (let n = 1; n < 50; n += 1) {
        const key = n === 1 ? base : `${base}-${n}`;
        try {
            const row = await prisma.streamTerm.create({ data: { kind, key, name, nameKey, slug } });
            changed(kind);
            return toTerm(row);
        } catch (error) {
            if (error.code !== 'P2002') throw error;
            // The same name saved a moment ago, rather than a key clash.
            if (String(error.meta?.target).includes('nameKey')) throw taken(kind);
        }
    }
    throw taken(kind);
};

/** A new name; the key stays. A renamed warning is renamed on every title that has it. */
export const updateTerm = async (kind, key, name) => {
    const current = await prisma.streamTerm.findUnique({ where: { kind_key: { kind, key } } });
    if (!current) throw notFound(kind);
    const nameKey = name.toLowerCase();
    const other = await prisma.streamTerm.findUnique({ where: { kind_nameKey: { kind, nameKey } } });
    if (other && other.id !== current.id) throw taken(kind);
    const row = await prisma.streamTerm.update({ where: { id: current.id }, data: { name, nameKey, slug: slugify(name) || current.slug } });
    let titles = false;
    if (kind === 'advisory' && name !== current.name) {
        const using = await prisma.streamTitle.findMany({ where: { advisories: { has: current.name } }, select: { id: true, advisories: true } });
        for (const t of using) await prisma.streamTitle.update({ where: { id: t.id }, data: { advisories: t.advisories.map((a) => (a === current.name ? name : a)) } });
        titles = using.length > 0;
    }
    changed(kind, { titles });
    return toTerm(row);
};

/**
 * A type in use can't go: every title needs one. A category or a warning is
 * taken off the titles that have it.
 */
export const deleteTerm = async (kind, key) => {
    const current = await prisma.streamTerm.findUnique({ where: { kind_key: { kind, key } } });
    if (!current) return;
    let titles = false;
    if (kind === 'type') {
        const used = await prisma.streamTitle.count({ where: { type: key } });
        if (used) throw new AppError(`${used} title${used > 1 ? 's use' : ' uses'} this type. Move them to another type first.`, 409, { code: 'type_in_use' });
    } else {
        const field = kind === 'category' ? 'categoryIds' : 'advisories';
        const value = kind === 'category' ? key : current.name;
        const using = await prisma.streamTitle.findMany({ where: { [field]: { has: value } }, select: { id: true, [field]: true } });
        for (const t of using) await prisma.streamTitle.update({ where: { id: t.id }, data: { [field]: t[field].filter((v) => v !== value) } });
        titles = using.length > 0;
    }
    await prisma.streamTerm.delete({ where: { id: current.id } });
    changed(kind, { titles });
};
