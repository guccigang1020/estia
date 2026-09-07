/**
 * A code is compared folded and stored as typed.
 *
 * A guest reads `SUMMER25` off a card and types `summer25` into a phone that
 * autocapitalises nothing. If those are two different codes the coupon does
 * not work, and the guest concludes the business lied to them rather than that
 * a comparison was case-sensitive.
 *
 * So: **fold to compare, keep to display.** The database agrees — `code` is
 * stored exactly as typed and `code_folded` is a generated column carrying the
 * unique index, so `SUMMER25` and `summer25` cannot both exist as separate
 * coupons and a folded lookup therefore returns exactly one row.
 *
 * `foldCode` is the single definition of that fold. It must stay identical to
 * `upper(btrim(code))` in `0073_promotions_and_coupons.sql`; a second, subtly
 * different fold on this side would produce a lookup that misses rows the
 * database considers duplicates.
 */

/**
 * Upper case, outer whitespace removed.
 *
 * `toUpperCase()` and not `toLocaleUpperCase()`, deliberately. The locale
 * variant would fold a Turkish dotless ı differently depending on where the
 * server thinks it is, and a coupon that works in one region and not another
 * is worse than one that never works. Both code patterns below are ASCII, so
 * there is nothing for a locale to disagree about.
 */
export function foldCode(code: string): string {
  return code.trim().toUpperCase()
}

/** True when two codes name the same discount. */
export function codesMatch(a: string, b: string): boolean {
  return foldCode(a) === foldCode(b)
}

/**
 * §8. A promotion code is a machine identifier: lower case, 2–40 characters.
 *
 * No guest ever types one — it names a campaign in reports and in the audit
 * trail — so the strict shape from the spec is kept as it is.
 */
export const PROMOTION_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/

/**
 * §8 relaxed, in one direction, on purpose.
 *
 * The spec writes `^[A-Z0-9-]+$`, which describes how a coupon code is
 * PRINTED. Enforcing it at issue time would refuse `Summer25` from a business
 * typing its own campaign name in the wrong shift state, and would make the
 * fold pointless in the only direction it is ever used — a guest typing lower
 * case. So either case is accepted here and by the CHECK in 0073, and the fold
 * is what makes the two the same coupon.
 *
 * Four characters is the floor because a three-character code is guessable at
 * a rate that matters when the prize is money: a bearer coupon is a bearer
 * instrument, and `A1` would be found by somebody trying.
 */
export const COUPON_CODE_PATTERN = /^[A-Za-z0-9-]{4,24}$/

export function isPromotionCode(code: string): boolean {
  return PROMOTION_CODE_PATTERN.test(code.trim())
}

export function isCouponCode(code: string): boolean {
  return COUPON_CODE_PATTERN.test(code.trim())
}
