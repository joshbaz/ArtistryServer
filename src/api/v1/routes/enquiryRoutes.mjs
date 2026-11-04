import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/contact.mjs';
import * as controller from '../controllers/contactController.mjs';

/**
 * The contact form. A guest sends a message (public, rate limited per IP in
 * utils/rateLimits.js); any Studio role reads them, a Content Manager marks
 * them read.
 */
const router = express.Router();

router.post('/', validate(schema.enquiryBody), controller.sendEnquiry);
router.get('/', requireAdmin, controller.listEnquiries);
router.patch('/:id', validate(idParam, 'params'), requireAdmin, allow('content-manager'), validate(schema.readBody), controller.setEnquiryRead);

export default router;
