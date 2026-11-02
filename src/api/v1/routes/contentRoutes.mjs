import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/content.mjs';
import * as controller from '../controllers/websiteController.mjs';

/**
 * News & Events. The site reads published ones (`events`); the Studio reads
 * and edits all of them (`news`): any Studio role reads, a Content Manager edits.
 */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');

router.get('/events', controller.listEvents);
router.get('/events/:id', id, controller.getEvent);

router.get('/news', requireAdmin, controller.listArticles);
router.post('/news', requireAdmin, editor, validate(schema.createArticleBody), controller.createArticle);
router.patch('/news/:id', id, requireAdmin, editor, validate(schema.updateArticleBody), controller.updateArticle);
router.delete('/news/:id', id, requireAdmin, editor, controller.deleteArticle);

export default router;
