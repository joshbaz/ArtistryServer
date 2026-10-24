import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { knownOrigin, requireOrganizer } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/organizerPortal.mjs';
import * as controller from '../controllers/organizerAuthController.mjs';

// Sign-in and accepting an invite are rate limited in utils/rateLimits.js (ORGANIZER_AUTH_PATH).
const router = express.Router();
const invite = validate(schema.inviteParam, 'params');

router.post('/login', knownOrigin, validate(schema.loginBody), controller.login);
router.post('/refresh', knownOrigin, controller.refresh);
router.post('/logout', knownOrigin, controller.logout);
router.get('/me', requireOrganizer, controller.me);
router.get('/invite/:token', invite, controller.readInvite);
router.post('/invite/:token', knownOrigin, invite, validate(schema.acceptInviteBody), controller.acceptInvite);

export default router;
