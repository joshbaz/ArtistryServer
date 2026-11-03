import express from 'express';
import { z } from 'zod';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/academy.mjs';
import * as controller from '../controllers/websiteController.mjs';

/**
 * Live classes. The timetable and watching a free class are public; the
 * Studio's list, scheduling and the OBS details (Content Manager, never
 * cached) are not. The video provider's webhook is checked by its signature.
 */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');

router.get('/timetable', controller.timetable);
router.get('/live-classes/:id/watch', id, controller.watchClass);
router.post('/webhooks/:provider', validate(z.object({ provider: z.enum(['mux', 'cloudflare']) }), 'params'), controller.videoWebhook);

router.get('/live-classes', requireAdmin, controller.listLiveClasses);
router.post('/live-classes', requireAdmin, editor, validate(schema.createLiveClassBody), controller.createLiveClass);
router.patch('/live-classes/:id', id, requireAdmin, editor, validate(schema.updateLiveClassBody), controller.updateLiveClass);
router.delete('/live-classes/:id', id, requireAdmin, editor, controller.deleteLiveClass);
router.get('/live-classes/:id/ingest', id, requireAdmin, editor, controller.getIngest);

export default router;
