import * as admin from '../../../services/organisers/admin.mjs';
import * as payouts from '../../../services/organisers/payouts.mjs';

/** Studio › Voting › Organisers and Payouts (admin realm). */

export const listOrganizers = async (req, res) => {
    res.json({ data: await admin.listOrganizers() });
};

/** → { organizer, campaign, inviteToken }; inviteToken is null when they already have a password. */
export const approve = async (req, res) => {
    res.status(201).json({ data: await admin.approveRequest(req.body.requestId, req.body.campaign) });
};

/** → { organizer, inviteToken } */
export const resendInvite = async (req, res) => {
    res.json({ data: await admin.resendInvite(req.params.id) });
};

export const setAccess = async (req, res) => {
    res.json({ data: await admin.setAccess(req.params.id, req.body.enabled) });
};

export const setShare = async (req, res) => {
    res.json({ data: await admin.setShare(req.params.id, req.body.sharePercent) });
};

export const listPayouts = async (req, res) => {
    res.json({ data: await payouts.listPayoutRequests() });
};

export const markPaid = async (req, res) => {
    res.json({ data: await payouts.markPaid(req.params.id, req.body.reference, { by: req.admin.id }) });
};
