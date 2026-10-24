import { env } from '../env.mjs';

/**
 * The refresh cookies, one per realm (14-state-management.md, section 9):
 * httpOnly, SameSite=strict, and scoped to that realm's auth path so the
 * browser sends it nowhere else.
 */
const REFRESH_COOKIES = {
    admin: { name: 'a360_rt_staff', path: '/api/v1/auth/studio' },
    member: { name: 'a360_rt_member', path: '/api/v1/auth' },
};

const base = (realm) => ({
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIES[realm].path,
});

/** @param {import('express').Response} res */
export const setRefreshCookie = (res, realm, token, expiresAt) =>
    res.cookie(REFRESH_COOKIES[realm].name, token, { ...base(realm), expires: expiresAt });

/** @param {import('express').Response} res */
export const clearRefreshCookie = (res, realm) => res.clearCookie(REFRESH_COOKIES[realm].name, base(realm));

/** @param {import('express').Request} req */
export const readRefreshCookie = (req, realm) => req.cookies?.[REFRESH_COOKIES[realm].name] ?? null;
