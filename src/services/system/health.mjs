import prisma from '../../utils/db.mjs';
import { redis } from '../../utils/redis.mjs';

const TIMEOUT_MS = 2000;

const within = (promise) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
        }),
    ]).finally(() => clearTimeout(timer));
};

const check = async (name, ping) => {
    try {
        await within(ping());
        return [name, 'up'];
    } catch {
        return [name, 'down'];
    }
};

/**
 * Whether the database and Redis answer, for load balancers and uptime checks.
 * @returns {Promise<{ status: 'ok' | 'degraded', checks: Record<string, 'up' | 'down'>, uptime: number }>}
 */
export const getHealth = async () => {
    const checks = Object.fromEntries(await Promise.all([
        check('database', () => prisma.$runCommandRaw({ ping: 1 })),
        check('redis', () => redis.ping()),
    ]));
    const status = Object.values(checks).every((c) => c === 'up') ? 'ok' : 'degraded';
    return { status, checks, uptime: Math.round(process.uptime()) };
};
