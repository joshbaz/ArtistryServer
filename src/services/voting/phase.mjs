/**
 * Campaign time, the same rules as the client's utils/voting.js: a campaign
 * runs from 00:00 on its start date to 23:59:59 on its end date, Kampala
 * time (UTC+3, no daylight saving), and an early close from the Studio ends
 * it at that moment.
 */

const KAMPALA = '+03:00';

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const campaignStartsAt = (date) => new Date(`${date}T00:00:00${KAMPALA}`);
export const campaignEndsAt = (date) => new Date(`${date}T23:59:59${KAMPALA}`);

/**
 * "upcoming", "ongoing" or "finished".
 * @param {{ startDate: string, endDate: string, closedAt?: Date | null }} campaign
 */
export const campaignPhase = ({ startDate, endDate, closedAt }, now = new Date()) => {
    if (closedAt && now >= closedAt) return 'finished';
    // A draft still waiting for its dates.
    if (!isDay(startDate) || !isDay(endDate)) return 'upcoming';
    if (now < campaignStartsAt(startDate)) return 'upcoming';
    return now > campaignEndsAt(endDate) ? 'finished' : 'ongoing';
};
