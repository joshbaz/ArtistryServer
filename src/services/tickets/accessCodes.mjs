import { ipKeyGenerator } from 'express-rate-limit';
import prisma from '../../utils/db.mjs';
import { AppError } from '../../utils/AppError.js';
import { sendCommand } from '../../utils/redis.mjs';
import { normalizeCode } from '../../api/v1/schemas/tickets.mjs';

/**
 * Access codes for restricted ticket types (docs/20 §13). Staff give a code
 * to a school or club; only someone with a code for that type can buy it,
 * up to the tickets the code covers. Enforced here, never in the browser:
 * the public reads only see `locked: true`.
 *
 * Uses are counted like seats: `used` is taken when the order holds its
 * seats and given back when the hold lapses or a ticket is voided, with the
 * same compare-and-set, so two buyers can't both spend a code's last use and
 * an abandoned checkout doesn't burn it. Codes are matched ignoring case,
 * spaces and dashes, and are unique within an event.
 *
 * Every refusal a buyer can see is the same message, so codes can't be
 * guessed from the answers, and refusals are counted per IP across the
 * unlock check and the order (guardTries), so guessing stops after a few.
 */

export { normalizeCode };

export const badCode = () => new AppError("That code isn't valid for this ticket, or it has been used up.", 422, { code: 'bad_code' });

/** Each event's codes, by "eventId|typeKey". */
export const codesOf = async (eventIds) => {
    const rows = await prisma.ticketAccessCode.findMany({ where: { eventId: { in: eventIds } }, orderBy: { createdAt: 'asc' } });
    const map = new Map();
    for (const c of rows) map.set(`${c.eventId}|${c.typeKey}`, [...(map.get(`${c.eventId}|${c.typeKey}`) ?? []), c]);
    return map;
};

/** As the Studio reads a code. */
export const studioCode = (c) => ({ id: c.key, code: c.code, label: c.label, maxUses: c.maxUses, used: c.used });

const conflict = (message) => new AppError(message, 409, { code: 'code_in_use', details: { fieldErrors: { types: [message] } } });

/**
 * Saves the codes of the types as sent. A type sent with `accessCodes` gets
 * exactly that list; one sent with `restricted: false` loses its unused
 * codes (used ones are kept, so sales still say who they were given to).
 * A code that has been used can't be removed, moved to another type or
 * rewritten, and its tickets can't drop below its uses.
 * @param {string} eventId
 * @param {{ key: string, name: string, restricted?: boolean, accessCodes?: { id?: string, code: string, label: string, maxUses: number }[] }[]} types - as saved, with their keys
 *
 * Checks everything first and writes nothing: → a function that saves them,
 * to run once the types are saved, so a refused code leaves the event as it was.
 * @returns {Promise<() => Promise<{ added: number, changed: number, removed: number }>>}
 */
export const planCodes = async (eventId, types) => {
    const current = await prisma.ticketAccessCode.findMany({ where: { eventId } });
    const byKey = new Map(current.map((c) => [c.key, c]));
    const byNorm = new Map(current.map((c) => [c.norm, c]));
    const keep = new Set();
    const writes = [];

    for (const t of types) {
        if (t.restricted === false && !t.accessCodes) {
            for (const c of current.filter((x) => x.typeKey === t.key && x.used > 0)) keep.add(c.id);
            continue;
        }
        if (!t.accessCodes) {
            for (const c of current.filter((x) => x.typeKey === t.key)) keep.add(c.id);
            continue;
        }
        const seen = new Set();
        for (const sent of t.accessCodes) {
            const norm = normalizeCode(sent.code);
            let key = sent.id && !seen.has(sent.id) ? sent.id : `ac_${Math.random().toString(36).slice(2, 8)}`;
            seen.add(key);
            // The same code as before: the same text (wherever it was), else the same id with new text.
            let old = byNorm.get(norm);
            if (!old && byKey.get(key) && !keep.has(byKey.get(key).id)) {
                old = byKey.get(key);
                if (old.used > 0) throw conflict(`The code ${old.code} has been used, so it can't be changed. Add a new code instead.`);
            }
            if (old) {
                keep.add(old.id);
                if (old.used > 0 && old.typeKey !== t.key) throw conflict(`The code ${old.code} has been used for another ticket option, so it can't move to ${t.name}.`);
                if (sent.maxUses < old.used) throw conflict(`The code ${old.code} has covered ${old.used} tickets already, so it can't cover fewer than that.`);
                writes.push({ old, data: { typeKey: t.key, key, code: sent.code, norm, label: sent.label, maxUses: sent.maxUses } });
            } else {
                writes.push({ data: { eventId, typeKey: t.key, key, code: sent.code, norm, label: sent.label, maxUses: sent.maxUses } });
            }
        }
    }
    // Codes left out, and those of types that went (a type with sales can't go, so neither can its used codes).
    const removed = current.filter((c) => !keep.has(c.id));
    const busy = removed.find((c) => c.used > 0);
    if (busy) throw conflict(`The code ${busy.code} (${busy.label || 'no name'}) has been used, so it can't be removed.`);

    return async () => {
        // Removals first, so a code moved or retyped can take its new text.
        if (removed.length) await prisma.ticketAccessCode.deleteMany({ where: { id: { in: removed.map((c) => c.id) }, used: 0 } });
        let added = 0;
        let changed = 0;
        for (const w of writes) {
            if (!w.old) {
                await prisma.ticketAccessCode.create({ data: w.data }).catch((error) => {
                    if (error.code === 'P2002') throw conflict(`The code ${w.data.code} is already on this ticket.`);
                    throw error;
                });
                added += 1;
                continue;
            }
            const same = ['typeKey', 'key', 'code', 'label', 'maxUses'].every((f) => w.old[f] === w.data[f]);
            if (same) continue;
            // Only while its uses still fit (a checkout may have taken one since it was read).
            const { count } = await prisma.ticketAccessCode.updateMany({ where: { id: w.old.id, used: { lte: w.data.maxUses } }, data: w.data });
            if (!count) throw conflict(`The code ${w.old.code} was just used. Check its tickets and save again.`);
            changed += 1;
        }
        return { added, changed, removed: removed.length };
    };
};

