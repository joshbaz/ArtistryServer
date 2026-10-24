import * as accounts from '../../../services/organisers/accounts.mjs';
import * as payouts from '../../../services/organisers/payouts.mjs';
import * as portal from '../../../services/organisers/portal.mjs';

/** /organizer: the signed-in organiser's own campaigns, money and account. Never an organiser id from the page. */

export const listCampaigns = async (req, res) => {
    res.json({ data: await portal.listMine(req.organizer.id) });
};

export const getCampaign = async (req, res) => {
    res.json({ data: await portal.getMine(req.organizer.id, req.params.id) });
};

export const updateCampaign = async (req, res) => {
    res.json({ data: await portal.updateMine(req.organizer, req.params.id, req.body) });
};

export const setPublished = async (req, res) => {
    res.json({ data: await portal.setPublished(req.organizer.id, req.params.id, req.body.published) });
};

export const listContestants = async (req, res) => {
    res.json({ data: await portal.listMyContestants(req.organizer.id, req.params.id) });
};

export const addContestants = async (req, res) => {
    res.status(201).json({ data: await portal.addMyContestants(req.organizer.id, req.params.id, req.body.rows) });
};

export const updateContestant = async (req, res) => {
    res.json({ data: await portal.updateMyContestant(req.organizer.id, req.params.id, req.body) });
};

export const moveContestant = async (req, res) => {
    res.json({ data: await portal.moveMyContestant(req.organizer.id, req.params.id, req.body.step) });
};

export const deleteContestant = async (req, res) => {
    await portal.deleteMyContestant(req.organizer.id, req.params.id);
    res.status(204).end();
};

export const results = async (req, res) => {
    res.json({ data: await portal.getMyResults(req.organizer.id, req.params.id) });
};

export const payments = async (req, res) => {
    res.json({ data: await portal.listMyPayments(req.organizer.id) });
};

export const getPayouts = async (req, res) => {
    res.json({ data: await payouts.getMyPayouts(req.organizer) });
};

export const requestPayout = async (req, res) => {
    res.status(201).json({ data: await payouts.requestPayout(req.organizer, req.body) });
};

export const getProfile = async (req, res) => {
    res.json({ data: await accounts.getProfile(req.organizer.id) });
};

export const updateProfile = async (req, res) => {
    res.json({ data: await accounts.updateProfile(req.organizer.id, req.body) });
};

/** Signs out every other session. */
export const changePassword = async (req, res) => {
    await accounts.changePassword(req.organizer.id, req.sessionId, req.body);
    res.status(204).end();
};
