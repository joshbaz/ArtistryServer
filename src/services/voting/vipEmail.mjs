import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { AppError } from '../../utils/AppError.js';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';
import { recordChange } from '../system/audit.mjs';

/**
 * The VIP voter's pass by email: sent when their VIP payment completes, and
 * again from the Studio (with a note from the team, if one is written). It
 * says who their daily votes go to, how many and about when, their VIP ticket
 * code for the event, and which account to sign in with to see the pass.
 * Sending never holds up or fails the payment. Everything typed is escaped.
 */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const timeOfDay = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' });
const PROVIDER = { google: 'Google', apple: 'Apple' };

/** What the email needs about a pass, or null if it can't be sent (no pass, or no email to send to). */
const load = async (where) => {
    const pass = await prisma.vipPass.findFirst({ where });
    if (!pass) return null;
    const [campaign, contestant, member, order] = await Promise.all([
        prisma.campaign.findUnique({ where: { id: pass.campaignId }, select: { id: true, title: true, vipTicketPerk: true } }),
        pass.contestantId ? prisma.contestant.findUnique({ where: { id: pass.contestantId }, select: { fullName: true } }) : null,
        prisma.member.findUnique({ where: { id: pass.memberId }, select: { name: true, email: true, lastSignInWith: true } }),
        prisma.paymentOrder.findUnique({ where: { id: pass.orderId }, select: { reference: true } }),
    ]);
    return { pass, campaign, contestant, member, order };
};

const message = ({ pass, campaign, contestant, member, order }, note) => {
    const page = `${env.APP_URL}/voting/${encodeURIComponent(campaign.id)}`;
    const who = contestant?.fullName ?? 'the contestant you choose';
    const at = pass.nextCreditAt ? ` at about ${timeOfDay(pass.nextCreditAt)} (Kampala time)` : '';
    const account = `${PROVIDER[member.lastSignInWith] ?? 'Google or Apple'} account ${member.email}`;
    const perk = campaign.vipTicketPerk || 'Free event ticket';
    const hello = member.name ? `Hello ${member.name},` : 'Hello,';
    const daily = pass.status === 'active' && pass.creditState !== 'ended'
        ? `${pass.dailyVotes} votes go to ${who} automatically every day${at}, until voting closes. You don't need to come back and vote.`
        : `Your daily votes have finished: voting in ${campaign.title} has closed.`;

    const text = [
        hello, '',
        ...(note ? [note, ''] : []),
        `You're a VIP voter in ${campaign.title}.`, '',
        daily,
        'You can send them to another contestant at any time from the campaign page.', '',
        `Your VIP ticket code: ${pass.ticketCode}`,
        `${perk}. Show this code at the event. Keep it private.`, '',
        `To see your VIP pass, sign in on the campaign page with the same ${account}.`,
        `Campaign: ${page}`,
        ...(order?.reference ? ['', `Payment reference: ${order.reference}`] : []),
    ].join('\n');

    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">You're a VIP voter in ${escape(campaign.title)}</h1>
<p>${escape(hello)}</p>
${note ? `<p style="padding:12px 14px;background:#fff4e6;border-radius:8px;white-space:pre-line">${escape(note)}</p>` : ''}
<p><strong>${escape(daily)}</strong> You can send them to another contestant at any time from the campaign page.</p>
<p style="margin:20px 0 6px">Your VIP ticket code</p>
<p style="margin:0;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:22px;letter-spacing:2px;text-align:center">${escape(pass.ticketCode)}</p>
<p style="font-size:14px;color:#444">${escape(perk)}. Show this code at the event. Keep it private.</p>
<p>To see your VIP pass, sign in on the campaign page with the same <strong>${escape(account)}</strong>.</p>
<p><a href="${escape(page)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open the campaign</a></p>
${order?.reference ? `<p style="font-size:12px;color:#666">Payment reference: ${escape(order.reference)}</p>` : ''}
</div>`;
    return { to: member.email, subject: `You're a VIP voter: ${campaign.title}`, text, html };
};

/**
 * When a VIP payment completes. Never throws; not awaited by the payment.
 * @param {{ campaignId: string, memberId: string }} voter
 */
export const sendVipEmail = ({ campaignId, memberId }) => {
    if (!isMailConfigured()) return;
    load({ campaignId, memberId, status: 'active' })
        .then((data) => {
            if (!data?.member?.email || !data.campaign) return;
            const mail = message(data);
            return sendMail(mail).catch(() => new Promise((resolve) => setTimeout(resolve, 30_000)).then(() => sendMail(mail)));
        })
        .catch((error) => console.error(`VIP email for campaign ${campaignId} failed:`, error.message));
};

/**
 * Studio: send a voter their VIP pass again, with a note from the team if
 * one is written. → who it went to.
 * @param {string} passId
 * @param {{ note?: string }} body
 * @param {object} by - the Studio member sending it
 */
export const emailVipNow = async (passId, { note } = {}, by) => {
    const data = await load({ id: passId });
    if (!data) throw new AppError('We could not find that VIP pass.', 404);
    if (data.pass.status !== 'active') throw new AppError("This VIP pass was revoked (its payment was reversed), so there's nothing to send.", 409, { code: 'revoked' });
    if (!data.member?.email) throw new AppError('This voter has no email address to send it to.', 409, { code: 'no_email' });
    if (!isMailConfigured()) throw new AppError("Email isn't set up on the server yet, so nothing can be sent.", 409, { code: 'mail_off' });
    const clean = note?.trim() || '';
    try {
        await sendMail(message(data, clean));
    } catch (error) {
        console.error(`Emailing VIP pass ${passId} failed:`, error.message);
        throw new AppError("The email didn't go. Try again in a moment.", 502, { code: 'send_failed' });
    }
    recordChange(by, 'vip-email', passId, null, { to: data.member.email, campaignId: data.pass.campaignId, withNote: Boolean(clean) });
    return { to: data.member.email };
};
