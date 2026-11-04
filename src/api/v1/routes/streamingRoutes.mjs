import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, optionalMember, requireAdmin, requireMember } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/streaming.mjs';
import * as controller from '../controllers/streamingController.mjs';

/**
 * Streaming. The stream site and the app read the public catalogue (published
 * titles, types, categories, warnings, active plans). The Studio reads
 * everything under /studio (any role), a Content Manager edits the library,
 * lists and ads, and Finance looks after plans and subscribers. A Content
 * Manager uploads videos (straight to Spaces); viewers play them through
 * /playback and /play.
 */
const router = express.Router();
const title = validate(schema.titleParam, 'params');
const season = validate(schema.seasonParam, 'params');
const episode = validate(schema.episodeParam, 'params');
const term = validate(schema.termParam, 'params');
const editor = [requireAdmin, allow('content-manager')];
const finance = [requireAdmin, allow('finance')];

/* Catalogue (public). ?published=true is what the clients send; only published titles are ever listed here. */
router.get('/titles', validate(schema.titlesQuery, 'query'), controller.listPublicTitles);
router.get('/titles/:id', title, controller.getPublicTitle);

/* Library (Studio) */
router.get('/studio/titles', requireAdmin, controller.listTitles);
router.get('/studio/titles/:id', title, requireAdmin, controller.getTitle);
router.post('/titles', ...editor, validate(schema.createTitleBody), controller.createTitle);
router.patch('/titles/:id', title, ...editor, validate(schema.updateTitleBody), controller.updateTitle);
router.delete('/titles/:id', title, ...editor, controller.deleteTitle);
router.delete('/titles/:id/video', title, ...editor, controller.removeTitleVideo);
router.patch('/titles/:id/trailer', title, ...editor, validate(schema.trailerBody), controller.setTrailer);
router.delete('/titles/:id/trailer', title, ...editor, controller.removeTrailer);

/* Seasons and episodes */
router.post('/titles/:id/seasons', title, ...editor, controller.addSeason);
router.patch('/titles/:id/seasons/:number', season, ...editor, validate(schema.seasonBody), controller.renameSeason);
router.delete('/titles/:id/seasons/:number', season, ...editor, controller.removeSeason);
router.post('/titles/:id/seasons/:number/episodes', season, ...editor, validate(schema.createEpisodeBody), controller.addEpisode);
router.patch('/titles/:id/episodes/:episodeId', episode, ...editor, validate(schema.updateEpisodeBody), controller.updateEpisode);
router.delete('/titles/:id/episodes/:episodeId', episode, ...editor, controller.deleteEpisode);
router.delete('/titles/:id/episodes/:episodeId/video', episode, ...editor, controller.removeEpisodeVideo);

/* Captions: a film's, or an episode's */
const captions = validate(schema.captionsParam, 'params');
const episodeCaptions = validate(schema.episodeCaptionsParam, 'params');
router.put('/titles/:id/captions/:lang', captions, ...editor, validate(schema.captionsBody), controller.setCaptions);
router.delete('/titles/:id/captions/:lang', captions, ...editor, controller.removeCaptions);
router.put('/titles/:id/episodes/:episodeId/captions/:lang', episodeCaptions, ...editor, validate(schema.captionsBody), controller.setCaptions);
router.delete('/titles/:id/episodes/:episodeId/captions/:lang', episodeCaptions, ...editor, controller.removeCaptions);

/* Types, categories, content warnings */
for (const [path, kind] of [['types', 'type'], ['categories', 'category'], ['advisories', 'advisory']]) {
    router.get(`/${path}`, controller.listTerms(kind));
    router.post(`/${path}`, ...editor, validate(schema.termBody), controller.createTerm(kind));
    router.patch(`/${path}/:id`, term, ...editor, validate(schema.termBody), controller.updateTerm(kind));
    router.delete(`/${path}/:id`, term, ...editor, controller.deleteTerm(kind));
}

/* Plans and subscribers */
router.get('/plans', controller.listPlans);
router.get('/studio/plans', requireAdmin, controller.listAllPlans);
router.post('/plans', ...finance, validate(schema.createPlanBody), controller.createPlan);
router.patch('/plans/:id', term, ...finance, validate(schema.updatePlanBody), controller.updatePlan);
router.delete('/plans/:id', term, ...finance, controller.deletePlan);
router.get('/subscribers', ...finance, controller.listSubscribers);

/* Uploads */
const upload = validate(schema.uploadParam, 'params');
router.post('/uploads', ...editor, validate(schema.startUploadBody), controller.startUpload);
router.get('/uploads/:assetId', upload, ...editor, controller.getUpload);
router.post('/uploads/:assetId/parts', upload, ...editor, validate(schema.signPartsBody), controller.signParts);
router.post('/uploads/:assetId/complete', upload, ...editor, controller.completeUpload);
router.post('/uploads/:assetId/abort', upload, ...editor, validate(schema.abortUploadBody), controller.abortUpload);

/* Playback: a link for one viewer, then the playlists and key it points at */
router.post('/playback', optionalMember, validate(schema.playbackBody), controller.startPlayback);
router.post('/studio/playback', requireAdmin, validate(schema.playbackBody), controller.previewPlayback);
router.get('/play/:token/master.m3u8', validate(schema.playParam, 'params'), controller.masterPlaylist);
router.get('/play/:token/key', validate(schema.playParam, 'params'), controller.playbackKey);
router.get('/play/:token/:rendition/index.m3u8', validate(schema.playRenditionParam, 'params'), controller.renditionPlaylist);

/* Comments */
const comment = validate(schema.commentParam, 'params');
router.get('/titles/:id/comments', title, controller.listComments);
router.post('/titles/:id/comments', title, requireMember, validate(schema.commentBody), controller.postComment);
router.delete('/titles/:id/comments/:cid', comment, requireMember, controller.deleteComment);
router.post('/titles/:id/comments/:cid/like', comment, requireMember, controller.likeComment);
router.post('/titles/:id/comments/:cid/report', comment, requireMember, controller.reportComment);
router.get('/studio/comments', ...editor, validate(schema.studioCommentsQuery, 'query'), controller.studioComments);
router.patch('/studio/comments/:cid', validate(schema.studioCommentParam, 'params'), ...editor, validate(schema.hideCommentBody), controller.hideComment);
router.delete('/studio/comments/:cid', validate(schema.studioCommentParam, 'params'), ...editor, controller.studioDeleteComment);

/* Ads (the app IDs and ad tag are the Studio's to see) */
router.get('/ads', requireAdmin, controller.getAds);
router.patch('/ads', ...editor, validate(schema.adsBody), controller.updateAds);

export default router;

/** `/stream`: the stream site's home page settings (public read, a Content Manager edits). */
export const streamSiteRouter = express.Router();
streamSiteRouter.get('/site', controller.getStreamSite);
// What the players need to show free viewers ads.
streamSiteRouter.get('/ads', controller.getPublicAds);
streamSiteRouter.patch('/site', ...editor, validate(schema.streamSiteBody), controller.updateStreamSite);
