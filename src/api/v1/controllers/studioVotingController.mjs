import * as campaigns from '../../../services/voting/campaigns.mjs';
import * as contestants from '../../../services/voting/contestants.mjs';
import * as audit from '../../../services/voting/audit.mjs';
import * as vipCredits from '../../../services/voting/vipCredits.mjs';
import { emailVipNow } from '../../../services/voting/vipEmail.mjs';
import { roleAllows } from '../../../utils/permissions.mjs';

/** Studio › Voting (admin realm): every campaign, drafts included, and its contestants. */

export const listCampaigns = async (req, res) => {
    res.json({ data: await campaigns.listForStudio() });
};

export const stats = async (req, res) => {
    res.json({ data: await campaigns.getStats() });
};

export const createCampaign = async (req, res) => {
    res.status(201).json({ data: await campaigns.createCampaign(req.body) });
};

export const updateCampaign = async (req, res) => {
    res.json({ data: await campaigns.updateCampaign(req.params.id, req.body, req.admin) });
};

export const setClosed = async (req, res) => {
    res.json({ data: await campaigns.setClosed(req.params.id, req.body.closed) });
};

export const takeDown = async (req, res) => {
    res.json({ data: await campaigns.takeDown(req.params.id, req.body.reason) });
};

export const restore = async (req, res) => {
    res.json({ data: await campaigns.restore(req.params.id) });
};

export const deleteCampaign = async (req, res) => {
    await campaigns.deleteCampaign(req.params.id);
    res.status(204).end();
};

export const listContestants = async (req, res) => {
    res.json({ data: await contestants.listContestants(req.params.id) });
};

export const createContestant = async (req, res) => {
    res.status(201).json({ data: await contestants.createContestant(req.params.id, req.body) });
};

export const updateContestant = async (req, res) => {
    res.json({ data: await contestants.updateContestant(req.params.id, req.body) });
};

export const deleteContestant = async (req, res) => {
    await contestants.deleteContestant(req.params.id);
    res.status(204).end();
};

/** GET /voting/studio/campaigns/:id/votes/summary: votes by source, and whether every counter matches its records. */
export const voteSummary = async (req, res) => {
    res.json({ data: await audit.voteBreakdown(req.params.id) });
};

/** GET /voting/studio/campaigns/:id/votes: every vote, newest first, a page at a time. */
export const voteLedger = async (req, res) => {
    // Who voted, by name and email, is for the trust and safety roles only.
    const identities = roleAllows(req.admin.role, ['moderator']);
    const { items, next } = await audit.voteLedger(req.params.id, req.query, { identities });
    res.json({ data: items, meta: { next, identities } });
};

/** GET /voting/studio/campaigns/:id/vip-passes: every VIP pass and how far its automatic daily votes have got. */
export const vipPasses = async (req, res) => {
    const identities = roleAllows(req.admin.role, ['moderator']);
    res.json({ data: await vipCredits.listPasses(req.params.id, { identities }), meta: { identities } });
};

/** POST /voting/studio/vip-passes/:id/email { note? }: the voter's VIP pass by email, with a note from the team. */
export const emailVipPass = async (req, res) => {
    res.json({ data: await emailVipNow(req.params.id, req.body, req.admin) });
};
