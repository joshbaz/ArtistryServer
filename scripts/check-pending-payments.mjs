/**
 * Asks PesaPal about pending payments and prints what it says. Read only:
 * nothing is marked paid, failed or anything else (the Studio's Check does
 * that). Prints our reference, what it was for, when, the keys it was made
 * with and PesaPal's answer; never a payer's name, email, phone or account.
 *
 *   node scripts/check-pending-payments.mjs            every pending payment (newest 50)
 *   node scripts/check-pending-payments.mjs vip        pending VIP passes only (or votes, ticket, ppv…)
 */
import prisma from '../src/utils/db.mjs';
import { env } from '../src/env.mjs';
import { getStatus, isPesapalConfigured } from '../src/services/payments/pesapal.mjs';

const kind = process.argv[2];
if (!isPesapalConfigured()) {
    console.log('PesaPal keys are not set in .env, so there is nothing to ask.');
    process.exit(1);
}

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
