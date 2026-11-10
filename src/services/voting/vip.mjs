import crypto from 'crypto';
import prisma from '../../utils/db.mjs';

const DAY = 24 * 60 * 60 * 1000;

/**
 * VIP voter passes. A signed-in voter buys one per campaign through PesaPal
 * (services/payments/orders.mjs); when the order completes, the pass gives
 * `dailyVotes` to the voter's contestant then and every 24 hours after,
 * automatically, until voting closes (vipCredits.mjs), and its ticket code
 * is their free event ticket. Only orders.mjs grants or revokes a pass,
 * inside the transaction that settles the order.
 */

// No 0/O or 1/I, so a code read out at the door can't be misheard.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newTicketCode = () => `VIP-${Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;

/** The voter's active pass for a campaign, or null. */
export const activePass = (campaignId, memberId) =>
    prisma.vipPass.findFirst({ where: { campaignId, memberId, status: 'active' } });

/**
 * Give the voter their pass for a completed VIP order. The order's own votes
 * (added by orders.mjs) are its day 1; the next are due in 24 hours. A voter
 * who pays again while their pass is active keeps it as it is; a revoked pass
 * comes back with a new ticket code, its day count carrying on.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ id: string, campaignId: string, memberId: string, participantId?: string | null, votes: number }} order
 * @param {number} dailyVotes - the campaign's, when the order was made
 */
export const grantPass = async (tx, order, dailyVotes, now = new Date()) => {
    const where = { campaignId_memberId: { campaignId: order.campaignId, memberId: order.memberId } };
    const current = await tx.vipPass.findUnique({ where });
    if (current?.status === 'active') {
        return tx.vipPass.update({ where, data: { orderId: order.id, votesCredited: (current.votesCredited ?? 0) + (order.votes ?? 0) } });
    }
    const running = {
        contestantId: order.participantId ?? null,
        nextCreditAt: new Date(now.getTime() + DAY),
        creditState: 'running',
        daysCredited: (current?.daysCredited ?? 0) + 1,
        votesCredited: (current?.votesCredited ?? 0) + (order.votes ?? 0),
    };
    return tx.vipPass.upsert({
        where,
        create: { campaignId: order.campaignId, memberId: order.memberId, orderId: order.id, dailyVotes, ticketCode: newTicketCode(), ...running },
        update: { orderId: order.id, dailyVotes, status: 'active', ticketCode: newTicketCode(), ...running },
    });
};

/**
 * A VIP payment was reversed: the pass it paid for stops working. Votes
 * already cast with it stay; only the order's own instant votes are taken back.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export const revokePassFor = (tx, orderId) =>
    tx.vipPass.updateMany({ where: { orderId, status: 'active' }, data: { status: 'revoked', nextCreditAt: null } });
