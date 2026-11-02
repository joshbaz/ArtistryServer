import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/talent.mjs';
import * as controller from '../controllers/talentController.mjs';

/** Every talent's monologues, for the Studio. The public read is GET talent/:talentId/monologues (talentRoutes). */
const router = express.Router();
const id = validate(idParam, 'params');

router.use(requireAdmin);
router.get('/', controller.listAllMonologues);
router.post('/', allow('content-manager'), validate(schema.createMonologueBody), controller.createMonologue);
router.patch('/:id', id, allow('content-manager'), validate(schema.updateMonologueBody), controller.updateMonologue);
router.delete('/:id', id, allow('content-manager'), controller.deleteMonologue);

export default router;
