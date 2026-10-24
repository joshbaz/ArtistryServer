import { AppError } from '../utils/AppError.js';
import { corsOptions } from '../utils/corsOptions.js';
import { roleAllows } from '../utils/permissions.mjs';
import { verifyAccessToken } from '../utils/tokens.mjs';
import { isSessionOpen } from '../services/auth/sessions.mjs';
import { findActiveStaff, toAdminUser } from '../services/auth/staff.mjs';

const bearer = (req) => req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? null;

const signInFirst = () => new AppError('Please sign in to continue.', 401);

/**
 * A Studio route: needs an admin-realm access token whose session is still
 * open and whose account is still active, so signing out or suspending
 * someone takes effect at their next request. Sets `req.admin` and `req.sessionId`.
 */
export const requireAdmin = async (req, res, next) => {
    const payload = verifyAccessToken(bearer(req), 'admin');
    if (!payload) return next(signInFirst());
    const [open, staff] = await Promise.all([isSessionOpen(payload.sid), findActiveStaff(payload.id)]);
    if (!open || !staff) return next(signInFirst());
    req.admin = toAdminUser(staff);
    req.sessionId = payload.sid;
    next();
};

/**
 * Only these Studio roles (MOU 3C) may continue; a Super Admin always may.
 * Use after requireAdmin: `requireAdmin, allow('finance')`.
 * @param {...string} roles
 */
export const allow = (...roles) => (req, res, next) => {
    if (!req.admin) return next(signInFirst());
    if (!roleAllows(req.admin.role, roles)) return next(new AppError('Your role does not have access to that.', 403));
    next();
};

/**
 * For routes that act on a cookie alone (refresh, sign out): refuse a
 * browser request from a site we don't know. SameSite=strict already keeps
 * the cookie off cross-site requests; this is the second lock.
 */
export const knownOrigin = (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !corsOptions.origin.includes(origin)) return next(new AppError('That request came from somewhere we do not know.', 403));
    next();
};
