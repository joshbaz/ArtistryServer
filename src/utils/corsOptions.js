/**
 * CORS for the two web origins. In production both sites reach the API through
 * their Netlify proxy (same origin), so this mostly matters in development and
 * for direct calls. The Flutter app sends no Origin and its tokens aren't
 * cookies, so CORS never applies to it.
 */
export const corsOptions = {
    origin: [
        'https://theartistry360.com',
        'https://www.theartistry360.com',
        'https://stream.theartistry360.com',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:8888',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Client (web | mobile) decides at sign-in whether the refresh token travels as a cookie or in the body.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
};
