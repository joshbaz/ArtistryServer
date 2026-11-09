/**
 * Asks PesaPal about pending payments and prints what it says. Read only:
 * nothing is marked paid, failed or anything else (the Studio's Check does
 * that). Prints our reference, what it was for, when, the keys it was made
 * with and PesaPal's answer; never a payer's name, email, phone or account.
 *
 *   node scripts/check-pending-payments.mjs            every pending payment (newest 50)
 *   node scripts/check-pending-payments.mjs vip        pending VIP passes only (or votes, ticket, ppv…)
 *   node scripts/check-pending-payments.mjs A360-…     one payment, any status: what we hold and PesaPal's
 *                                                      whole reply (less the payer's account fields)
 */
import prisma from '../src/utils/db.mjs';
import { env } from '../src/env.mjs';
import { getStatus, isPesapalConfigured, rawStatus } from '../src/services/payments/pesapal.mjs';

const arg = process.argv[2];
if (!isPesapalConfigured()) {
    console.log('PesaPal keys are not set in .env, so there is nothing to ask.');
    process.exit(1);
}

if (arg?.startsWith('A360-')) {
    const o = await prisma.paymentOrder.findUnique({ where: { reference: arg }, select: { reference: true, kind: true, status: true, statusNote: true, trackingId: true, pesapalEnv: true, pesapalStatus: true, pesapalNote: true, method: true, createdAt: true, lastCheckedAt: true } });
    if (!o) {
        console.log(`No payment ${arg} on this server.`);
        process.exit(1);
    }
    console.log(`Server keys: ${env.PESAPAL_ENV}\nWhat we hold:`, { ...o, trackingId: o.trackingId ? 'yes' : 'no' });
    if (o.trackingId) console.log("PesaPal's reply:", await rawStatus(o.trackingId).catch((error) => `could not ask: ${error.message}`));
    await prisma.$disconnect();
    process.exit(0);
}
const kind = arg;

const orders = await prisma.paymentOrder.findMany({
    where: { status: 'pending', ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { reference: true, kind: true, module: true, totalUGX: true, amountUGX: true, createdAt: true, trackingId: true, pesapalEnv: true },
});
console.log(`Server keys: ${env.PESAPAL_ENV}. Pending${kind ? ` ${kind}` : ''} payments: ${orders.length}${orders.length === 50 ? ' (newest 50)' : ''}\n`);

for (const o of orders) {
    const line = [o.reference, o.kind, `UGX ${(o.totalUGX ?? o.amountUGX).toLocaleString('en')}`, o.createdAt.toISOString().slice(0, 16).replace('T', ' '), `made with ${o.pesapalEnv ?? 'unknown'} keys`];
    let answer;
    if (!o.trackingId) answer = 'never reached PesaPal';
    else if (o.pesapalEnv && o.pesapalEnv !== env.PESAPAL_ENV) answer = `not asked: made with the ${o.pesapalEnv} keys`;
    else {
        try {
            const s = await getStatus(o.trackingId);
            answer = `PesaPal: ${s.status || '(no status)'}${s.note ? `, "${s.note}"` : ''}${s.state === 'completed' ? `, paid ${s.amount} ${s.currency}. Press Check in the Studio to complete it.` : ''}`;
        } catch (error) {
            answer = `could not ask PesaPal: ${error.message}`;
        }
    }
    console.log(`${line.join(' · ')}\n    ${answer}`);
}
await prisma.$disconnect();
process.exit(0);
