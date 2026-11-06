import * as news from '../../../services/content/news.mjs';
import * as gallery from '../../../services/gallery/gallery.mjs';
import * as classYears from '../../../services/content/classYears.mjs';
import * as options from '../../../services/system/options.mjs';
import * as live from '../../../services/academy/liveClasses.mjs';

/**
 * Studio › Website and the public pages it feeds: News & Events, the
 * gallery, live classes, and the Studio's option lists. Talent and bookings
 * are in talentController.mjs.
 */

const created = (res, data) => res.status(201).json({ data });
const gone = (res) => res.status(204).end();

/* News & Events */
export const listArticles = async (req, res) => res.json({ data: await news.listArticles() });
export const createArticle = async (req, res) => created(res, await news.createArticle(req.body));
export const updateArticle = async (req, res) => res.json({ data: await news.updateArticle(req.params.id, req.body) });
export const deleteArticle = async (req, res) => gone(res, await news.deleteArticle(req.params.id));
export const listEvents = async (req, res) => res.json({ data: await news.listEvents() });
export const getEvent = async (req, res) => res.json({ data: await news.getEvent(req.params.id) });

/* Class year photos */
export const listClassYears = async (req, res) => res.json({ data: await classYears.listVisible() });
export const listAllClassYears = async (req, res) => res.json({ data: await classYears.listAll() });
export const createClassYear = async (req, res) => created(res, await classYears.create(req.body));
export const updateClassYear = async (req, res) => res.json({ data: await classYears.update(req.params.id, req.body) });
export const deleteClassYear = async (req, res) => gone(res, await classYears.remove(req.params.id));

/* Gallery */
export const getGallery = async (req, res) => res.json({ data: await gallery.getGallery() });
export const listPhotos = async (req, res) => res.json({ data: await gallery.listPhotos() });
export const createPhoto = async (req, res) => created(res, await gallery.createPhoto(req.body));
export const updatePhoto = async (req, res) => res.json({ data: await gallery.updatePhoto(req.params.id, req.body) });
export const deletePhoto = async (req, res) => gone(res, await gallery.deletePhoto(req.params.id));

/* Option lists */
export const getOptionLists = async (req, res) => res.json({ data: await options.getOptionLists() });
/** → { value }: the value to select, the existing spelling if it was already there. */
export const addOption = async (req, res) => res.json({ data: { value: await options.addOption(req.params.list, req.body.value) } });

/* Live classes */
export const listLiveClasses = async (req, res) => res.json({ data: await live.listLiveClasses() });
export const timetable = async (req, res) => res.json({ data: await live.listPublicClasses() });
/** → { kind: 'live' | 'replay', url }: an HLS link, never cached (a signed one expires). */
export const watchClass = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: await live.getPlayback(req.params.id) });
};
/** The video provider's webhook. A 401 for a bad signature; anything else we got is a 200, so it isn't sent again. */
export const videoWebhook = async (req, res) => {
    await live.handleWebhook(req.params.provider, req.rawBody, req.headers);
    res.json({ received: true });
};
export const createLiveClass = async (req, res) => created(res, await live.createLiveClass(req.body));
export const updateLiveClass = async (req, res) => res.json({ data: await live.updateLiveClass(req.params.id, req.body) });
export const deleteLiveClass = async (req, res) => gone(res, await live.deleteLiveClass(req.params.id));
export const getIngest = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: await live.getIngest(req.params.id) });
};
