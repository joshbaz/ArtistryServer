import prisma from '../../utils/db.mjs';

/**
 * Who changed money: prices, plans and billing periods, each with what it
 * was before and after, so the client can always ask who changed what and when.
 * Writing one never holds up or fails the change itself.
 *
 * @param {{ id: string, name?: string } | null | undefined} by - the staff member (req.admin)
 * @param {string} entity - title-price | plan | billing-period
 * @param {string} entityId
 * @param {object | null} before - null when it was made
 * @param {object | null} after - null when it was deleted
 */
export const recordChange = (by, entity, entityId, before, after) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    prisma.auditEntry
        .create({ data: { staffId: by?.id ?? null, staffName: by?.name ?? '', entity, entityId, before: before ?? undefined, after: after ?? undefined } })
        .catch((error) => console.error(`Audit entry for ${entity} ${entityId} not saved:`, error.message));
};
