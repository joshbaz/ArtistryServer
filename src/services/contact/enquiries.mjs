import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';
import { notifyStaff } from '../studio/notifications.mjs';
import { isMailConfigured, mailboxAddress, sendMail } from '../emails/zohoMail.js';

/**
 * The public contact form. A guest sends a message (no sign-in; rate limited
 * per IP in utils/rateLimits.js); the Studio reads it in Overview › Recent
 * enquiries and replies from there. A reply is emailed from the team's
 * address with the enquiry quoted under it, a hidden copy goes to the team's
 * mailbox (so the conversation is there too, and their answer lands there),
 * and it is kept on the enquiry with who sent it. Replying marks it read.
 */

// The Studio keeps the newest few hundred in view; older ones stay stored.
const LIST_LIMIT = 200;

const toEnquiry = (e) => ({
    id: e.id,
    name: e.name,
    email: e.email,
    subject: e.subject,
    message: e.message,
    receivedAt: e.createdAt.toISOString(),
    read: e.read,
    replies: (e.replies ?? []).map((r) => ({ message: r.message, byName: r.byName, sentAt: r.sentAt.toISOString() })),
});

// The overview, the unread badge and the list all sit under ['admin', 'overview'].
const changed = (id) => invalidate('admin', ['admin', 'overview'], { id });

/* Public */

export const sendEnquiry = async ({ name, email, subject, message }) => {
    const row = await prisma.enquiry.create({ data: { name, email, subject: subject || 'General enquiry', message, read: false } });
    changed(row.id);
    notifyStaff('enquiry', { subject: `New enquiry: ${row.subject}`, heading: 'A new message from the contact form', lines: [`From ${row.name}, about "${row.subject}".`, 'Read it and reply in Studio › Overview › Recent enquiries.'], path: '/studio' });
    return { status: 'received', id: row.id };
};

/* Studio */

export const listEnquiries = async () =>
    (await prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: LIST_LIMIT })).map(toEnquiry);

export const setRead = async (id, read) => {
    const row = await prisma.enquiry.update({ where: { id }, data: { read } }).catch((error) => {
        if (error.code === 'P2025') throw new AppError('Enquiry not found.', 404);
        throw error;
    });
    changed(id);
    return toEnquiry(row);
};

export const unreadCount = () => prisma.enquiry.count({ where: { read: false } });

/* Replying */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paragraphs = (text) =>
    text
        .split(/\n{2,}/)
        .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
const received = (date) => date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kampala' });

const replyEmail = (enquiry, message, byName) => {
    const intro = `On ${received(enquiry.createdAt)}, ${enquiry.name} wrote:`;
    return {
        subject: /^re:/i.test(enquiry.subject) ? enquiry.subject : `Re: ${enquiry.subject}`,
        text: [message, '', byName, 'The Artistry360', '', intro, ...enquiry.message.split('\n').map((l) => `> ${l}`)].join('\n'),
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111;line-height:1.5">
${paragraphs(message)}
<p>${escape(byName)}<br>The Artistry360</p>
<p style="margin-top:24px;font-size:13px;color:#666">${escape(intro)}</p>
<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ddd;color:#555;font-size:13px">${paragraphs(enquiry.message)}</blockquote>
</div>`,
    };
};

/**
 * Email a reply to an enquiry and keep it. Unlike staff notices this waits
 * for the send, so the Studio knows whether it went.
 * @param {string} id
 * @param {string} message
 * @param {{ id: string, name: string }} by the staff member replying
 */
export const replyToEnquiry = async (id, message, by) => {
    const enquiry = await prisma.enquiry.findUnique({ where: { id } });
    if (!enquiry) throw new AppError('Enquiry not found.', 404);
    if (!isMailConfigured()) throw new AppError("Email isn't set up on the server yet, so replies can't be sent.", 503);
    try {
        await sendMail({ to: enquiry.email, bcc: mailboxAddress(), ...replyEmail(enquiry, message, by.name) });
    } catch (error) {
        console.error(`Reply to enquiry ${id} failed:`, error.message);
        throw new AppError("The reply couldn't be sent. Try again in a minute.", 502);
    }
    const row = await prisma.enquiry.update({
        where: { id },
        data: { read: true, replies: { push: { message, byId: by.id, byName: by.name, sentAt: new Date() } } },
    });
    changed(id);
    return toEnquiry(row);
};
