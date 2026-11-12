import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';
import { ticketsPdf } from './pdf.mjs';
import { whenOf } from './when.mjs';

/**
 * The buyer's tickets by email: the event, the order reference, what was
 * paid and every code, with the tickets as a PDF attached (pdf.mjs). Sending
 * never holds up or fails the order (the page shows the codes too); a failed
 * send is tried once more, then logged. If the PDF can't be made the email
 * still goes, with the codes in its body. Everything the buyer or the Studio
 * typed is escaped.
 */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (ugx) => `UGX ${ugx.toLocaleString('en')}`;

const message = ({ event, tickets, buyerName, reference, totalUGX, complimentary }) => {
    const page = `${env.APP_URL}/tickets/${encodeURIComponent(event.id)}`;
    const details = [whenOf(event.startsAt, event.endsAt), event.venue].filter(Boolean).join(' · ');
    const paid = complimentary ? 'Complimentary' : totalUGX ? `Paid ${money(totalUGX)}` : 'Free';
    const lines = tickets.map((t) => `${t.code}  ${t.typeName}`);
    const text = [
        `Hello ${buyerName},`, '',
        `Your tickets for ${event.title}${details ? ` (${details})` : ''}.`,
        `Order ${reference} · ${paid}`, '',
        ...lines, '',
        'Your tickets are attached as a PDF. Show a code at the door: one code lets one person in, once. Keep them private.',
        `Your tickets and QR codes: ${page}`,
    ].join('\n');
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">Your tickets for ${escape(event.title)}</h1>
${details ? `<p>${escape(details)}</p>` : ''}
<p>Hello ${escape(buyerName)}. Order <strong>${escape(reference)}</strong> · ${escape(paid)}</p>
<table style="border-collapse:collapse;width:100%">${tickets.map((t) => `<tr><td style="padding:10px;border:1px solid #ddd;font-family:monospace;font-size:20px;letter-spacing:2px">${escape(t.code)}</td><td style="padding:10px;border:1px solid #ddd">${escape(t.typeName)}</td></tr>`).join('')}</table>
<p>Your tickets are attached as a PDF. Show a code at the door: one code lets one person in, once. Keep them private.</p>
<p><a href="${escape(page)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">See your tickets</a></p>
</div>`;
    return { subject: `Your tickets: ${event.title}`, text, html };
};

const fileName = (event) => `tickets-${event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'}.pdf`;

/** The email with its PDF, ready for sendMail. */
const build = async ({ to, ...ticket }) => {
    const mail = { to, ...message(ticket) };
    try {
        const types = await prisma.ticketType.findMany({ where: { eventId: ticket.event.id }, select: { key: true, perk: true } });
        const pdf = await ticketsPdf({ ...ticket, perks: new Map(types.map((t) => [t.key, t.perk])) });
        mail.attachments = [{ filename: fileName(ticket.event), content: pdf, contentType: 'application/pdf' }];
    } catch (error) {
        console.error(`Tickets PDF for ${ticket.reference} failed; sending the codes without it:`, error.message);
    }
    return mail;
};

/** Sends now and says how it went (the Studio's Resend). Throws if mail isn't set up or the send fails. */
export const emailTicketsNow = async (sale) => sendMail(await build(sale));

/** Never throws; not awaited by the order. */
export const sendTicketsEmail = (sale) => {
    if (!isMailConfigured() || !sale.to) return;
    build(sale)
        .then((mail) => sendMail(mail).catch(() => new Promise((resolve) => setTimeout(resolve, 30_000)).then(() => sendMail(mail))))
        .catch((error) => console.error(`Tickets email for ${sale.reference} failed:`, error.message));
};
