import prisma from '../../utils/db.mjs';
import { env } from '../../env.mjs';
import { roleAllows } from '../../utils/permissions.mjs';
import { isMailConfigured, sendMail } from '../emails/zohoMail.js';
import { invalidate } from '../../utils/sockets.js';

/**
 * Telling the Studio's staff when something arrives that needs a person, two ways:
 *
 * - The bell in the Studio header: everyone whose role can open the page
 *   behind the event, whatever their email choices, with or without Zoho.
 * - Email: each staff member picks theirs in Studio › Settings; until they
 *   do, they get their role's usual ones. Only roles that can open the page
 *   behind an email may choose it (payout requests are Finance's).
 *
 * An email says what arrived and links to the Studio; nobody's account or
 * payment details go in it. Sending never holds up or fails the request
 * that caused it: without Zoho set up nothing is sent, and a failed send is
 * logged and dropped.
 */

const ALL_ROLES = ['content-manager', 'finance', 'moderator'];

export const EVENTS = {
    enquiry: { label: 'A message arrives from the contact form', roles: ALL_ROLES, defaultFor: ['content-manager'] },
    booking: { label: 'Someone asks to book talent', roles: ALL_ROLES, defaultFor: ['content-manager'] },
    'organiser-request': { label: 'An organiser asks to run a campaign', roles: ALL_ROLES, defaultFor: [] },
    'payout-request': { label: 'An organiser requests a payout', roles: ['finance'], defaultFor: ['finance'] },
    'maintenance-due': { label: 'The system maintenance balance reaches its payout amount', roles: ['finance'], defaultFor: ['finance'] },
};

/** The emails a role may choose. A Super Admin may choose them all. */
export const eventsFor = (role) => Object.keys(EVENTS).filter((e) => roleAllows(role, EVENTS[e].roles));

/** What a staff member gets: their own choice once made, else their role's usual ones (all of them for a Super Admin). */
export const chosenEvents = (staff) => {
    const allowed = eventsFor(staff.role);
    if (staff.notifySet) return staff.notify.filter((e) => allowed.includes(e));
    return allowed.filter((e) => staff.role === 'super-admin' || EVENTS[e].defaultFor.includes(staff.role));
};

/** For Settings: every email this person may choose, and whether it's on. */
export const notificationSettings = (staff) => {
    const on = chosenEvents(staff);
    return { mailConfigured: isMailConfigured(), events: eventsFor(staff.role).map((key) => ({ key, label: EVENTS[key].label, on: on.includes(key) })) };
};

export const setNotifications = async (staffId, events) => {
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    const allowed = eventsFor(staff.role);
    const updated = await prisma.staff.update({ where: { id: staffId }, data: { notify: [...new Set(events)].filter((e) => allowed.includes(e)), notifySet: true } });
    return notificationSettings(updated);
};

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const message = ({ heading, lines, path }) => {
    const link = `${env.APP_URL}${path}`;
    const settings = `${env.APP_URL}/studio/settings`;
    return {
        text: [heading, '', ...lines, '', `Open the Studio: ${link}`, '', `Change which emails you get in Studio › Settings: ${settings}`].join('\n'),
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h1 style="font-size:20px">${escape(heading)}</h1>
${lines.map((l) => `<p>${escape(l)}</p>`).join('\n')}
<p><a href="${escape(link)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open the Studio</a></p>
<p style="font-size:12px;color:#666">You get this as a member of The Artistry360 Studio. <a href="${escape(settings)}">Change which emails you get</a>.</p>
</div>`,
    };
};

/* The bell */

const KEEP_DAYS = 90;
const SHOWN = 30;
const DAY = 24 * 3600 * 1000;
const bellChanged = () => invalidate('admin', ['admin', 'inbox']);

/** One row for each active staff member who may open the event's page. Never throws. */
const ring = async (staff, event, { heading, lines, path }) => {
    try {
        const to = staff.filter((s) => eventsFor(s.role).includes(event));
        if (!to.length) return;
        await prisma.staffNotification.createMany({ data: to.map((s) => ({ staffId: s.id, event, title: heading, body: lines[0] ?? '', path })) });
        bellChanged();
        // Old ones go as new ones come; nobody needs a bell from last quarter.
        prisma.staffNotification.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * DAY) } } }).catch(() => {});
    } catch (error) {
        console.error(`Studio notifications (${event}) not saved:`, error.message);
    }
};

/** The bell: the newest notifications for this staff member, and how many are unread. */
export const listInbox = async (staffId) => {
    const [items, unread] = await Promise.all([
        prisma.staffNotification.findMany({ where: { staffId }, orderBy: { createdAt: 'desc' }, take: SHOWN }),
        prisma.staffNotification.count({ where: { staffId, read: false } }),
    ]);
    return {
        items: items.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, path: n.path, read: n.read, createdAt: n.createdAt.toISOString() })),
        unread,
    };
};

/** Marks `ids` read (only this staff member's own), or all of them without ids. */
export const markInboxRead = async (staffId, ids) => {
    await prisma.staffNotification.updateMany({ where: { staffId, read: false, ...(ids ? { id: { in: ids } } : {}) }, data: { read: true } });
    bellChanged();
    return listInbox(staffId);
};

/**
 * Ring the bell for everyone who may see `event`, and email everyone who
 * chose it. Never throws; resolves to how many emails went out.
 * @param {keyof typeof EVENTS} event
 * @param {{ subject: string, heading: string, lines: string[], path: string }} email
 */
export const notifyStaff = async (event, { subject, ...email }) => {
    try {
        const staff = await prisma.staff.findMany({ where: { status: 'active' } });
        await ring(staff, event, email);
        if (!isMailConfigured()) return 0;
        const to = staff.filter((s) => chosenEvents(s).includes(event));
        const body = message(email);
        let sent = 0;
        for (const s of to) {
            await sendMail({ to: s.email, subject, ...body }).then(() => sent++, (error) => console.error(`Staff email (${event}) to ${s.id} failed:`, error.message));
        }
        return sent;
    } catch (error) {
        console.error(`Staff emails (${event}) failed:`, error.message);
        return 0;
    }
};
