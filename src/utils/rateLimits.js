import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { sendCommand } from './redis.mjs';
import { verifyAccessToken } from './tokens.mjs';

export const RATE_LIMITS = {
    api: { windowMinutes: 15, limit: 1500, keyedBy: 'signed-in user, otherwise IP' },
    login: { windowMinutes: 15, limit: 10, keyedBy: 'IP + email or phone, failed attempts only' },
    loginPerIp: { windowMinutes: 15, limit: 60, keyedBy: 'IP, all attempts' },
    studioLogin: { windowMinutes: 15, limit: 5, keyedBy: 'IP + email, failed attempts only' },
    forms: { windowMinutes: 60, limit: 10, keyedBy: 'IP' },
};

/**
 * Public writes anyone can send without signing in, each counted per IP:
 * booking requests, organiser requests, the contact form and support reports.
 */
const PUBLIC_RULES = [
    { name: 'forms', path: /\/(talent\/bookings|organisers\/requests|enquiries|support\/reports)$/, message: 'Thanks, we have plenty from you for now. Please try again later.' },
];

// Every member sign-in, sign-up, OTP and password-reset POST (12-backend-integration.md, auth).
const AUTH_PATH = /\/auth\/(login|register|google|apple|otp\/request|otp\/verify|password\/forgot|password\/reset)$/;
// The Studio's sign-in gets a stricter limit of its own (17-api-server.md, section 5).
const STUDIO_LOGIN_PATH = /\/auth\/studio\/login$/;

// ipKeyGenerator groups IPv6 addresses by subnet so a client can't rotate through them
const clientIp = (req) => ipKeyGenerator(req.ip || 'unknown');

// Key signed-in traffic per user so a whole campus behind one NAT IP is not throttled
// together. Unverifiable tokens fall back to the IP so random tokens can't dodge the limit.
const apiKey = (req) => {
    const payload = verifyAccessToken(req.headers['authorization']?.split(' ')[1]);
    return payload ? `${payload.realm}:${payload.id}` : `ip:${clientIp(req)}`;
};

// Who is trying to sign in: the email, or the phone for OTP.
const loginKey = (req) => `${clientIp(req)}:${String(req.body?.email || req.body?.phone || '').toLowerCase()}`;

const rejected = (message) => (req, res) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message, requestId: req.id } });
};

const minutes = (m) => m * 60 * 1000;

/**
 * One limiter with its own Redis counters (prefix), so every process shares
 * the count and a restart doesn't hand out a fresh allowance. If Redis is
 * down the request is let through and the outage logged (passOnStoreError),
 * rather than locking everyone out of signing in.
 */
const limiter = (prefix, { windowMinutes, limit }, options) => rateLimit({
    windowMs: minutes(windowMinutes),
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({ prefix: `artistry360:rl:${prefix}:`, sendCommand: (...args) => sendCommand(args) }),
    ...options,
});

const pathOf = (req) => (req.originalUrl || '').split('?')[0];

/**
 * Build the limiters once Redis is connected (the stores load a script into
 * Redis as they are made). Returns the general API limiter, the strict one
 * for sign-in, and the one for public forms.
 */
export const createRateLimiters = () => {
    const apiLimiter = limiter('api', RATE_LIMITS.api, {
        keyGenerator: apiKey,
        handler: rejected('Too many requests. Please slow down and try again shortly.'),
    });

    const loginPerEmailLimiter = limiter('login-email', RATE_LIMITS.login, {
        skipSuccessfulRequests: true,
        keyGenerator: loginKey,
        handler: rejected('Too many failed attempts. Please wait 15 minutes before trying again.'),
    });

    const studioLoginLimiter = limiter('studio-login', RATE_LIMITS.studioLogin, {
        skipSuccessfulRequests: true,
        keyGenerator: loginKey,
        handler: rejected('Too many failed attempts. Please wait 15 minutes before trying again.'),
    });

    const loginPerIpLimiter = limiter('login-ip', RATE_LIMITS.loginPerIp, {
        keyGenerator: clientIp,
        handler: rejected('Too many sign-in attempts from this network. Please try again later.'),
    });

    /** Applies the strict limiters to sign-in, registration, OTP and password-reset endpoints only. */
    const authLimiter = (req, res, next) => {
        if (req.method !== 'POST') return next();
        const path = pathOf(req);
        const perAccount = STUDIO_LOGIN_PATH.test(path) ? studioLoginLimiter : AUTH_PATH.test(path) ? loginPerEmailLimiter : null;
        if (!perAccount) return next();
        loginPerIpLimiter(req, res, (err) => (err ? next(err) : perAccount(req, res, next)));
    };

    const publicLimiters = PUBLIC_RULES.map((rule) => ({
        path: rule.path,
        run: limiter(rule.name, RATE_LIMITS[rule.name], { keyGenerator: clientIp, handler: rejected(rule.message) }),
    }));

    /** Applies each public rule's limiter to its own POSTs only. */
    const formsLimiter = (req, res, next) => {
        const path = pathOf(req);
        const rule = req.method === 'POST' && publicLimiters.find((l) => l.path.test(path));
        if (!rule) return next();
        rule.run(req, res, next);
    };

    return { apiLimiter, authLimiter, formsLimiter };
};
