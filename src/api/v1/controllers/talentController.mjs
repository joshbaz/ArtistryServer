import * as talent from '../../../services/talent/talent.mjs';
import * as monologues from '../../../services/talent/monologues.mjs';
import * as bookings from '../../../services/talent/bookings.mjs';

/** Studio › Website › Talent and Bookings, and the public roster, profiles and booking form. */

const created = (res, data) => res.status(201).json({ data });
const gone = (res) => res.status(204).end();

/* Talent (Studio: every field) */
export const listTalent = async (req, res) => res.json({ data: await talent.listTalent() });
export const createTalent = async (req, res) => created(res, await talent.createTalent(req.body));
export const updateTalent = async (req, res) => res.json({ data: await talent.updateTalent(req.params.id, req.body) });
export const deleteTalent = async (req, res) => gone(res, await talent.deleteTalent(req.params.id));

/* Public roster */
export const listProfiles = async (req, res) => res.json({ data: await talent.listProfiles(req.query) });
export const getProfile = async (req, res) => res.json({ data: await talent.getProfile(req.params.id) });

/* Monologues */
export const listMonologues = async (req, res) => res.json({ data: await monologues.listMonologues(req.params.talentId) });
export const listAllMonologues = async (req, res) => res.json({ data: await monologues.listAllMonologues() });
export const createMonologue = async (req, res) => created(res, await monologues.createMonologue(req.body));
export const updateMonologue = async (req, res) => res.json({ data: await monologues.updateMonologue(req.params.id, req.body) });
export const deleteMonologue = async (req, res) => gone(res, await monologues.deleteMonologue(req.params.id));

/* Bookings */

/** POST talent/bookings (public). A filled honeypot is a bot: it looks received, and nothing is saved. */
export const requestBooking = async (req, res) => {
    const { website, ...request } = req.body;
    if (website) return created(res, { id: '', reference: '', status: 'received', talentIds: request.talentIds, name: request.name, email: request.email, phone: request.phone });
    created(res, await bookings.requestBooking(request));
};

export const listBookings = async (req, res) => res.json({ data: await bookings.listBookings() });
// The history names the signed-in staff member, from their session.
export const updateBooking = async (req, res) => res.json({ data: await bookings.updateBooking(req.params.id, req.body, req.admin.name) });
export const addBookingNote = async (req, res) => created(res, await bookings.addBookingNote(req.params.id, req.body.text, req.admin.name));
export const setBookingsStatus = async (req, res) => res.json({ data: await bookings.setBookingsStatus(req.body.ids, req.body.status, req.admin.name) });
export const deleteBooking = async (req, res) => gone(res, await bookings.deleteBookings([req.params.id]));
export const deleteBookings = async (req, res) => gone(res, await bookings.deleteBookings(req.body.ids));
