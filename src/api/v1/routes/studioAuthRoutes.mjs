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

export default router;
