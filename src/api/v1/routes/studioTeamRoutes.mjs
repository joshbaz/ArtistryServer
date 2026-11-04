import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/studioAuth.mjs';
import * as controller from '../controllers/studioAuthController.mjs';

/** Studio › Settings › Team: a Super Admin only (allow() with no other roles). */
const router = express.Router();
const id = validate(idParam, 'params');

router.use(requireAdmin, allow());
router.get('/', controller.listTeam);
router.post('/', validate(schema.inviteBody), controller.inviteMember);
router.patch('/:id', id, validate(schema.memberBody), controller.updateMember);
router.post('/:id/link', id, controller.sendLink);
router.delete('/:id', id, controller.removeInvite);

export default router;
