import * as events from '../../../services/tickets/events.mjs';
import * as tickets from '../../../services/tickets/tickets.mjs';

/**
 * Tickets (docs/20-ticketing-backend-handoff.md): the pages that sell them,
 * and the Studio's posting, sales, complimentary tickets and the door.
 * Buying goes through POST payments/orders (kind "ticket").
 */

const created = (res, data) => res.status(201).json({ data });
const gone = (res) => res.status(204).end();
// A door's answers are about this moment only.
const noStore = (res) => res.set('Cache-Control', 'no-store');

/* Public */
export const listOnSale = async (req, res) => res.json({ data: await events.listOnSale() });
export const getPublicEvent = async (req, res) => res.json({ data: await events.getPublicEvent(req.params.id) });

/* Studio */
export const listEvents = async (req, res) => res.json({ data: await events.listEvents() });
export const createEvent = async (req, res) => created(res, await events.createEvent(req.body, req.admin));
export const updateEvent = async (req, res) => res.json({ data: await events.updateEvent(req.params.id, req.body, req.admin) });
export const deleteEvent = async (req, res) => gone(res, await events.deleteEvent(req.params.id, req.admin));
export const listSales = async (req, res) => res.json({ data: await tickets.listSales(req.params.id) });
export const issue = async (req, res) => created(res, await tickets.issueComplimentary(req.params.id, req.body, req.admin));
export const voidTicket = async (req, res) => res.json({ data: await tickets.voidTicket(req.params.code, req.admin) });
export const resend = async (req, res) => res.json({ data: await tickets.resendTickets(req.params.code, req.admin) });

/* The door */
export const checkIn = async (req, res) => noStore(res).json({ data: await tickets.checkIn(req.body, req.admin) });
export const guestList = async (req, res) => noStore(res).json({ data: await tickets.guestList(req.params.id, req.admin) });
export const syncCheckIns = async (req, res) => noStore(res).json({ data: await tickets.syncCheckIns(req.body, req.admin) });
