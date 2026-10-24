import * as campaigns from '../../../services/voting/campaigns.mjs';
import * as contestants from '../../../services/voting/contestants.mjs';

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
    res.json({ data: await campaigns.updateCampaign(req.params.id, req.body) });
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
