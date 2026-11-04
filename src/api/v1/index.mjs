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
import contentRoutes from './routes/contentRoutes.mjs';
import galleryRoutes from './routes/galleryRoutes.mjs';
import bookingRoutes from './routes/bookingRoutes.mjs';
import monologueRoutes from './routes/monologueRoutes.mjs';
import talentRoutes from './routes/talentRoutes.mjs';
import academyRoutes from './routes/academyRoutes.mjs';
import studioOptionsRoutes from './routes/studioOptionsRoutes.mjs';
import streamingRoutes, { streamSiteRouter } from './routes/streamingRoutes.mjs';
import libraryRoutes from './routes/libraryRoutes.mjs';


const router = express.Router();
// More specific paths first: /auth/studio and /auth/organizer before /auth, /voting/studio before /voting,
// /talent/bookings and /talent/monologues before /talent (server/README.md, The areas).
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
    { path: '/content', router: contentRoutes },
    { path: '/gallery', router: galleryRoutes },
    { path: '/talent/bookings', router: bookingRoutes },
    { path: '/talent/monologues', router: monologueRoutes },
    { path: '/talent', router: talentRoutes },
    { path: '/academy', router: academyRoutes },
    { path: '/studio/options', router: studioOptionsRoutes },
    { path: '/streaming', router: streamingRoutes },
    { path: '/stream', router: streamSiteRouter },
    { path: '/library', router: libraryRoutes },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;
