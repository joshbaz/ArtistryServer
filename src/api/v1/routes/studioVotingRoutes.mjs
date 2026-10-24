import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/voting.mjs';
import * as controller from '../controllers/studioVotingController.mjs';

/**
 * Studio › Voting. Every Studio role may look; a Content Manager edits
 * campaigns and contestants; taking a campaign down, putting it back and
 * deleting it are a Super Admin's (10-voting.md, Roles).
 */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');
const superAdmin = allow();

router.use(requireAdmin);

router.get('/campaigns', controller.listCampaigns);
router.get('/stats', controller.stats);
router.post('/campaigns', editor, validate(schema.createCampaignBody), controller.createCampaign);
router.patch('/campaigns/:id', id, editor, validate(schema.updateCampaignBody), controller.updateCampaign);
router.post('/campaigns/:id/close', id, editor, validate(schema.closeBody), controller.setClosed);
router.post('/campaigns/:id/take-down', id, superAdmin, validate(schema.takeDownBody), controller.takeDown);
router.post('/campaigns/:id/restore', id, superAdmin, controller.restore);
router.delete('/campaigns/:id', id, superAdmin, controller.deleteCampaign);

router.get('/campaigns/:id/contestants', id, controller.listContestants);
router.post('/campaigns/:id/contestants', id, editor, validate(schema.createContestantBody), controller.createContestant);
router.patch('/contestants/:id', id, editor, validate(schema.updateContestantBody), controller.updateContestant);
router.delete('/contestants/:id', id, editor, controller.deleteContestant);

export default router;
