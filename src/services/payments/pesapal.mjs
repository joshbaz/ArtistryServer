import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { redis } from '../../utils/redis.mjs';

/**
 * PesaPal API 3.0 (developer.pesapal.com): MTN MoMo, Airtel Money and cards
 * on PesaPal's own page. We never see a card or a PIN. Nothing here decides
 * that a payment happened; `getStatus` asks PesaPal, and only that answer
 * moves an order on (services/payments/orders.mjs).
 */

const BASES = {
    sandbox: 'https://cybqa.pesapal.com/pesapalv3/api',
    live: 'https://pay.pesapal.com/v3/api',
};
const BASE = env.PESAPAL_BASE_URL ?? BASES[env.PESAPAL_ENV];
const TIMEOUT_MS = 15_000;

export const IPN_URL = env.PESAPAL_IPN_URL ?? `${env.API_URL}/api/v1/payments/pesapal/ipn`;

export const isPesapalConfigured = () => Boolean(env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET);

const unreachable = () => new AppError("We couldn't reach PesaPal just now. Please try again in a moment.", 502, { code: 'PAYMENT_PROVIDER_UNAVAILABLE' });

// `answerErrors`: PesaPal's own error reply (an unknown order, say) comes back as data, not as "unreachable".
const call = async (method, path, { body, token, answerErrors = false } = {}) => {
    let response;
    try {
        response = await fetch(`${BASE}${path}`, {
            method,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        console.error(`PesaPal ${path} unreachable:`, error.message);
        throw unreachable();
    }
    const data = await response.json().catch(() => null);
    if (answerErrors && data?.error && (data.error.code || data.error.message)) return data;
    if (!response.ok || !data) {
        console.error(`PesaPal ${path} answered ${response.status}`);
        throw unreachable();
    }
    return data;
};

// PesaPal tokens last five minutes; one is shared until shortly before it runs out.
let cached = null;

const accessToken = async () => {
    if (cached && cached.expiresAt - Date.now() > 30_000) return cached.token;
    if (!isPesapalConfigured()) throw new AppError('Online payments are not set up yet.', 503, { code: 'PAYMENTS_NOT_CONFIGURED' });
    const data = await call('POST', '/Auth/RequestToken', { body: { consumer_key: env.PESAPAL_CONSUMER_KEY, consumer_secret: env.PESAPAL_CONSUMER_SECRET } });
    if (!data.token) {
        console.error('PesaPal refused the consumer key:', data.error?.code ?? data.message);
        throw unreachable();
    }
    cached = { token: data.token, expiresAt: Date.parse(data.expiryDate) || Date.now() + 4 * 60_000 };
    return cached.token;
};

/**
 * The IPN id every order names. Registered once per URL and remembered in
 * Redis, because each registration makes a new id at PesaPal.
 */
let ipnId = null;
const IPN_KEY = `artistry360:pesapal:${env.PESAPAL_ENV}:ipn:${IPN_URL}`;

const notificationId = async () => {
    if (ipnId) return ipnId;
    ipnId = await redis.get(IPN_KEY).catch(() => null);
    if (ipnId) return ipnId;
    const token = await accessToken();
    const existing = await call('GET', '/URLSetup/GetIpnList', { token });
    ipnId = Array.isArray(existing) ? existing.find((i) => i.url === IPN_URL && i.ipn_status === 1)?.ipn_id : null;
    if (!ipnId) {
        const registered = await call('POST', '/URLSetup/RegisterIPN', { token, body: { url: IPN_URL, ipn_notification_type: 'GET' } });
        ipnId = registered.ipn_id;
        if (!ipnId) throw unreachable();
    }
    await redis.set(IPN_KEY, ipnId).catch(() => {});
    return ipnId;
};

/**
 * Open a checkout at PesaPal. PesaPal sends the payer back to
 * `callbackUrl?OrderTrackingId=…&OrderMerchantReference=…`, so the URL must
 * carry no query string of its own.
 * @param {{ reference: string, amountUGX: number, description: string, callbackUrl: string }} order
 * @returns {Promise<{ trackingId: string, redirectUrl: string }>}
 */
export const submitOrder = async ({ reference, amountUGX, description, callbackUrl }) => {
    const token = await accessToken();
    const data = await call('POST', '/Transactions/SubmitOrderRequest', {
        token,
        body: {
            id: reference,
            currency: 'UGX',
            amount: amountUGX,
            description: description.slice(0, 100),
            callback_url: callbackUrl,
            notification_id: await notificationId(),
            // Required, but may be empty: PesaPal's page asks for what it needs, so our pages never do.
            billing_address: {},
        },
    });
    if (!data.order_tracking_id || !data.redirect_url) {
        console.error('PesaPal refused an order:', data.error?.code ?? data.message);
        throw unreachable();
    }
    return { trackingId: data.order_tracking_id, redirectUrl: data.redirect_url };
};

// PesaPal's status codes (GetTransactionStatus). 0 (INVALID) also covers a checkout nobody has paid yet, so it means "not yet".
const STATES = { 1: 'completed', 2: 'failed', 3: 'reversed' };
const NAMES = { 0: 'INVALID', 1: 'COMPLETED', 2: 'FAILED', 3: 'REVERSED' };

/**
 * What PesaPal says about an order now. `status` and `note` are its answer
 * as it gave it (the code's name and its reason, or ERROR and its error),
 * for the Studio to show. The payer's account (`payment_account`) is never read.
 * @param {string} trackingId
 * @returns {Promise<{ state: 'pending' | 'completed' | 'failed' | 'reversed', status: string, note: string, amount: number, currency: string, method: string, confirmationCode: string, reference: string }>}
 */
/** PesaPal's status reply as it came, less the payer's account fields (scripts/check-pending-payments.mjs). */
export const rawStatus = async (trackingId) => {
    const token = await accessToken();
    // eslint-disable-next-line no-unused-vars
    const { payment_account, account_number, ...reply } = await call('GET', `/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`, { token, answerErrors: true });
    return reply;
};

export const getStatus = async (trackingId) => {
    const token = await accessToken();
    const data = await call('GET', `/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`, { token, answerErrors: true });
    // Both come back as status 0 with an error: an unpaid checkout (payment_details_not_found,
    // "Pending Payment") and an order PesaPal doesn't know (invalid_order_tracking_id). Only the
    // first is "not paid yet"; any other error is an ERROR.
    const raw = data.error?.code || data.error?.message ? data.error : null;
    const error = raw && raw.code !== 'payment_details_not_found' ? raw : null;
    const code = error ? undefined : data.status_code;
    const known = code in NAMES;
    return {
        state: STATES[code] ?? 'pending',
        status: known ? NAMES[code] : error ? 'ERROR' : String(data.payment_status_description ?? '').toUpperCase(),
        note: String((error ? [error.code, error.message].filter(Boolean).join(': ') : data.description || raw?.message) ?? '').slice(0, 300),
        amount: Number(data.amount) || 0,
        currency: data.currency ?? '',
        method: data.payment_method ?? '',
        confirmationCode: data.confirmation_code ?? '',
        reference: data.merchant_reference ?? '',
    };
};
