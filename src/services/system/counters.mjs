import prisma from '../../utils/db.mjs';

/**
 * Running numbers that are never reused, even after a delete: talent
 * references (T-NNN) and booking references (BK-NNNN). One atomic increment
 * per number, so two saves at once never get the same one.
 */

/**
 * The next number in `name`, never at or below `floor` (the highest already
 * issued, for records that came in before the counter did).
 * @param {string} name
 * @param {number} floor
 */
export const nextNumber = async (name, floor) => {
    const row = await prisma.counter.upsert({ where: { id: name }, create: { id: name, value: floor + 1 }, update: { value: { increment: 1 } } });
    if (row.value > floor) return row.value;
    // Behind the records (seeded or imported): catch up, then take the next one.
    await prisma.counter.updateMany({ where: { id: name, value: { lte: floor } }, data: { value: floor } });
    return (await prisma.counter.update({ where: { id: name }, data: { value: { increment: 1 } } })).value;
};

/**
 * Save something with a fresh number. The record's unique index is the last
 * word: if a number was somehow taken (P2002), the next one is tried.
 * @template T
 * @param {(number: number) => Promise<T>} write
 * @param {string} name
 * @param {() => Promise<number>} highest
 * @returns {Promise<T>}
 */
export const withNextNumber = async (name, highest, write) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await write(await nextNumber(name, await highest()));
        } catch (error) {
            if (error.code !== 'P2002' || attempt === 2) throw error;
        }
    }
};
