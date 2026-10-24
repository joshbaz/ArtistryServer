import { getHealth } from '../../../services/system/health.mjs';

/** GET /health: 200 when everything answers, 503 when something is down. */
export const health = async (req, res) => {
    const data = await getHealth();
    res.status(data.status === 'ok' ? 200 : 503).json({ data });
};
