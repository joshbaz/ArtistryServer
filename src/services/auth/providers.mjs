import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';

/**
 * Sign-in with Google and Apple: the page (or the app's native sheet) gets an
 * ID token from the provider, and the server checks it here: signed by the
 * provider's published keys, issued by the provider, for one of our client
 * ids, and not expired. Only then is the person behind it trusted.
 */

// jose caches each key set and refetches when the provider rotates its keys.
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_KEYS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const PROVIDERS = {
    google: {
        keys: GOOGLE_KEYS,
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: () => [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_ANDROID_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID].filter(Boolean),
        label: 'Google',
    },
    apple: {
        keys: APPLE_KEYS,
        issuer: 'https://appleid.apple.com',
        audience: () => [env.APPLE_SERVICES_ID, env.APPLE_BUNDLE_ID].filter(Boolean),
        label: 'Apple',
    },
};

// Apple sends booleans as "true" / "false" strings.
const yes = (v) => v === true || v === 'true';

/**
 * Who an ID token belongs to, once its signature, issuer, audience and expiry check out.
 * @param {'google' | 'apple'} provider
 * @param {string} idToken
 * @returns {Promise<{ provider: string, subject: string, email: string | null, emailVerified: boolean, name: string, picture: string }>}
 */
export const verifyIdToken = async (provider, idToken) => {
    const p = PROVIDERS[provider];
    const audience = p.audience();
    if (!audience.length) {
        throw new AppError(`Signing in with ${p.label} isn't available yet.`, 503, { code: 'provider_not_configured' });
    }
    let claims;
    try {
        ({ payload: claims } = await jwtVerify(idToken, p.keys, { issuer: p.issuer, audience, algorithms: ['RS256'] }));
    } catch (error) {
        // A network failure fetching the keys is ours to fix, not the person's.
        if (error?.code === 'ERR_JWKS_TIMEOUT' || error?.cause?.code === 'ECONNREFUSED') {
            console.error(`${p.label} sign-in keys unreachable:`, error.message);
            throw new AppError(`We couldn't reach ${p.label} just now. Please try again.`, 503);
        }
        throw new AppError(`${p.label} sign-in didn't go through. Please try again.`, 401, { code: 'INVALID_ID_TOKEN' });
    }
    if (!claims.sub) throw new AppError(`${p.label} sign-in didn't go through. Please try again.`, 401, { code: 'INVALID_ID_TOKEN' });
    return {
        provider,
        subject: String(claims.sub),
        email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null,
        emailVerified: yes(claims.email_verified),
        name: typeof claims.name === 'string' ? claims.name.trim() : '',
        picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : '',
    };
};
