import express from 'express';
import * as controller from '../controllers/healthController.mjs';

const router = express.Router();

router.get('/', controller.health);

export default router;
