import * as library from '../../../services/streaming/library.mjs';
import * as comments from '../../../services/streaming/comments.mjs';
import * as access from '../../../services/streaming/access.mjs';

/**
 * A member's own corner of the stream site and the app: My List, ratings,
 * progress, the comments they liked, and what they may watch. Always the
 * signed-in member (requireMember), never one named in the request.
 */
const me = (req) => req.member.id;

export const getLibrary = async (req, res) => res.json({ data: await library.getLibrary(me(req)) });
export const getAccess = async (req, res) => res.json({ data: await access.getAccess(me(req)) });

export const getWatchlist = async (req, res) => res.json({ data: await library.getWatchlist(me(req)) });
export const addToWatchlist = async (req, res) => res.json({ data: await library.addToWatchlist(me(req), req.params.titleId) });
export const removeFromWatchlist = async (req, res) => res.json({ data: await library.removeFromWatchlist(me(req), req.params.titleId) });

export const getRatings = async (req, res) => res.json({ data: await library.getRatings(me(req)) });
export const setRating = async (req, res) => res.json({ data: await library.setRating(me(req), req.params.titleId, req.body.rating) });
export const clearRating = async (req, res) => res.json({ data: await library.clearRating(me(req), req.params.titleId) });

export const getProgress = async (req, res) => res.json({ data: await library.getProgress(me(req)) });
export const getEpisodeProgress = async (req, res) => res.json({ data: await library.getEpisodeProgress(me(req)) });
export const saveProgress = async (req, res) => res.json({ data: await library.saveProgress(me(req), req.body) });
export const clearTitleProgress = async (req, res) => res.json({ data: await library.clearTitleProgress(me(req), req.params.titleId) });
export const clearHistory = async (req, res) => {
    await library.clearHistory(me(req));
    res.status(204).end();
};

export const likedComments = async (req, res) => res.json({ data: await comments.likedBy(me(req)) });
