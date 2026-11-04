import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate } from '../../utils/sockets.js';

/**
 * The public contact form. A guest sends a message (no sign-in; rate limited
 * per IP in utils/rateLimits.js); the Studio reads it in Overview › Recent
 * enquiries and replies by email, which marks it read.
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
});

// The overview, the unread badge and the list all sit under ['admin', 'overview'].
const changed = (id) => invalidate('admin', ['admin', 'overview'], { id });

/* Public */

export const sendEnquiry = async ({ name, email, subject, message }) => {
    const row = await prisma.enquiry.create({ data: { name, email, subject: subject || 'General enquiry', message, read: false } });
    changed(row.id);
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
