import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/gallery.mjs';
import * as controller from '../controllers/websiteController.mjs';

/** The gallery: /gallery reads the visible photos; the Studio reads all (`/photos`), a Content Manager edits. */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');

router.get('/', controller.getGallery);
router.get('/photos', requireAdmin, controller.listPhotos);
router.post('/', requireAdmin, editor, validate(schema.createPhotoBody), controller.createPhoto);
router.patch('/:id', id, requireAdmin, editor, validate(schema.updatePhotoBody), controller.updatePhoto);
router.delete('/:id', id, requireAdmin, editor, controller.deletePhoto);

export default router;
