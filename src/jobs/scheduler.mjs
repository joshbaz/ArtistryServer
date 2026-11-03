import crypto from 'crypto';
import { redis } from '../utils/redis.mjs';
import { expireStaleOrders } from '../services/payments/orders.mjs';
import { closeStaleUploads } from '../services/streaming/uploads.mjs';

const MINUTE = 60 * 1000;

/**
 * Recurring background tasks. Each runs on its own interval behind a Redis
 * lock held a little under that interval, so with several processes only one
 * runs a task at a time and the rest skip that round.
 * Add tasks as `{ name, every, run, done }`; `done` turns run's result into a log line (or nothing).
 * One-off timed work (a title's release, a class reminder) goes on BullMQ as a delayed job instead.
 */
const TASKS = [
    // Checkouts nobody finished get a last check with PesaPal, and are closed after a day.
    { name: 'expire-unpaid-orders', every: 15 * MINUTE, run: expireStaleOrders, done: (n) => n && `Closed ${n} unpaid checkout${n === 1 ? '' : 's'}` },
    // Studio uploads left open a day (the tab closed mid-way) are closed, and their parts deleted from Spaces.
    { name: 'close-stale-uploads', every: 60 * MINUTE, run: closeStaleUploads, done: (n) => n && `Closed ${n} unfinished video upload${n === 1 ? '' : 's'}` },
];

const timers = [];

const runTask = async (task) => {
    try {
        const got = await redis.set(`artistry360:lock:${task.name}`, crypto.randomUUID(), { NX: true, PX: task.every - 5_000 });
        if (got !== 'OK') return;
        const message = task.done(await task.run());
        if (message) console.info(message);
    } catch (error) {
        console.error(`Task ${task.name} failed:`, error.message);
    }
};

const schedule = (task) => {
    runTask(task);
    const timer = setInterval(() => runTask(task), task.every);
    timer.unref?.();
    timers.push(timer);
};

export const startScheduler = () => {
    if (timers.length) return;
    TASKS.forEach(schedule);
};

export { MINUTE };
