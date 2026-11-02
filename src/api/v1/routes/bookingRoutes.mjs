import express from 'express';
import validate from '../../../middleware/validate.mjs';
import { allow, requireAdmin } from '../../../middleware/auth.mjs';
import { idParam } from '../schemas/common.mjs';
import * as schema from '../schemas/talent.mjs';
import * as controller from '../controllers/talentController.mjs';

/**
 * Talent booking requests. A guest sends one (public, rate limited per IP in
 * utils/rateLimits.js); the Studio works through them. They carry the
 * guest's contact details: any Studio role reads, a Content Manager acts.
 */
const router = express.Router();
const id = validate(idParam, 'params');
const editor = allow('content-manager');

router.post('/', validate(schema.bookingRequestBody), controller.requestBooking);

router.get('/', requireAdmin, controller.listBookings);
router.patch('/', requireAdmin, editor, validate(schema.bulkStatusBody), controller.setBookingsStatus);
router.delete('/', requireAdmin, editor, validate(schema.bulkDeleteBody), controller.deleteBookings);
router.patch('/:id', id, requireAdmin, editor, validate(schema.updateBookingBody), controller.updateBooking);
router.post('/:id/notes', id, requireAdmin, editor, validate(schema.bookingNoteBody), controller.addBookingNote);
router.delete('/:id', id, requireAdmin, editor, controller.deleteBooking);

export default router;
