/**
 * Pay-per-view premiere pricing (19-pricing-backend-handoff.md). A ppv title
 * may carry a schedule, `ppv`:
 *
 *   early      before premiereAt                               earlyUGX
 *   premiere   from premiereAt, for premiereDays               premiereUGX
 *   standard   after that                                      standardUGX
 *
 * Each stage starts at its first instant. A ppv title without a schedule
 * keeps its flat priceUGX, as before. This is the only place a price is
 * worked out: the Studio, the stream site and the app show the same rule
 * (ppvStage / stageAt) for display, and what they send is never trusted.
 */

const DAY = 24 * 3600 * 1000;

/** The schedule as stored (premiereAt as an ISO string), or null for a flat price. */
export const scheduleOf = (title) => (title.accessTier === 'ppv' && title.ppv?.premiereAt ? title.ppv : null);

/** → { stage, priceUGX, nextChangeAt } for a title as stored, at `now`. nextChangeAt is null once standard. */
export const ppvStage = (title, now = Date.now()) => {
    const s = scheduleOf(title);
    if (!s) return { stage: 'standard', priceUGX: title.accessTier === 'ppv' ? title.priceUGX : 0, nextChangeAt: null };
    const start = Date.parse(s.premiereAt);
    const end = start + s.premiereDays * DAY;
    if (now < start) return { stage: 'early', priceUGX: s.earlyUGX, nextChangeAt: new Date(start).toISOString() };
    if (now < end) return { stage: 'premiere', priceUGX: s.premiereUGX, nextChangeAt: new Date(end).toISOString() };
    return { stage: 'standard', priceUGX: s.standardUGX, nextChangeAt: null };
};

/**
 * Subscribers watch a pay-per-view film once it reaches the standard stage;
 * early access and the premiere stay paid for everyone, so premiere sales
 * are protected. The stream site's and the app's accessFor follow the same rule.
 */
export const SUBSCRIBER_STAGES = ['standard'];
export const includedInPlan = (title, now = Date.now()) => title.accessTier === 'ppv' && SUBSCRIBER_STAGES.includes(ppvStage(title, now).stage);
