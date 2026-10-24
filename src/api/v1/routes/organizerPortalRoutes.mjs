import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { requireOrganizer } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/organizerPortal.mjs';
import * as controller from '../controllers/organizerPortalController.mjs';

// /organizer (organizer realm). Every campaign and contestant route checks it's the organiser's own (services/organisers/portal.mjs).
const router = express.Router();
const id = validate(idParam, 'params');

router.use(requireOrganizer);

router.get('/campaigns', controller.listCampaigns);
router.get('/campaigns/:id', id, controller.getCampaign);
router.patch('/campaigns/:id', id, validate(schema.updateCampaignBody), controller.updateCampaign);
router.post('/campaigns/:id/publish', id, validate(schema.publishBody), controller.setPublished);
router.get('/campaigns/:id/results', id, controller.results);

router.get('/campaigns/:id/contestants', id, controller.listContestants);
router.post('/campaigns/:id/contestants', id, validate(schema.addContestantsBody), controller.addContestants);
router.patch('/contestants/:id', id, validate(schema.updateContestantBody), controller.updateContestant);
router.post('/contestants/:id/move', id, validate(schema.moveBody), controller.moveContestant);
router.delete('/contestants/:id', id, controller.deleteContestant);

router.get('/payments', controller.payments);
router.get('/payouts', controller.getPayouts);
router.post('/payouts', validate(schema.payoutBody), controller.requestPayout);

router.get('/me', controller.getProfile);
router.patch('/me', validate(schema.profileBody), controller.updateProfile);
router.post('/me/password', validate(schema.passwordBody), controller.changePassword);

export default router;
