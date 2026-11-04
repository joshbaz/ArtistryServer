import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { invalidate, invalidateMember, invalidateSite } from '../../utils/sockets.js';
import { getPublicTitle } from './titles.mjs';

/**
 * Members talking about a title. Reading is public; posting, liking,
 * reporting and deleting need a member, who is always the signed-in one.
 * Bodies are plain text (the pages never render them as HTML). Three reports
 * from different members hide a comment until the Studio looks at it; the
 * Studio can hide, restore or delete any comment.
 */

export const COMMENT_MAX = 500;
const HIDE_AFTER_REPORTS = 3;
// Posting limit per member: this many in this long.
const BURST = { count: 5, ms: 60_000 };

const notFound = () => new AppError('That comment was removed.', 404);

const toComment = (c) => ({ id: c.id, author: { id: c.memberId, name: c.authorName }, body: c.body, spoiler: c.spoiler, likes: c.likes, createdAt: c.createdAt.toISOString() });

const changed = (titleId) => invalidateSite('comments', { id: titleId });

/** A title's visible comments, newest first. */
export const listComments = async (titleId) => {
    await getPublicTitle(titleId);
    return (await prisma.comment.findMany({ where: { titleId, hidden: false }, orderBy: { createdAt: 'desc' }, take: 300 })).map(toComment);
};

export const postComment = async (member, titleId, { body, spoiler }) => {
    await getPublicTitle(titleId);
    const recent = await prisma.comment.count({ where: { memberId: member.id, createdAt: { gt: new Date(Date.now() - BURST.ms) } } });
    if (recent >= BURST.count) throw new AppError("You're commenting fast. Wait a minute, then try again.", 429);
    const comment = await prisma.comment.create({ data: { titleId, memberId: member.id, authorName: member.name?.trim() || 'Member', body, spoiler } });
    changed(titleId);
    return toComment(comment);
};

const findComment = async (titleId, commentId) => {
    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.titleId !== titleId) throw notFound();
    return comment;
};

/** A member deletes their own. */
export const deleteOwnComment = async (memberId, titleId, commentId) => {
    const comment = await findComment(titleId, commentId);
    if (comment.memberId !== memberId) throw new AppError('You can only delete your own comments.', 403);
    await removeComment(comment);
};

const removeComment = async (comment) => {
    await prisma.$transaction([
        prisma.commentLike.deleteMany({ where: { commentId: comment.id } }),
        prisma.commentReport.deleteMany({ where: { commentId: comment.id } }),
        prisma.comment.delete({ where: { id: comment.id } }),
    ]);
    changed(comment.titleId);
};

/** Like or unlike: one like per member. → { liked, likes } */
export const toggleLike = async (memberId, titleId, commentId) => {
    const comment = await findComment(titleId, commentId);
    if (comment.hidden) throw notFound();
    const existing = await prisma.commentLike.findUnique({ where: { commentId_memberId: { commentId, memberId } } });
    let liked;
    if (existing) {
        const { count } = await prisma.commentLike.deleteMany({ where: { id: existing.id } });
        if (count) await prisma.comment.update({ where: { id: commentId }, data: { likes: { decrement: 1 } } });
        liked = false;
    } else {
        try {
            await prisma.commentLike.create({ data: { commentId, memberId } });
            await prisma.comment.update({ where: { id: commentId }, data: { likes: { increment: 1 } } });
        } catch (error) {
            if (error?.code !== 'P2002') throw error; // a double tap: already liked
        }
        liked = true;
    }
    const after = await prisma.comment.findUnique({ where: { id: commentId }, select: { likes: true } });
    changed(titleId);
    invalidateMember(memberId);
    return { liked, likes: Math.max(0, after?.likes ?? 0) };
};

/** The comments this member liked (ids), to show their hearts filled. */
export const likedBy = async (memberId) => (await prisma.commentLike.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' }, take: 5000, select: { commentId: true } })).map((l) => l.commentId);

/** A report: once per member; enough of them hide it for the Studio to review. */
export const reportComment = async (memberId, titleId, commentId) => {
    const comment = await findComment(titleId, commentId);
    if (comment.memberId === memberId) throw new AppError("That's your own comment: delete it instead.", 409);
    try {
        await prisma.commentReport.create({ data: { commentId, memberId } });
    } catch (error) {
        if (error?.code === 'P2002') return { reported: true };
        throw error;
    }
    const after = await prisma.comment.update({ where: { id: commentId }, data: { reports: { increment: 1 } } });
    if (!after.hidden && after.reports >= HIDE_AFTER_REPORTS) {
        await prisma.comment.update({ where: { id: commentId }, data: { hidden: true, hiddenBy: 'reports' } });
        changed(titleId);
    }
    invalidate('admin', ['admin', 'comments']);
    return { reported: true };
};

/* Studio (Content Manager) */

/** Reported or hidden comments first (`status`: reported | hidden | all), with the title's name. */
export const listForStudio = async ({ status = 'reported' } = {}) => {
    const where = status === 'reported' ? { reports: { gt: 0 } } : status === 'hidden' ? { hidden: true } : {};
    const rows = await prisma.comment.findMany({ where, orderBy: [{ reports: 'desc' }, { createdAt: 'desc' }], take: 500 });
    const titles = await prisma.streamTitle.findMany({ where: { id: { in: [...new Set(rows.map((c) => c.titleId))] } }, select: { id: true, title: true } });
    const names = new Map(titles.map((t) => [t.id, t.title]));
    return rows.map((c) => ({ ...toComment(c), titleId: c.titleId, titleName: names.get(c.titleId) ?? 'Deleted title', reports: c.reports, hidden: c.hidden, hiddenBy: c.hiddenBy ?? null }));
};

/** Hide or restore. Restoring clears the reports, so it isn't hidden again by the same ones. */
export const setHidden = async (commentId, hidden) => {
    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw notFound();
    if (!hidden) await prisma.commentReport.deleteMany({ where: { commentId } });
    const row = await prisma.comment.update({ where: { id: commentId }, data: hidden ? { hidden: true, hiddenBy: 'studio' } : { hidden: false, hiddenBy: null, reports: 0 } });
    changed(comment.titleId);
    return { ...toComment(row), titleId: row.titleId, reports: row.reports, hidden: row.hidden, hiddenBy: row.hiddenBy ?? null };
};

export const deleteForStudio = async (commentId) => {
    const comment = await prisma.comment.findUnique({ where: { id: commentId } });
    if (comment) await removeComment(comment);
};
