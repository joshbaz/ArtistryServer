import express from 'express';
import { requireAdmin } from '../../../middleware/auth.mjs';
import * as controller from '../controllers/contactController.mjs';

/** Studio › Overview. Any Studio role; the money in it only for Finance (services/studio/overview.mjs). */
const router = express.Router();

router.get('/', requireAdmin, controller.getOverview);

export default router;
