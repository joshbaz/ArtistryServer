import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/organisers.mjs';
import * as controller from '../controllers/organiserController.mjs';

// The public request is rate limited in utils/rateLimits.js (PUBLIC_RULES). Approving is a Super Admin's (10-voting.md, decision 1).
const router = express.Router();

router.post('/requests', validate(schema.requestBody), controller.submitRequest);
router.get('/requests', requireAdmin, controller.listRequests);
router.patch('/requests/:id', validate(idParam, 'params'), requireAdmin, allow(), validate(schema.updateRequestBody), controller.updateRequest);

export default router;
