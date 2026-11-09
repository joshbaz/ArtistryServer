/**
 * Campaign time, the same rules as the client's utils/voting.js: a campaign
 * runs from its start date and time to its end date and time, Kampala time
 * (UTC+3, no daylight saving), and an early close from the Studio ends it at
 * that moment. Without a time it opens at 00:00 on its start date and closes
 * at 23:59:59 on its end date, as campaigns always did.
 */

const KAMPALA = '+03:00';

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
/** "18:30": a 24-hour time, Kampala. */
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export const campaignStartsAt = (date, time) => new Date(`${date}T${isTime(time) ? time : '00:00'}:00${KAMPALA}`);
/** The moment voting closes: at `time` on `date`, or 23:59:59 without one. */
export const campaignEndsAt = (date, time) => new Date(`${date}T${isTime(time) ? `${time}:00` : '23:59:59'}${KAMPALA}`);

/**
 * "upcoming", "ongoing" or "finished".
 * @param {{ startDate: string, endDate: string, startTime?: string | null, endTime?: string | null, closedAt?: Date | null }} campaign
 */
export const campaignPhase = ({ startDate, endDate, startTime, endTime, closedAt }, now = new Date()) => {
    if (closedAt && now >= closedAt) return 'finished';
    // A draft still waiting for its dates.
    if (!isDay(startDate) || !isDay(endDate)) return 'upcoming';
    if (now < campaignStartsAt(startDate, startTime)) return 'upcoming';
    return now >= campaignEndsAt(endDate, endTime) ? 'finished' : 'ongoing';
};
