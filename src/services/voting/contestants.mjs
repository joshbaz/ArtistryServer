import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidateSite } from '../../utils/sockets.js';
import { assertCampaign, toContestant } from './campaigns.mjs';

/**
 * A campaign's contestants, edited in the Studio. Their numbers are unique
 * within the campaign, and a contestant with votes can't be removed, so a
 * result always adds up.
 */

const notFound = () => new AppError('Contestant not found.', 404);
const numberTaken = (n) => new AppError(`Number ${n} is already taken in this campaign.`, 409, { code: 'number_taken' });

// Two people adding at once can both pick the same next number; the unique index refuses the second.
const saving = async (number, write) => {
    try {
        return await write();
    } catch (error) {
        if (error.code === 'P2002') throw numberTaken(number);
        throw error;
    }
};

/** Contestants in number order, for the Studio. */
export const listContestants = async (campaignId) => {
    await assertCampaign(campaignId);
    const rows = await prisma.contestant.findMany({ where: { campaignId }, orderBy: { number: 'asc' } });
    return rows.map(toContestant);
};

export const createContestant = async (campaignId, { number, ...data }) => {
    await assertCampaign(campaignId);
    const last = await prisma.contestant.findFirst({ where: { campaignId }, orderBy: { number: 'desc' }, select: { number: true } });
    const next = number ?? (last?.number ?? 0) + 1;
    const row = await saving(next, () => prisma.contestant.create({ data: { ...data, campaignId, number: next } }));
    invalidateSite('campaigns', { id: campaignId });
    return toContestant(row);
};

export const updateContestant = async (id, patch) => {
    const current = await prisma.contestant.findUnique({ where: { id } });
    if (!current) throw notFound();
    const row = await saving(patch.number, () => prisma.contestant.update({ where: { id }, data: patch }));
    invalidateSite('campaigns', { id: current.campaignId });
    return toContestant(row);
};

export const deleteContestant = async (id) => {
    const current = await prisma.contestant.findUnique({ where: { id } });
    // Already gone: nothing to do.
    if (!current) return;
    if (current.importedVotes + current.platformVotes > 0) throw new AppError("This contestant has votes, so they can't be removed.", 409);
    await prisma.contestant.delete({ where: { id } });
    invalidateSite('campaigns', { id: current.campaignId });
};
