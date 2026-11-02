import * as orders from '../../../services/payments/orders.mjs';
import { AppError } from '../../../utils/AppError.js';
import { ipnFields } from '../schemas/payments.mjs';

/**
 * POST /payments/orders → { reference, redirectUrl }: the page sends the payer to PesaPal.
 * Votes need no sign-in; a VIP pass is for the signed-in voter (optionalMember).
 */
export const createOrder = async (req, res) => {
    const { kind, campaignId, participantId, votes } = req.body;
    if (kind === 'vip' && !req.member) throw new AppError('Sign in to become a VIP voter.', 401);
    const order = kind === 'vip'
        ? await orders.createVipOrder({ campaignId, participantId, memberId: req.member.id })
        : await orders.createVoteOrder({ campaignId, participantId, votes, memberId: req.member?.id });
    res.status(201).json({ data: order });
};

/** GET /payments/orders/:reference: the payer's own order, checked with PesaPal while pending. */
export const getOrder = async (req, res) => {
    res.json({ data: await orders.getForPayer(req.params.reference) });
};

/** GET /payments/orders?module=voting (Studio) */
export const listOrders = async (req, res) => {
    res.json({ data: await orders.listVotingOrders() });
};

/**
 * PesaPal's IPN (GET as registered, POST accepted too). It always gets the
 * JSON PesaPal expects, never our error envelope, so it knows whether to retry.
 */
export const ipn = async (req, res) => {
    const parsed = ipnFields.safeParse(req.method === 'GET' ? req.query : req.body);
    const reply = await orders.handleIpn(parsed.success ? parsed.data : {});
    res.status(reply.status === 200 ? 200 : 500).json(reply);
};
