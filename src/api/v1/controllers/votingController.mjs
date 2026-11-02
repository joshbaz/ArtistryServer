import * as campaigns from '../../../services/voting/campaigns.mjs';
import * as freeVotes from '../../../services/voting/freeVotes.mjs';
import { AppError } from '../../../utils/AppError.js';
import { deviceHeader } from '../schemas/voting.mjs';

/** /voting: published campaigns, which anyone may read, and the signed-in voter's free vote. */

/** GET /voting/campaigns */
export const listCampaigns = async (req, res) => {
    res.json({ data: await campaigns.listPublished() });
};

/** GET /voting/campaigns/:id → { campaign, participants } in leaderboard order */
export const getCampaign = async (req, res) => {
    res.json({ data: await campaigns.getPublished(req.params.id) });
};

/** GET /voting/campaigns/:id/me → { nextFreeVoteAt, isVip, dailyVotes } for the signed-in voter */
export const myVote = async (req, res) => {
    res.json({ data: await freeVotes.voterStatus(req.params.id, req.member.id) });
};

/** POST /voting/campaigns/:id/votes { participantId }, with X-Device-Id */
export const castFreeVote = async (req, res) => {
    const device = deviceHeader.safeParse(req.get('X-Device-Id'));
    if (!device.success) throw new AppError('We couldn’t check this device. Refresh the page and try again.', 400, { code: 'device_required' });
    const vote = await freeVotes.castFreeVote({
        campaignId: req.params.id,
        participantId: req.body.participantId,
        memberId: req.member.id,
        ip: req.ip,
        deviceId: device.data,
    });
    res.status(201).json({ data: vote });
};
