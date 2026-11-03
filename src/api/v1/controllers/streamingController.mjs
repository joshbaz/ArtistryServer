import * as titles from '../../../services/streaming/titles.mjs';
import * as terms from '../../../services/streaming/terms.mjs';
import * as plans from '../../../services/streaming/plans.mjs';
import * as settings from '../../../services/streaming/settings.mjs';

/**
 * Studio › Streaming and the catalogue stream.theartistry360.com and the app
 * read: titles, types, categories, content warnings, plans, the stream
 * site's home page and the ad settings.
 */

const created = (res, data) => res.status(201).json({ data });
const gone = (res) => res.status(204).end();

/* Catalogue (public) */
export const listPublicTitles = async (req, res) => res.json({ data: await titles.listPublicTitles({ q: req.query.q }) });
export const getPublicTitle = async (req, res) => res.json({ data: await titles.getPublicTitle(req.params.id) });

/* Library (Studio) */
export const listTitles = async (req, res) => res.json({ data: await titles.listTitles() });
export const getTitle = async (req, res) => res.json({ data: await titles.getTitle(req.params.id) });
export const createTitle = async (req, res) => created(res, await titles.createTitle(req.body));
export const updateTitle = async (req, res) => res.json({ data: await titles.updateTitle(req.params.id, req.body) });
export const deleteTitle = async (req, res) => gone(res, await titles.deleteTitle(req.params.id));
export const removeTitleVideo = async (req, res) => res.json({ data: await titles.removeTitleVideo(req.params.id) });
export const setTrailer = async (req, res) => res.json({ data: await titles.setTrailerAutoplay(req.params.id, req.body.autoplay) });
export const removeTrailer = async (req, res) => res.json({ data: await titles.removeTrailer(req.params.id) });

/* Seasons and episodes (Studio); each answers with the whole title */
export const addSeason = async (req, res) => created(res, await titles.addSeason(req.params.id));
export const renameSeason = async (req, res) => res.json({ data: await titles.renameSeason(req.params.id, req.params.number, req.body.title) });
export const removeSeason = async (req, res) => res.json({ data: await titles.removeSeason(req.params.id, req.params.number) });
/** → { title, episodeId } */
export const addEpisode = async (req, res) => created(res, await titles.addEpisode(req.params.id, req.params.number, req.body));
export const updateEpisode = async (req, res) => res.json({ data: await titles.updateEpisode(req.params.id, req.params.episodeId, req.body) });
export const deleteEpisode = async (req, res) => res.json({ data: await titles.deleteEpisode(req.params.id, req.params.episodeId) });
export const removeEpisodeVideo = async (req, res) => res.json({ data: await titles.removeEpisodeVideo(req.params.id, req.params.episodeId) });

/* Types, categories, content warnings: `kind` is set by the route */
export const listTerms = (kind) => async (req, res) => res.json({ data: await terms.listTerms(kind) });
export const createTerm = (kind) => async (req, res) => created(res, await terms.createTerm(kind, req.body.name));
export const updateTerm = (kind) => async (req, res) => res.json({ data: await terms.updateTerm(kind, req.params.id, req.body.name) });
export const deleteTerm = (kind) => async (req, res) => gone(res, await terms.deleteTerm(kind, req.params.id));

/* Plans */
export const listPlans = async (req, res) => res.json({ data: await plans.listPlans() });
export const listAllPlans = async (req, res) => res.json({ data: await plans.listAllPlans() });
export const createPlan = async (req, res) => created(res, await plans.createPlan(req.body));
export const updatePlan = async (req, res) => res.json({ data: await plans.updatePlan(req.params.id, req.body) });
export const deletePlan = async (req, res) => gone(res, await plans.deletePlan(req.params.id));
export const listSubscribers = async (req, res) => res.json({ data: await plans.listSubscribers() });

/* Settings documents */
export const getStreamSite = async (req, res) => res.json({ data: await settings.getStreamSite() });
export const updateStreamSite = async (req, res) => res.json({ data: await settings.updateStreamSite(req.body) });
export const getAds = async (req, res) => res.json({ data: await settings.getAds() });
export const updateAds = async (req, res) => res.json({ data: await settings.updateAds(req.body) });
