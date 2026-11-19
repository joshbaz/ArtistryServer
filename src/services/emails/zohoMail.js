import nodemailer from 'nodemailer';
import { env } from '../../env.mjs';

/**
 * Sending email, the first of these that's set up:
 *   1. ZeptoMail's API (HTTPS, so a DigitalOcean Droplet can use it: Droplets block the SMTP ports).
 *   2. The site's Netlify mail relay, which sends through Gmail (HTTPS too). Also the fallback when
 *      ZeptoMail refuses an email (no credits, domain not verified, bad token).
 *   3. Zoho Mail's SMTP server (for a host that allows SMTP).
 * Every email the server sends comes here, so callers never know which is in use. Sends are fired off
 * the request path by the callers, so a slow or failing send never holds up a request.
 */

const hasZepto = () => Boolean(env.ZEPTOMAIL_TOKEN);
const hasRelay = () => Boolean(env.MAIL_RELAY_URL && env.MAIL_RELAY_KEY);
const hasSmtp = () => Boolean(env.ZOHO_SMTP_USER && env.ZOHO_SMTP_PASSWORD);

/** Whether any way of sending is set up. */
export const isMailConfigured = () => hasZepto() || hasRelay() || hasSmtp();

/** Which way email goes first, for the test script and the logs. */
export const mailRoute = () => (hasZepto() ? 'zeptomail' : hasRelay() ? 'relay' : hasSmtp() ? 'smtp' : 'none');

const from = () => env.MAIL_FROM || `The Artistry360 <${env.ZOHO_SMTP_USER}>`;

/** "The Artistry360 <info@…>" or a bare address → { name, address }. */
const parseAddress = (value) => {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value ?? '');
    return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(value ?? '').trim() };
};

/* ZeptoMail */

const ZEPTO_TIMEOUT_MS = 30_000;

// The token is shown with its "Zoho-enczapikey " prefix in some screens and without it in others.
const zeptoAuth = () => (/^zoho-enczapikey\s/i.test(env.ZEPTOMAIL_TOKEN) ? env.ZEPTOMAIL_TOKEN : `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`);

/** ZeptoMail's reason for a refusal, without the request's content (it can hold a buyer's email). */
const zeptoError = (status, body) => {
    const e = body?.error;
    const detail = e?.details?.map((d) => [d.code, d.message, d.target].filter(Boolean).join(' ')).join('; ');
    const error = new Error(`ZeptoMail refused the email (${status}): ${[e?.code, e?.message, detail].filter(Boolean).join(' · ') || 'no reason given'}`);
    error.status = status;
    return error;
};

const sendWithZepto = async ({ to, subject, text, html, attachments }) => {
    const sender = parseAddress(from());
    const replyTo = env.MAIL_REPLY_TO ? parseAddress(env.MAIL_REPLY_TO) : null;
    const response = await fetch(env.ZEPTOMAIL_API_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: zeptoAuth() },
        body: JSON.stringify({
            from: { address: sender.address, ...(sender.name ? { name: sender.name } : {}) },
            to: [{ email_address: { address: to } }],
            subject,
            ...(html ? { htmlbody: html } : {}),
            ...(text ? { textbody: text } : {}),
            ...(replyTo ? { reply_to: [{ address: replyTo.address, ...(replyTo.name ? { name: replyTo.name } : {}) }] } : {}),
            ...(attachments?.length
                ? { attachments: attachments.map((a) => ({ name: a.filename, mime_type: a.contentType, content: Buffer.from(a.content).toString('base64') })) }
                : {}),
        }),
        signal: AbortSignal.timeout(ZEPTO_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw zeptoError(response.status, body);
    return body?.request_id ?? '';
};

/* Netlify mail relay (Gmail) */

const RELAY_TIMEOUT_MS = 30_000;

const sendWithRelay = async ({ to, subject, text, html, attachments }) => {
    const replyTo = env.MAIL_REPLY_TO ? parseAddress(env.MAIL_REPLY_TO).address : null;
    const response = await fetch(env.MAIL_RELAY_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${env.MAIL_RELAY_KEY}` },
        body: JSON.stringify({
            to,
            subject,
            text,
            html,
            // Gmail sends from its own address; the name and the reply address are ours.
            fromName: parseAddress(from()).name || 'The Artistry360',
            ...(replyTo ? { replyTo } : {}),
            ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content).toString('base64') })) } : {}),
        }),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(`The mail relay didn't send it (${response.status}): ${body?.error ?? 'no reason given'}`);
        error.status = response.status;
        throw error;
    }
    return body?.id ?? '';
};

/* Zoho Mail SMTP */

let transport = null;

const getTransport = () => {
    transport ??= nodemailer.createTransport({
        host: env.ZOHO_SMTP_HOST,
        port: env.ZOHO_SMTP_PORT,
        // 465 is SSL from the start; 587 upgrades with STARTTLS.
        secure: env.ZOHO_SMTP_PORT === 465,
        auth: { user: env.ZOHO_SMTP_USER, pass: env.ZOHO_SMTP_PASSWORD },
        // Reuse one connection for a run of emails rather than signing in for each.
        pool: true,
        maxConnections: 1,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
    });
    return transport;
};

const sendWithSmtp = async ({ to, subject, text, html, attachments }) => {
    const info = await getTransport().sendMail({
        from: from(),
        to,
        subject,
        text,
        html,
        ...(attachments?.length ? { attachments } : {}),
        ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    });
    return info.messageId;
};

/**
 * Send one email. Throws on failure so the caller can retry it.
 * @param {{ to: string, subject: string, text: string, html: string, attachments?: { filename: string, content: Buffer, contentType: string }[] }} email
 * @returns {Promise<string>} the provider's id for it
 */
export const sendMail = async (email) => {
    if (hasZepto()) {
        try {
            return await sendWithZepto(email);
        } catch (error) {
            // Only when ZeptoMail answered "no": after a timeout it may have sent it, and the buyer would get two.
            if (!error.status || !hasRelay()) throw error;
            console.error(`${error.message}. Sending through the mail relay instead.`);
            return sendWithRelay(email);
        }
    }
    if (hasRelay()) return sendWithRelay(email);
    return sendWithSmtp(email);
};

/** Check the SMTP mailbox can be reached and signed in to (ZeptoMail has no such check: send a test email). */
export const verifyMail = () => getTransport().verify();
