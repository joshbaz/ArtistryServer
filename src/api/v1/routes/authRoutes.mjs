import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { knownOrigin, requireMember } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/auth.mjs';
import * as controller from '../controllers/authController.mjs';

// Member sign-in (voters now; the stream site and the app later). Google and Apple are rate limited
// in utils/rateLimits.js (AUTH_PATH). Email, OTP and password routes join here with the stream site.
const router = express.Router();

router.post('/google', knownOrigin, validate(schema.idTokenBody), controller.google);
router.post('/apple', knownOrigin, validate(schema.idTokenBody), controller.apple);
router.post('/refresh', knownOrigin, validate(schema.refreshBody), controller.refresh);
router.post('/logout', knownOrigin, validate(schema.refreshBody), controller.logout);
router.get('/me', requireMember, controller.me);

export default router;
