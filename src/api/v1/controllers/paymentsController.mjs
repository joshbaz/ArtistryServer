import * as orders from '../../../services/payments/orders.mjs';
import { AppError } from '../../../utils/AppError.js';
import { ipnFields } from '../schemas/payments.mjs';
import * as access from '../../../services/streaming/access.mjs';
import * as charges from '../../../services/payments/charges.mjs';
import * as maintenance from '../../../services/payments/maintenance.mjs';

/**
 * POST /payments/orders → { reference, redirectUrl }: the page sends the payer to PesaPal.
 * Votes need no sign-in; a VIP pass, a plan or a rental is for the signed-in member (optionalMember).
 */
export const createOrder = async (req, res) => {
    const { kind, campaignId, participantId, votes, planId, titleId, expectedPriceUGX } = req.body;
    if (kind === 'vip' && !req.member) throw new AppError('Sign in to become a VIP voter.', 401);
    if ((kind === 'subscription' || kind === 'ppv') && !req.member) throw new AppError('Sign in first, so what you buy is saved to your account.', 401);
    if (kind === 'subscription' || kind === 'ppv') {
        res.status(201).json({ data: await orders.createStreamOrder({ kind, planId, titleId, expectedPriceUGX, memberId: req.member.id }) });
        return;
    }
    if (kind === 'ticket') {
        const { eventId, items, buyer, answers } = req.body;
        res.status(201).json({ data: await orders.createTicketOrder({ eventId, items, buyer, answers }) });
        return;
    }
    const order = kind === 'vip'
        ? await orders.createVipOrder({ campaignId, participantId, memberId: req.member.id })
        : await orders.createVoteOrder({ campaignId, participantId, votes, memberId: req.member?.id });
    res.status(201).json({ data: order });
};

/** GET /payments/orders/:reference: the payer's own order, checked with PesaPal while pending. */
export const getOrder = async (req, res) => {
    res.json({ data: await orders.getForPayer(req.params.reference) });
};

/** GET /payments/orders?module=voting|streaming (Studio, Finance). The two are never mixed. */
export const listOrders = async (req, res) => {
    res.json({ data: req.query.module === 'streaming' ? await orders.listStreamingOrders() : await orders.listVotingOrders() });
};

/** GET /payments/history: the signed-in member's streaming receipts. */
export const history = async (req, res) => res.json({ data: await orders.listMemberPayments(req.member.id) });

/** POST /payments/subscription/cancel | resume: whether the plan is meant to renew. → the member's access */
export const cancelPlan = async (req, res) => res.json({ data: await access.setCancelAtPeriodEnd(req.member.id, true) });
export const resumePlan = async (req, res) => res.json({ data: await access.setCancelAtPeriodEnd(req.member.id, false) });

/**
 * PesaPal's IPN (GET as registered, POST accepted too). It always gets the
 * JSON PesaPal expects, never our error envelope, so it knows whether to retry.
 */
export const ipn = async (req, res) => {
    const parsed = ipnFields.safeParse(req.method === 'GET' ? req.query : req.body);
    const reply = await orders.handleIpn(parsed.success ? parsed.data : {});
    res.status(reply.status === 200 ? 200 : 500).json(reply);
};

/** POST /payments/orders/:reference/check (Studio, Finance): ask PesaPal now and apply its answer. */
export const checkOrder = async (req, res) => res.json({ data: await orders.checkForStudio(req.params.reference) });

/* Charges and system maintenance */

export const getCharges = async (req, res) => res.json({ data: await charges.publicRates() });
export const getMaintenance = async (req, res) => res.json({ data: await maintenance.getSummary() });
export const listMaintenanceEarnings = async (req, res) => res.json({ data: await maintenance.listEarnings() });
export const recordMaintenancePayout = async (req, res) => res.status(201).json({ data: await maintenance.recordPayout(req.body, req.admin) });
export const setChargeRates = async (req, res) => res.json({ data: await charges.setRates(req.body) });
