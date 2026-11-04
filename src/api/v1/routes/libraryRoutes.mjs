import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { requireMember } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/streaming.mjs';
import * as controller from '../controllers/libraryController.mjs';

/**
 * `/library`: what a signed-in member keeps (stream site and app). GET
 * /library answers with all of it at once; each part also has its own path.
 */
const router = express.Router();
const title = validate(schema.libraryTitleParam, 'params');

router.use(requireMember);
router.get('/', controller.getLibrary);
router.get('/access', controller.getAccess);

router.get('/watchlist', controller.getWatchlist);
router.put('/watchlist/:titleId', title, controller.addToWatchlist);
router.delete('/watchlist/:titleId', title, controller.removeFromWatchlist);

router.get('/ratings', controller.getRatings);
router.put('/ratings/:titleId', title, validate(schema.ratingBody), controller.setRating);
router.delete('/ratings/:titleId', title, controller.clearRating);

router.get('/progress', controller.getProgress);
router.get('/episode-progress', controller.getEpisodeProgress);
router.put('/progress', validate(schema.progressBody), controller.saveProgress);
router.delete('/progress', controller.clearHistory);
router.delete('/progress/:titleId', title, controller.clearTitleProgress);

router.get('/comment-likes', controller.likedComments);

export default router;
