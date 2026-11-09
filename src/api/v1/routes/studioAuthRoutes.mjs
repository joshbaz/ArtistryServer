import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { knownOrigin, requireAdmin } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/studioAuth.mjs';
import * as controller from '../controllers/studioAuthController.mjs';

// Sign-in is rate limited in utils/rateLimits.js (STUDIO_LOGIN_PATH).
const router = express.Router();

router.post('/login', knownOrigin, validate(schema.loginBody), controller.login);
router.post('/refresh', knownOrigin, controller.refresh);
router.post('/logout', knownOrigin, controller.logout);
router.get('/me', requireAdmin, controller.me);

// My account (Studio › Settings). Changing the password is rate limited like a sign-in.
router.patch('/me', requireAdmin, validate(schema.profileBody), controller.updateMe);
router.post('/password', requireAdmin, validate(schema.passwordBody), controller.changePassword);
router.get('/sessions', requireAdmin, controller.listSessions);
router.post('/sessions/revoke-others', requireAdmin, controller.endOtherSessions);
router.delete('/sessions/:sessionId', validate(schema.sessionParam, 'params'), requireAdmin, controller.endSession);
router.get('/notifications', requireAdmin, controller.getNotifications);
router.put('/notifications', requireAdmin, validate(schema.notificationsBody), controller.setNotifications);
// The header's bell (notifications above are the email choices).
router.get('/inbox', requireAdmin, controller.getInbox);
router.post('/inbox/read', requireAdmin, validate(schema.inboxReadBody), controller.readInbox);

// A set-password link from Team: public, single use, rate limited like a sign-in.
router.get('/invite/:token', validate(schema.linkParam, 'params'), controller.readLink);
router.post('/invite/:token', knownOrigin, validate(schema.linkParam, 'params'), validate(schema.acceptLinkBody), controller.acceptLink);

export default router;
