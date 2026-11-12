import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { whenOf } from './when.mjs';

/**
 * The buyer's tickets as a PDF (docs/20, section 10): one phone-sized page
 * per ticket (the event, when and where, the type and what it includes, the
 * QR code and the code in large type), then a receipt page. The QR holds
 * only the code: the door looks it up, so nothing else is in it.
 *
 * pdfkit's built-in Helvetica covers Latin text; other scripts in a name or
 * title are left out of the PDF (the email body shows them).
 */

const W = 360;
const H = 600;
const M = 28;
const INK = '#111111';
const MUTED = '#666666';
const BRAND = '#e8590c';

const money = (ugx) => `UGX ${ugx.toLocaleString('en')}`;
// Helvetica can't draw these; drop them rather than print boxes.
const latin = (s) => String(s ?? '').replace(/[^\u0000-ÿ–—‘’“”•…]/g, '');

const header = (doc, event) => {
    doc.rect(0, 0, W, 6).fill(BRAND);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('THE ARTISTRY360 · TICKET', M, M, { characterSpacing: 1.5 });
    doc.moveDown(0.6).fillColor(INK).font('Helvetica-Bold').fontSize(18).text(latin(event.title), { width: W - 2 * M });
    const details = [whenOf(event.startsAt, event.endsAt), latin(event.venue)].filter(Boolean);
    if (details.length) doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor(MUTED).text(details.join('\n'), { width: W - 2 * M });
    if (event.organizer) doc.moveDown(0.2).fontSize(9).text(`By ${latin(event.organizer)}`, { width: W - 2 * M });
};

/**
 * @param {{ event: object, tickets: { code: string, typeName: string, typeKey?: string }[], perks?: Map<string, string>, buyerName: string, reference: string, totalUGX: number, complimentary?: boolean }} sale
 * @returns {Promise<Buffer>}
 */
export const ticketsPdf = async ({ event, tickets, perks = new Map(), buyerName, reference, totalUGX, complimentary = false }) => {
    const qrs = await Promise.all(tickets.map((t) => QRCode.toBuffer(t.code, { errorCorrectionLevel: 'M', margin: 1, width: 600 })));
    const doc = new PDFDocument({ size: [W, H], margin: M, autoFirstPage: false, info: { Title: `Tickets: ${latin(event.title)}`, Author: 'The Artistry360' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    tickets.forEach((t, i) => {
        doc.addPage();
        header(doc, event);
        const qrSize = 220;
        const qrY = 210;
        doc.image(qrs[i], (W - qrSize) / 2, qrY, { width: qrSize, height: qrSize });
        doc.fillColor(INK).font('Courier-Bold').fontSize(24).text(t.code, M, qrY + qrSize + 14, { width: W - 2 * M, align: 'center', characterSpacing: 1 });
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13).text(latin(t.typeName), { width: W - 2 * M, align: 'center' });
        const perk = perks.get(t.typeKey);
        if (perk) doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(latin(perk), { width: W - 2 * M, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${latin(buyerName)} · Ticket ${i + 1} of ${tickets.length} · ${reference}`, M, H - M - 22, { width: W - 2 * M, align: 'center' });
        doc.text('One code lets one person in, once. Keep it private.', { width: W - 2 * M, align: 'center' });
    });

    // The receipt
    doc.addPage();
    header(doc, event);
    doc.moveDown(1.2).fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Receipt');
    doc.moveDown(0.4).font('Helvetica').fontSize(10).fillColor(INK);
    // Label and value side by side; the next row starts below the taller of the two.
    const row = (label, value) => {
        const y = doc.y;
        const valueWidth = W - 2 * M - 110;
        doc.fillColor(MUTED).text(label, M, y, { width: 110 });
        doc.fillColor(INK).text(value || '–', M + 110, y, { width: valueWidth });
        doc.y = y + Math.max(doc.heightOfString(label, { width: 110 }), doc.heightOfString(value || '–', { width: valueWidth })) + 5;
        doc.x = M;
    };
    row('Order', reference);
    row('Name', latin(buyerName));
    const counts = new Map();
    for (const t of tickets) counts.set(t.typeName, (counts.get(t.typeName) ?? 0) + 1);
    row('Tickets', [...counts].map(([name, n]) => `${n} × ${latin(name)}`).join('\n'));
    row(complimentary ? 'Price' : 'Paid', complimentary ? 'Complimentary' : totalUGX ? `${money(totalUGX)} (charges included)` : 'Free');
    doc.moveDown(1).fillColor(MUTED).fontSize(9).text(latin(event.terms) || 'One QR code admits one person, once. Keep your codes private: whoever scans a code first gets in. Tickets are non-refundable unless the event is cancelled or rescheduled.', M, doc.y, { width: W - 2 * M });

    doc.end();
    return done;
};
