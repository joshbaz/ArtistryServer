import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, optionalMember, requireAdmin } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/payments.mjs';
import * as controller from '../controllers/paymentsController.mjs';

/**
 * Payments. Buying votes is public (no sign-in: PesaPal knows the payer); a
 * VIP pass needs the voter signed in. Both are rate limited per IP in utils/rateLimits.js. Only PesaPal's word
 * completes an order: the IPN, or the status check when the payer returns.
 */
const router = express.Router();

router.post('/orders', optionalMember, validate(schema.createOrderBody), controller.createOrder);
router.get('/orders', requireAdmin, allow('finance'), validate(schema.listOrdersQuery, 'query'), controller.listOrders);
router.get('/orders/:reference', validate(schema.referenceParam, 'params'), controller.getOrder);
router.get('/pesapal/ipn', controller.ipn);
router.post('/pesapal/ipn', controller.ipn);

export default router;
