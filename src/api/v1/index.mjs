import express from 'express';
import requestLogger from '../../middleware/requestLogger.mjs';
import healthRoutes from './routes/healthRoutes.mjs';
import studioAuthRoutes from './routes/studioAuthRoutes.mjs';


const router = express.Router();
// More specific paths first: /auth/studio before /auth (server/README.md, The areas).
const endpoints = [
    { path: '/health', router: healthRoutes },
    { path: '/auth/studio', router: studioAuthRoutes },
];

endpoints.forEach((endpoint) => router.use(endpoint.path, requestLogger, endpoint.router));



export default router;
