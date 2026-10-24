import crypto from 'crypto';
import { redis } from '../utils/redis.mjs';

const MINUTE = 60 * 1000;

/**
 * Recurring background tasks. Each runs on its own interval behind a Redis
 * lock held a little under that interval, so with several processes only one
 * runs a task at a time and the rest skip that round.
 * Add tasks as `{ name, every, run, done }`; `done` turns run's result into a log line (or nothing).
 * One-off timed work (a title's release, a class reminder) goes on BullMQ as a delayed job instead.
 */
const TASKS = [];

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
