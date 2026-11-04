import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';

/**
 * Plan reminders by email. A plan is paid a period at a time (PesaPal never
 * charges by itself), so a member hears three days before it ends, and once
 * when it has. Each goes once per period (a renewal moves the end, so the
 * next period gets its own). A member who turned reminders off (Account ›
 * Membership, "cancel" in the API) gets neither. Run by the scheduler.
 */

const DAY = 24 * 3600 * 1000;
const REMIND_DAYS_BEFORE = 3;
// An ended plan older than this gets no "it has ended" email (a server that was off for a while).
const ENDED_WITHIN_DAYS = 3;

const longDate = (d) => d.toLocaleDateString('en-UG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Kampala' });
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const renewLink = () => `${env.STREAM_URL}/plans?next=/account`;
const accountLink = () => `${env.STREAM_URL}/account`;

const email = ({ name, heading, lines, button }) => {
    const hello = name ? `Hi ${name},` : 'Hi,';
    const footer = `You get this because you have a plan on The Artistry360 Stream. To stop these reminders, turn them off in your account: ${accountLink()}`;
    return {
        text: [hello, '', ...lines, '', `${button}: ${renewLink()}`, '', footer].join('\n'),
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">${escape(heading)}</h1>
<p>${escape(hello)}</p>
${lines.map((l) => `<p>${escape(l)}</p>`).join('\n')}
<p><a href="${escape(renewLink())}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">${escape(button)}</a></p>
<p style="font-size:12px;color:#666">You get this because you have a plan on The Artistry360 Stream. <a href="${escape(accountLink())}">Turn these reminders off</a> in your account.</p>
</div>`,
    };
};

const planNames = async () => new Map((await prisma.streamPlan.findMany({ select: { id: true, name: true } })).map((p) => [p.id, p.name]));

/** Sends what's due. → how many emails went out. */
export const sendPlanReminders = async () => {
    if (!isMailConfigured()) return 0;
    const now = Date.now();
    const subs = await prisma.streamSubscription.findMany({
        where: { cancelAtPeriodEnd: false, currentPeriodEnd: { gt: new Date(now - ENDED_WITHIN_DAYS * DAY), lt: new Date(now + REMIND_DAYS_BEFORE * DAY) } },
    });
    if (!subs.length) return 0;
    const members = new Map((await prisma.member.findMany({ where: { id: { in: subs.map((s) => s.memberId) } }, select: { id: true, name: true, email: true, status: true } })).map((m) => [m.id, m]));
    const plans = await planNames();
    let sent = 0;

    for (const sub of subs) {
        const member = members.get(sub.memberId);
        if (!member?.email || member.status !== 'active') continue;
        const end = sub.currentPeriodEnd;
        const ended = end.getTime() <= now;
        const field = ended ? 'endedNoticeFor' : 'reminderSentFor';
        if (sub[field]?.getTime() === end.getTime()) continue;
        const plan = plans.get(sub.planId) ?? 'Your';
        const message = ended
            ? email({
                name: member.name,
                heading: 'Your plan has ended',
                lines: [`Your ${plan} plan on The Artistry360 Stream ended on ${longDate(end)}.`, 'Renew any time to pick up where you left off: your list and progress are still here.'],
                button: 'Renew my plan',
            })
            : email({
                name: member.name,
                heading: 'Your plan ends soon',
                lines: [`Your ${plan} plan on The Artistry360 Stream is paid until ${longDate(end)}.`, "Nothing is charged by itself. To keep watching, renew before then: it adds its time on top of what's left."],
                button: 'Renew now',
            });
        // Claimed first (only while still unsent for this end), so two servers can never both send it.
        const { count } = await prisma.streamSubscription.updateMany({ where: { id: sub.id, currentPeriodEnd: end, cancelAtPeriodEnd: false }, data: { [field]: end } });
        if (!count) continue;
        try {
            await sendMail({ to: member.email, subject: ended ? 'Your Artistry360 Stream plan has ended' : `Your Artistry360 Stream plan ends on ${longDate(end)}`, ...message });
            sent += 1;
        } catch (error) {
            // Not sent: give it back, so the next round tries again.
            await prisma.streamSubscription.update({ where: { id: sub.id }, data: { [field]: sub[field] ?? null } }).catch(() => {});
            console.error(`Plan reminder for ${sub.id} failed:`, error.message);
        }
    }
    return sent;
};
