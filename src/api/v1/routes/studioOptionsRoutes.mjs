import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/options.mjs';
import * as controller from '../controllers/websiteController.mjs';

/** The Studio's editable dropdown lists. Any Studio role reads; a Content Manager adds. */
const router = express.Router();

router.use(requireAdmin);
router.get('/', controller.getOptionLists);
router.post('/:list', validate(schema.listParam, 'params'), allow('content-manager'), validate(schema.addOptionBody), controller.addOption);

export default router;
