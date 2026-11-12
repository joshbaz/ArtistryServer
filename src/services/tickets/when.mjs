/** When a ticket's event is, in Kampala time, as the email and the PDF print it. */

const ZONE = 'Africa/Kampala';
const full = (d) => new Date(d).toLocaleString('en-GB', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: ZONE });

/** "Sun 6 Dec 2026, 08:00", with the end when there is one ("– 14:00" the same day, the full date otherwise). Empty with no start. */
export const whenOf = (startsAt, endsAt) => {
    if (!startsAt) return '';
    if (!endsAt) return full(startsAt);
    return `${full(startsAt)} – ${day(startsAt) === day(endsAt) ? time(endsAt) : full(endsAt)}`;
};
