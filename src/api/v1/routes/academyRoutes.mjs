import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/academy.mjs';
import * as controller from '../controllers/websiteController.mjs';

/**
 * Live classes. `?upcoming=true` is the public /classes timetable; without
 * it, the Studio's full list. A Content Manager schedules; the OBS details
 * are the Studio's only, never cached.
 */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');

router.get('/live-classes', (req, res, next) => (req.query.upcoming === 'true' ? controller.listUpcomingClasses(req, res) : next()), requireAdmin, controller.listLiveClasses);
router.post('/live-classes', requireAdmin, editor, validate(schema.createLiveClassBody), controller.createLiveClass);
router.patch('/live-classes/:id', id, requireAdmin, editor, validate(schema.updateLiveClassBody), controller.updateLiveClass);
router.delete('/live-classes/:id', id, requireAdmin, editor, controller.deleteLiveClass);
router.get('/live-classes/:id/ingest', id, requireAdmin, editor, controller.getIngest);

export default router;
