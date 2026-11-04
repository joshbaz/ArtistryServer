import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { notifyStaff } from '../studio/notifications.mjs';
import { assertCampaign } from '../voting/campaigns.mjs';

/**
 * Requests from the public "Run a campaign" form. Approval is manual
 * (10-voting.md, decision 1): the Studio team reviews each one, talks to
 * the organiser and builds the campaign. Emailing the team on each request,
 * and the organiser on a decision, comes with the email queue.
 */

const toRequest = ({ updatedAt: _u, campaignId, submittedAt, ...r }) => ({
    ...r,
    campaignId: campaignId ?? undefined,
    submittedAt: submittedAt.toISOString(),
});

const changed = (id) => invalidate('admin', ['admin', 'organiser-requests'], { id });

/** Public. Only the form's own fields are stored; the reply says no more than that it arrived. */
export const submitRequest = async (data) => {
    const row = await prisma.organiserRequest.create({ data });
    changed(row.id);
    notifyStaff('organiser-request', { subject: `Organiser request from ${row.orgName}`, heading: 'An organiser asks to run a campaign', lines: [`${row.orgName}${row.campaignName ? ` would like to run "${row.campaignName}"` : ' would like to run a campaign'}. Review it within 24 to 48 hours.`], path: '/studio/voting/requests' });
    return { id: row.id, status: row.status };
};

/** Newest first. */
export const listRequests = async () => {
    const rows = await prisma.organiserRequest.findMany({ orderBy: { submittedAt: 'desc' } });
    return rows.map(toRequest);
};

/** Approve (with the campaign made for it), decline, or put back to pending. */
export const updateRequest = async (id, { status, campaignId }) => {
    const current = await prisma.organiserRequest.findUnique({ where: { id } });
    if (!current) throw new AppError('Request not found.', 404);
    if (campaignId) await assertCampaign(campaignId);
    const row = await prisma.organiserRequest.update({
        where: { id },
        data: { ...(status ? { status } : {}), ...(campaignId !== undefined ? { campaignId } : {}) },
    });
    changed(id);
    return toRequest(row);
};
