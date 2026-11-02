import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/talent.mjs';
import * as controller from '../controllers/talentController.mjs';

/**
 * The talent roster. `profiles` and a talent's monologues are public, through
 * the allowlist; the rest is the Studio's (surname, phone and email included):
 * any Studio role reads, a Content Manager edits. A talent is addressed by its
 * slug (t-001), the same as its profile URL.
 */
const router = express.Router();
const slug = validate(schema.slugParam, 'params');
const editor = allow('content-manager');

router.get('/profiles', validate(schema.profilesQuery, 'query'), controller.listProfiles);
router.get('/profiles/:id', slug, controller.getProfile);
router.get('/:talentId/monologues', validate(schema.talentRefParam, 'params'), controller.listMonologues);

router.get('/', requireAdmin, controller.listTalent);
router.post('/', requireAdmin, editor, validate(schema.createTalentBody), controller.createTalent);
router.patch('/:id', slug, requireAdmin, editor, validate(schema.updateTalentBody), controller.updateTalent);
router.delete('/:id', slug, requireAdmin, editor, controller.deleteTalent);

export default router;
