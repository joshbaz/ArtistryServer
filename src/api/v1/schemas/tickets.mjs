import { z } from 'zod';
import { imageField, text } from './common.mjs';

/**
 * Tickets (docs/20-ticketing-backend-handoff.md, section 2). What the Studio
 * may send; the rules that need the stored event (seats never below what's
 * taken, a type with sales can't go) are services/tickets/events.mjs's.
 */

export const CATEGORIES = ['Film and premiere', 'Concert and music', 'Theatre and performance', 'Workshop and class', 'Conference and talk', 'Festival and fair', 'Sports', 'Fundraiser', 'Exhibition', 'Other'];
export const STATUSES = ['Draft', 'On sale', 'Closed'];

/** An event, type or question id: tkt_premiere, tt_regular, q_a1b2c3. */
export const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/i, 'We could not find that.');
/** TKT- and 8 characters; lower case and spaces are tidied first. */
export const code = z.string().trim().toUpperCase().pipe(z.string().regex(/^TKT-[A-Z0-9]{8}$/, 'That is not a ticket code.'));

const isoDate = z.iso.datetime({ offset: true, error: 'Use a full date and time.' });
const when = isoDate.nullable();

const type = z
    .object({
        id: key.optional(),
        name: text(80).pipe(z.string().min(1, 'Give each ticket type a name.')),
        priceUGX: z.coerce.number().int('Whole shillings only.').min(0, 'A price is 0 (free) or more.').max(10_000_000),
        seats: z.coerce.number().int().min(1, 'At least 1 seat.').max(100_000, 'Up to 100,000 seats.'),
        perk: text(160).default(''),
        onSaleFrom: when.default(null),
        onSaleUntil: when.default(null),
    })
    .refine((t) => !t.onSaleFrom || !t.onSaleUntil || Date.parse(t.onSaleUntil) > Date.parse(t.onSaleFrom), { path: ['onSaleUntil'], message: 'Sales must end after they start.' });

const question = z
    .object({
        id: key.optional(),
        label: text(80).pipe(z.string().min(1, 'Give each question a label.')),
        kind: z.enum(['text', 'choice']),
        options: z.array(text(40).pipe(z.string().min(1))).max(10).optional(),
        required: z.boolean().default(false),
    })
    .refine((q) => q.kind !== 'choice' || (q.options && q.options.length >= 2 && new Set(q.options).size === q.options.length), { path: ['options'], message: 'A choice needs 2 to 10 different options.' })
    .transform(({ options, ...q }) => (q.kind === 'choice' ? { ...q, options } : q));

const uniqueNames = (types) => new Set(types.map((t) => t.name.toLowerCase())).size === types.length;

const eventFields = {
    title: text(120).pipe(z.string().min(1, 'Give the ticket a title.')),
    description: text(3000).pipe(z.string().min(1, 'Say what the ticket is for.')),
    image: imageField('The image'),
    startsAt: when,
    venue: text(200),
    status: z.enum(STATUSES, { error: 'Choose Draft, On sale or Closed.' }),
    organizer: text(80),
    category: z.enum(CATEGORIES, { error: 'Choose what kind of event it is.' }),
    maxPerOrder: z.coerce.number().int().min(1, '1 to 20 tickets.').max(20, '1 to 20 tickets.').nullable(),
    terms: text(1000),
    types: z.array(type).min(1, 'Add at least one ticket type.').max(20).refine(uniqueNames, 'Each ticket type needs its own name.'),
    questions: z.array(question).max(8, 'Up to 8 questions.'),
};

/** POST tickets/events */
export const createEventBody = z.object({
    ...eventFields,
    image: eventFields.image.default(''),
    startsAt: eventFields.startsAt.default(null),
    venue: eventFields.venue.default(''),
    status: eventFields.status.default('Draft'),
    organizer: eventFields.organizer.default(''),
    category: eventFields.category.default('Other'),
    maxPerOrder: eventFields.maxPerOrder.default(null),
    terms: eventFields.terms.default(''),
    questions: eventFields.questions.default([]),
});

/** PATCH tickets/events/:id. `types`, when sent, is the whole list. */
export const updateEventBody = z.object(eventFields).partial();

export const eventParam = z.object({ id: key });
export const codeParam = z.object({ code });

/** POST tickets/events/:id/issue: complimentary tickets. issuedBy comes from the session. */
export const issueBody = z.object({
    typeId: key,
    qty: z.coerce.number().int().min(1, 'Issue at least 1 ticket.').max(20),
    name: text(80).pipe(z.string().min(2, "Enter the guest's name.")),
    email: z.union([z.literal(''), z.email('Check the email address.')]).optional(),
    phone: text(20).optional(),
    note: text(200).pipe(z.string().min(1, 'Say why they get a free ticket.')),
});

/** PATCH tickets/sales/:code */
export const voidBody = z.object({ status: z.literal('void', { error: 'A ticket can only be voided here.' }) });

/** POST tickets/check-in */
export const checkInBody = z.object({ code, eventId: key.optional() });

/** POST tickets/check-in/sync: check-ins made offline, oldest first. */
export const syncBody = z.object({
    eventId: key,
    checkIns: z.array(z.object({ code: z.string().trim().toUpperCase().max(20), at: isoDate })).max(2000, 'Sync up to 2,000 check-ins at a time.'),
});
