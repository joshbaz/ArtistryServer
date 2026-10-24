import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { idParam } from '../schemas/common.mjs';
import * as controller from '../controllers/votingController.mjs';

// Public: /voting reads published campaigns. Free and paid votes join here in build steps 2 and 3.
const router = express.Router();

router.get('/campaigns', controller.listCampaigns);
router.get('/campaigns/:id', validate(idParam, 'params'), controller.getCampaign);

export default router;
