import prisma from '../../utils/db.mjs';
import { invalidate } from '../../utils/sockets.js';

/**
 * Charges added on top of every payment: system maintenance for the
 * developers, and PesaPal's fee. The payer sees one "Charges" line.
 *
 * PesaPal takes its percentage of everything it collects, charges included,
 * so the total is worked out backwards: (price + maintenance) ÷ (1 − fee).
 * The client then receives exactly the price and the developers exactly
 * their share; rounding up to whole shillings means PesaPal's cut is never
 * short. E.g. UGX 10,000 at 5% and 3.5%: maintenance 500, total 10,881,
 * PesaPal 381.
 *
 * The rates live in one settings document a Super Admin can change; each
 * order keeps the rates it was made at.
 */

const DOC = 'payment-charges';

export const DEFAULT_RATES = {
    pesapalPercent: 3.5,
    maintenancePercent: 5,
    // The maintenance balance at which Finance is told a payout is due.
    payoutThresholdUGX: 200_000,
    // Who the maintenance is for, and their share of it (adds up to 100).
    recipients: [{ name: 'Josh', percent: 50 }, { name: 'Charlie', percent: 50 }],
};

export const getRates = async () => {
    const row = await prisma.settingsDoc.findUnique({ where: { id: DOC } });
    return { ...DEFAULT_RATES, ...(row?.data ?? {}) };
};

/** A Super Admin's change. The recipients aren't changed from the Studio. */
export const setRates = async ({ pesapalPercent, maintenancePercent, payoutThresholdUGX }) => {
    const data = { ...(await getRates()), pesapalPercent, maintenancePercent, payoutThresholdUGX };
    await prisma.settingsDoc.upsert({ where: { id: DOC }, create: { id: DOC, data }, update: { data } });
    // Checkouts everywhere show the new charges.
    invalidate('public', ['site', 'charges']);
    invalidate('member', ['site', 'charges']);
    invalidate('admin', ['admin', 'maintenance']);
    return data;
};

/** What the payer sees: only the two percentages. */
export const publicRates = async () => {
    const { pesapalPercent, maintenancePercent } = await getRates();
    return { pesapalPercent, maintenancePercent };
};

/**
 * The charges on a price. Mirrored by the sites (client utils/charges.js,
 * the-stream-site lib/charges.js) to show the total before checkout.
 * @param {number} priceUGX
 * @param {{ pesapalPercent: number, maintenancePercent: number }} rates
 */
export const chargesFor = (priceUGX, { pesapalPercent, maintenancePercent }) => {
    const maintenanceUGX = Math.round((priceUGX * maintenancePercent) / 100);
    const totalUGX = Math.ceil((priceUGX + maintenanceUGX) / (1 - pesapalPercent / 100));
    return { priceUGX, maintenanceUGX, pesapalFeeUGX: totalUGX - priceUGX - maintenanceUGX, chargesUGX: totalUGX - priceUGX, totalUGX };
};

/** The fields an order is created with: its charges and the rates behind them. */
export const orderCharges = async (priceUGX) => {
    const rates = await getRates();
    const { maintenanceUGX, pesapalFeeUGX, totalUGX } = chargesFor(priceUGX, rates);
    return { maintenanceUGX, pesapalFeeUGX, totalUGX, maintenancePercent: rates.maintenancePercent, pesapalPercent: rates.pesapalPercent };
};

/** What PesaPal collects for an order: its total, or the price on orders from before charges. */
export const totalOf = (order) => order.totalUGX ?? order.amountUGX;
