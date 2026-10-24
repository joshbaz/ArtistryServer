import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { revokeAllSessions } from '../auth/sessions.mjs';
import { createCampaign, studioViews } from '../voting/campaigns.mjs';
import { inviteOf, issueInvite, normalEmail } from './accounts.mjs';
import { openPayoutCounts } from './payouts.mjs';
import { updateRequest } from './requests.mjs';

/**
 * Organisers from the Studio's side (Super Admin): make an account from an
 * approved request, send invite links, turn access off and on, and set the
 * revenue share.
 */

const notFound = () => new AppError('Organiser not found.', 404);
const changed = (id) => invalidate('admin', ['admin', 'organizers'], { id });

const DEFAULT_SHARE = 70;

/** Each organiser with their campaigns, platform revenue and open payout requests. */
const withFigures = async (organizers) => {
    const ids = organizers.map((o) => o.id);
    const [campaigns, open] = await Promise.all([prisma.campaign.findMany({ where: { organizerId: { in: ids } } }), openPayoutCounts()]);
    const views = await studioViews(campaigns);
    return organizers.map((o) => {
        const owned = views.filter((c) => c.organizerId === o.id);
        return {
            id: o.id,
            orgName: o.orgName,
            contactName: o.contactName,
            email: o.email,
            phone: o.phone,
            status: o.status,
            sharePercent: o.sharePercent,
            logo: o.logo,
            invite: inviteOf(o),
            createdAt: o.createdAt.toISOString(),
            campaigns: owned.map((c) => ({ id: c.id, title: c.title, publishStatus: c.publishStatus, status: c.status })),
            revenueUGX: owned.reduce((s, c) => s + c.revenueFromVotesUGX + c.revenueFromVipUGX, 0),
            openPayouts: open.get(o.id) ?? 0,
        };
    });
};

const oneWithFigures = async (id) => {
    const row = await prisma.organizer.findUnique({ where: { id } });
    if (!row) throw notFound();
    return (await withFigures([row]))[0];
};

/** Newest first. */
export const listOrganizers = async () => withFigures(await prisma.organizer.findMany({ orderBy: { createdAt: 'desc' } }));

/**
 * Approve a request: the organiser's account (found by email, or made new),
 * a draft campaign they own, the request marked approved, and an invite
 * unless they already have a password. Returns what the invite panel needs.
 * @param {string} requestId
 * @param {object} draft - A validated createCampaignBody
 */
export const approveRequest = async (requestId, draft) => {
    const request = await prisma.organiserRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Request not found.', 404);
    const email = normalEmail(request.email);

    let organizer = await prisma.organizer.findUnique({ where: { email }, omit: { passwordHash: false } });
    if (!organizer) {
        try {
            organizer = await prisma.organizer.create({
                data: { orgName: request.orgName, contactName: request.contactName, email, phone: request.phone, sharePercent: DEFAULT_SHARE },
                omit: { passwordHash: false },
            });
        } catch (error) {
            // Approved twice at once: the other approval made the account.
            if (error.code !== 'P2002') throw error;
            organizer = await prisma.organizer.findUniqueOrThrow({ where: { email }, omit: { passwordHash: false } });
        }
    }
    const inviteToken = organizer.passwordHash ? null : await issueInvite(organizer.id);

    const campaign = await createCampaign({ ...draft, organizer: organizer.orgName, organizerBadge: 'verified', organizerId: organizer.id, requestId });
    await updateRequest(requestId, { status: 'approved', campaignId: campaign.id });
    changed(organizer.id);
    return { organizer: await oneWithFigures(organizer.id), campaign, inviteToken };
};

/** A fresh invite link (also how a forgotten password is reset). The old link stops working. */
export const resendInvite = async (id) => {
    if (!(await prisma.organizer.findUnique({ where: { id }, select: { id: true } }))) throw notFound();
    const inviteToken = await issueInvite(id);
    changed(id);
    return { organizer: await oneWithFigures(id), inviteToken };
};

/** Turn access off (signed out at their next request) or back on. */
export const setAccess = async (id, enabled) => {
    const row = await prisma.organizer.findUnique({ where: { id }, omit: { passwordHash: false } });
    if (!row) throw notFound();
    const status = !enabled ? 'disabled' : row.passwordHash ? 'active' : 'invited';
    await prisma.organizer.update({ where: { id }, data: { status } });
    if (!enabled) await revokeAllSessions('organizer', id, { reason: 'suspended' });
    changed(id);
    return oneWithFigures(id);
};

export const setShare = async (id, sharePercent) => {
    if (!(await prisma.organizer.findUnique({ where: { id }, select: { id: true } }))) throw notFound();
    await prisma.organizer.update({ where: { id }, data: { sharePercent } });
    changed(id);
    return oneWithFigures(id);
};
