import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';
import healthRoutes from './routes/healthRoutes.mjs';
import studioAuthRoutes from './routes/studioAuthRoutes.mjs';
import studioVotingRoutes from './routes/studioVotingRoutes.mjs';
import votingRoutes from './routes/votingRoutes.mjs';
import organiserRoutes from './routes/organiserRoutes.mjs';
import organizerAuthRoutes from './routes/organizerAuthRoutes.mjs';
import organizerPortalRoutes from './routes/organizerPortalRoutes.mjs';
import paymentRoutes from './routes/paymentRoutes.mjs';
import authRoutes from './routes/authRoutes.mjs';


const router = express.Router();
// More specific paths first: /auth/studio and /auth/organizer before /auth, /voting/studio before /voting (server/README.md, The areas).
const endpoints = [
    { path: '/health', router: healthRoutes },
    { path: '/auth/studio', router: studioAuthRoutes },
    { path: '/auth/organizer', router: organizerAuthRoutes },
    { path: '/auth', router: authRoutes },
    { path: '/voting/studio', router: studioVotingRoutes },
    { path: '/voting', router: votingRoutes },
    { path: '/organisers', router: organiserRoutes },
    { path: '/organizer', router: organizerPortalRoutes },
    { path: '/payments', router: paymentRoutes },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;
