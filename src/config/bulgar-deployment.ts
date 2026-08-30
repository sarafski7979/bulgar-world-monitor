/**
 * Bulgar deployment switches.
 *
 * Upstream World Monitor sells a "Pro" tier. Bulgar does not: this fork has no
 * Dodo Payments account, no Clerk billing tenant, and no entitlement backend of
 * its own. Every upstream upgrade call-to-action therefore either dead-ends or
 * — worse — sends a Bulgar visitor to upstream's checkout to buy a product
 * Bulgar is not selling and cannot fulfil.
 *
 * These flags turn off the *promotional* surfaces only. They deliberately do
 * NOT touch the entitlements system itself:
 *   - `src/services/pro-banner-policy.ts` and `src/components/ProBanner.ts` are
 *     left byte-for-byte intact, so their unit tests keep passing and a future
 *     Bulgar billing integration can flip a flag rather than restore deleted
 *     code.
 *   - Free-tier gating (panel limits, `isPanelEntitled`, `enforceFreePanelLimit`)
 *     is untouched. It is real product behaviour, not advertising, and the
 *     entitlements crosswalk test pins its gate counts per (file, predicate).
 */

/**
 * Whether to show upstream's Pro upgrade promotion.
 *
 * `false` on this fork. Set to `true` only if Bulgar acquires its own billing
 * integration — and re-point the checkout before you do, or the money lands in
 * upstream's account.
 */
export const BULGAR_OFFERS_UPSTREAM_PRO = false;