/**
 * The code for this type, or a refusal (unknown, another type's, or fewer
 * uses left than `qty`). Uses nothing up.
 */
export const codeFor = async (eventId, typeKey, code, qty = 1) => {
    const norm = normalizeCode(code);
    if (!norm) throw badCode();
    const row = await prisma.ticketAccessCode.findUnique({ where: { eventId_norm: { eventId, norm } } });
    if (!row || row.typeKey !== typeKey || row.maxUses - row.used < qty) throw badCode();
    return row;
};

/** Takes `qty` uses of the code, compare-and-set (retried when another buyer got in between). */
export const takeCode = async (eventId, typeKey, code, qty, db = prisma) => {
    const norm = normalizeCode(code);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await db.ticketAccessCode.findUnique({ where: { eventId_norm: { eventId, norm } } });
        if (!row || row.typeKey !== typeKey || row.maxUses - row.used < qty) throw badCode();
        const { count } = await db.ticketAccessCode.updateMany({ where: { id: row.id, used: row.used, maxUses: row.maxUses }, data: { used: { increment: qty } } });
        if (count) return;
    }
    throw badCode();
};

/** Gives uses back (a lapsed hold, a void ticket). */
export const releaseCode = async (eventId, code, qty, db = prisma) => {
    const norm = normalizeCode(code);
    if (!norm) return;
    await db.ticketAccessCode.updateMany({ where: { eventId, norm, used: { gte: qty } }, data: { used: { decrement: qty } } });
};

/* Guessing */

export const CODE_TRIES = { limit: 10, windowSeconds: 10 * 60 };
const triesKey = (ip) => `artistry360:code-tries:${ipKeyGenerator(ip || 'unknown')}`;
const tooMany = () => new AppError('Too many codes tried. Wait a few minutes and try again.', 429, { code: 'RATE_LIMITED' });

/**
 * Runs `work` (an unlock check or a ticket order) unless this IP has had
 * too many codes refused lately; a refused code counts one more and is
 * logged. While Redis is down nothing is counted (and nobody is locked out).
 * @param {string} ip
 * @param {() => Promise<any>} work
 * @param {string} what - for the log
 */
export const guardTries = async (ip, work, what) => {
    const key = triesKey(ip);
    const tries = Number(await sendCommand(['GET', key]).catch(() => 0)) || 0;
    if (tries >= CODE_TRIES.limit) throw tooMany();
    try {
        return await work();
    } catch (error) {
        if (error.code === 'bad_code') {
            console.warn(`Access code refused (${what}) from ${ip ?? 'unknown'}: ${tries + 1} in ${CODE_TRIES.windowSeconds / 60} minutes.`);
            await sendCommand(['INCR', key])
                .then((n) => (Number(n) === 1 ? sendCommand(['EXPIRE', key, String(CODE_TRIES.windowSeconds)]) : null))
                .catch(() => {});
        }
        throw error;
    }
};
