import { z } from 'zod';
import { objectId } from './common.mjs';
import { MAX_VOTES } from '../../../services/payments/orders.mjs';

const voteCount = `Choose between 1 and ${MAX_VOTES.toLocaleString('en')} votes.`;

/**
 * POST payments/orders. Bought votes (anyone) or a VIP pass (the signed-in
 * voter it's for). The price is always the server's.
 */
export const createOrderBody = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('votes'),
        campaignId: objectId,
        participantId: objectId,
        votes: z.coerce.number({ error: voteCount }).int(voteCount).min(1, voteCount).max(MAX_VOTES, voteCount),
    }),
    z.object({ kind: z.literal('vip'), campaignId: objectId, participantId: objectId }),
], { error: 'Choose what to pay for: votes or VIP.' });

export const referenceParam = z.object({ reference: z.string().regex(/^A360-[A-Z0-9]+-[A-F0-9]{6}$/) });

/** GET payments/orders (Studio) */
export const listOrdersQuery = z.object({ module: z.literal('voting', { error: 'Name the module: voting.' }) });

/** PesaPal's IPN, as query (GET) or body (POST). Unknown fields are dropped. */
export const ipnFields = z.object({
    OrderTrackingId: z.string().max(100).optional(),
    OrderMerchantReference: z.string().max(100).optional(),
    OrderNotificationType: z.string().max(40).optional(),
});
