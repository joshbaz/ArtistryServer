import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateSite } from '../../utils/sockets.js';

/**
 * The editable lists behind Studio dropdowns: a form's "+ Add" saves here
 * and the new value is selected at once. One document; until anyone adds to
 * a list, these defaults are the lists.
 */

const ID = 'lists';
const ADDED_GROUP = 'Other';

export const DEFAULT_OPTIONS = {
    languages: ['English', 'Luganda', 'Swahili', 'Runyankole', 'Rukiga', 'Lusoga', 'Acholi', 'Lango', 'Ateso', 'Lugbara', 'French', 'Other'],
    bases: ['Kampala', 'Entebbe', 'Wakiso', 'Mukono', 'Jinja', 'Mbarara', 'Gulu', 'Mbale', 'Fort Portal', 'Masaka', 'Lira', 'Arua', 'Outside Uganda'],
    disciplineGroups: [
        { label: 'Performance', roles: ['Actor', 'Model', 'Voice artist', 'Dancer', 'Musician', 'Presenter / Host', 'Stunt performer'] },
        { label: 'Camera & light', roles: ['Director of photography (DOP)', 'Camera operator', 'Photographer', 'Drone operator', 'Gaffer / Lighting'] },
        { label: 'Direction & story', roles: ['Director', 'Assistant director', 'Screenwriter', 'Script supervisor'] },
        { label: 'Production', roles: ['Producer', 'Production manager', 'Casting director', 'Location manager'] },
        { label: 'Post-production', roles: ['Editor', 'Colourist', 'Sound designer', 'Composer', 'VFX / Motion artist'] },
        { label: 'Art & style', roles: ['Production designer', 'Costume designer', 'Makeup artist', 'Hair stylist'] },
    ],
    newsCategories: ['Event', 'Announcement', 'Blog', 'News'],
    // "Alumni" photos fill the alumni slider on /gallery; the rest are grid filters.
    galleryCategories: ['On Set', 'Behind the Scenes', 'Events', 'Portraits', 'Alumni'],
    votingCategories: ['Acting', 'Beauty', 'Dance', 'Film', 'Music', 'Pageant'],
};

export const LIST_KEYS = ['languages', 'bases', 'disciplines', 'newsCategories', 'galleryCategories', 'votingCategories'];

const toLists = (row) => ({
    languages: row.languages,
    bases: row.bases,
    disciplineGroups: row.disciplineGroups,
    newsCategories: row.newsCategories,
    galleryCategories: row.galleryCategories,
    votingCategories: row.votingCategories,
});

/** Every list. */
export const getOptionLists = async () => {
    const row = await prisma.optionLists.findUnique({ where: { id: ID } });
    return row ? toLists(row) : DEFAULT_OPTIONS;
};

export const allDisciplines = (lists) => lists.disciplineGroups.flatMap((g) => g.roles);

/**
 * Add a value to a list; returns the value to select. One that already
 * exists, in any letter case, returns the existing spelling instead of a copy.
 * @param {string} list - one of LIST_KEYS
 * @param {string} value - already trimmed and checked
 */
export const addOption = async (list, value) => {
    const lists = await getOptionLists();
    const same = (v) => v.toLowerCase() === value.toLowerCase();
    let patch;
    if (list === 'disciplines') {
        const existing = allDisciplines(lists).find(same);
        if (existing) return existing;
        patch = {
            disciplineGroups: lists.disciplineGroups.some((g) => g.label === ADDED_GROUP)
                ? lists.disciplineGroups.map((g) => (g.label === ADDED_GROUP ? { ...g, roles: [...g.roles, value] } : g))
                : [...lists.disciplineGroups, { label: ADDED_GROUP, roles: [value] }],
        };
    } else {
        const items = lists[list];
        if (!items) throw new AppError('There is no such list.', 404);
        const existing = items.find(same);
        if (existing) return existing;
        // "Other" stays last where a list has it.
        const other = items.findIndex((v) => v === 'Other' || v === 'Outside Uganda');
        patch = { [list]: other === -1 ? [...items, value] : [...items.slice(0, other), value, ...items.slice(other)] };
    }
    // Two adds at once: the later one wins the whole document. Rare enough for staff-only lists, and the other can add again.
    await prisma.optionLists.upsert({ where: { id: ID }, create: { id: ID, ...lists, ...patch }, update: patch });
    invalidate('admin', ['admin', 'option-lists']);
    if (list === 'galleryCategories') invalidateSite('gallery');
    return value;
};
