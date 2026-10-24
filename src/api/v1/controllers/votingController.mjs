import * as campaigns from '../../../services/voting/campaigns.mjs';

/** /voting: published campaigns only. Anyone may read. */

/** GET /voting/campaigns */
export const listCampaigns = async (req, res) => {
    res.json({ data: await campaigns.listPublished() });
};

/** GET /voting/campaigns/:id → { campaign, participants } in leaderboard order */
export const getCampaign = async (req, res) => {
    res.json({ data: await campaigns.getPublished(req.params.id) });
};
