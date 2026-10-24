import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/organisers.mjs';
import * as controller from '../controllers/studioOrganizersController.mjs';

/**
 * Studio › Voting › Organisers and Payouts. Organiser accounts, invites,
 * access and the revenue share are a Super Admin's (10-voting.md, Roles);
 * Finance sees payout requests and marks them paid.
 */
const router = express.Router();
const id = validate(idParam, 'params');
const superAdmin = allow();
const finance = allow('finance');

router.get('/organizers', requireAdmin, superAdmin, controller.listOrganizers);
router.post('/organizers/approve', requireAdmin, superAdmin, validate(schema.approveBody), controller.approve);
router.post('/organizers/:id/invite', id, requireAdmin, superAdmin, controller.resendInvite);
router.post('/organizers/:id/access', id, requireAdmin, superAdmin, validate(schema.accessBody), controller.setAccess);
router.post('/organizers/:id/share', id, requireAdmin, superAdmin, validate(schema.shareBody), controller.setShare);

router.get('/payouts', requireAdmin, finance, controller.listPayouts);
router.post('/payouts/:id/paid', id, requireAdmin, finance, validate(schema.markPaidBody), controller.markPaid);

export default router;
