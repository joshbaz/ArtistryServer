import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { requireMember } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/voting.mjs';
import * as controller from '../controllers/votingController.mjs';

// Public: /voting reads published campaigns. A free vote needs a signed-in voter (member realm);
// paid votes start at POST /payments/orders.
const router = express.Router();
const campaign = validate(idParam, 'params');

router.get('/campaigns', controller.listCampaigns);
router.get('/campaigns/:id', campaign, controller.getCampaign);
router.get('/campaigns/:id/me', campaign, requireMember, controller.myVote);
router.post('/campaigns/:id/votes', campaign, requireMember, validate(schema.freeVoteBody), controller.castFreeVote);

export default router;
