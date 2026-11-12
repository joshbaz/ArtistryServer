import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import * as schema from '../schemas/tickets.mjs';
import * as controller from '../controllers/ticketsController.mjs';

/**
 * Tickets. The website reads events on sale; the Studio reads every one
 * (`/studio/events`). A Content Manager posts, edits, issues complimentary
 * tickets and voids; Finance also sees sales; every Studio role works the
 * door (check-in, the offline guest list and its sync).
 */
const router = express.Router();
const event = validate(schema.eventParam, 'params');
const editor = [requireAdmin, allow('content-manager')];
const sales = [requireAdmin, allow('content-manager', 'finance')];

/* Public */
router.get('/events', controller.listOnSale);
router.get('/events/:id', event, controller.getPublicEvent);
// Does an access code open a restricted type? (Refused codes are counted per IP: services/tickets/accessCodes.mjs.)
router.post('/events/:id/unlock', event, validate(schema.unlockBody), controller.unlock);

/* Studio */
router.get('/studio/events', requireAdmin, controller.listEvents);
router.post('/events', ...editor, validate(schema.createEventBody), controller.createEvent);
router.patch('/events/:id', event, ...editor, validate(schema.updateEventBody), controller.updateEvent);
router.delete('/events/:id', event, ...editor, controller.deleteEvent);
router.get('/events/:id/sales', event, ...sales, controller.listSales);
router.post('/events/:id/issue', event, ...editor, validate(schema.issueBody), controller.issue);
router.patch('/sales/:code', validate(schema.codeParam, 'params'), ...editor, validate(schema.voidBody), controller.voidTicket);
router.post('/sales/:code/resend', validate(schema.codeParam, 'params'), ...editor, controller.resend);

/* The door: every Studio role */
router.post('/check-in', requireAdmin, validate(schema.checkInBody), controller.checkIn);
router.post('/check-in/sync', requireAdmin, validate(schema.syncBody), controller.syncCheckIns);
router.get('/events/:id/guest-list', event, requireAdmin, controller.guestList);

export default router;
