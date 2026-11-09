import { env } from '../../env.mjs';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';

/**
 * The buyer's tickets by email: the event, the order reference, what was
 * paid and every code. Sending never holds up or fails the order (the page
 * shows the codes too); a failed send is tried once more, then logged.
 * Everything the buyer or the Studio typed is escaped.
 */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (ugx) => `UGX ${ugx.toLocaleString('en')}`;
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

const message = ({ event, tickets, buyerName, reference, totalUGX, complimentary }) => {
    const page = `${env.APP_URL}/tickets/${encodeURIComponent(event.id)}`;
    const details = [when(event.startsAt), event.venue].filter(Boolean).join(' · ');
    const paid = complimentary ? 'Complimentary' : totalUGX ? `Paid ${money(totalUGX)}` : 'Free';
    const lines = tickets.map((t) => `${t.code}  ${t.typeName}`);
    const text = [
        `Hello ${buyerName},`, '',
        `Your tickets for ${event.title}${details ? ` (${details})` : ''}.`,
        `Order ${reference} · ${paid}`, '',
        ...lines, '',
        'Show a code at the door: one code lets one person in, once. Keep them private.',
        `Your tickets and QR codes: ${page}`,
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">Your tickets for ${escape(event.title)}</h1>
${details ? `<p>${escape(details)}</p>` : ''}
<p>Hello ${escape(buyerName)}. Order <strong>${escape(reference)}</strong> · ${escape(paid)}</p>
<table style="border-collapse:collapse;width:100%">${tickets.map((t) => `<tr><td style="padding:10px;border:1px solid #ddd;font-family:monospace;font-size:20px;letter-spacing:2px">${escape(t.code)}</td><td style="padding:10px;border:1px solid #ddd">${escape(t.typeName)}</td></tr>`).join('')}</table>
<p>Show a code at the door: one code lets one person in, once. Keep them private.</p>
<p><a href="${escape(page)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">See your tickets</a></p>
</div>`;
    return { subject: `Your tickets: ${event.title}`, text, html };
};

/** Never throws; not awaited by the order. */
export const sendTicketsEmail = ({ to, ...ticket }) => {
    if (!isMailConfigured() || !to) return;
    const mail = { to, ...message(ticket) };
    sendMail(mail)
        .catch(() => new Promise((resolve) => setTimeout(resolve, 30_000)).then(() => sendMail(mail)))
        .catch((error) => console.error(`Tickets email for ${ticket.reference} failed:`, error.message));
};
