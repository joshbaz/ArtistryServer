import { z } from 'zod';
import { objectId } from './common.mjs';
import { MAX_VOTES } from '../../../services/payments/orders.mjs';

/** POST payments/orders. Only bought votes for now; VIP comes with voter sign-in. The price is the server's. */
export const createOrderBody = z.object({
    kind: z.literal('votes', { error: 'Only vote purchases are open for now.' }),
    campaignId: objectId,
    participantId: objectId,
    votes: z.coerce.number({ error: `Choose between 1 and ${MAX_VOTES.toLocaleString('en')} votes.` }).int(`Choose between 1 and ${MAX_VOTES.toLocaleString('en')} votes.`).min(1, `Choose between 1 and ${MAX_VOTES.toLocaleString('en')} votes.`).max(MAX_VOTES, `Choose between 1 and ${MAX_VOTES.toLocaleString('en')} votes.`),
});

export const referenceParam = z.object({ reference: z.string().regex(/^A360-[A-Z0-9]+-[A-F0-9]{6}$/) });

/** GET payments/orders (Studio) */
export const listOrdersQuery = z.object({ module: z.literal('voting', { error: 'Name the module: voting.' }) });

/** PesaPal's IPN, as query (GET) or body (POST). Unknown fields are dropped. */
export const ipnFields = z.object({
    OrderTrackingId: z.string().max(100).optional(),
    OrderMerchantReference: z.string().max(100).optional(),
    OrderNotificationType: z.string().max(40).optional(),
});
