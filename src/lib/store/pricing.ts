/**
 * How a catalogue row becomes a number of agorot.
 *
 * ── Two questions, kept apart ──────────────────────────────────────────────
 *
 * "What does one of these cost?" and "how many is the guest buying?" are
 * different questions, and every pricing bug this module could have starts by
 * conflating them. A per-guest price of ₪120 for a family of five is one unit
 * price of 12000 and a quantity of 5 — not a unit price of 60000 and a
 * quantity of 1, and not 12000 × 5 collapsed into a single figure nobody can
 * take apart afterwards.
 *
 * So `quantityFor` answers the second question from the booking's own facts,
 * `unitPriceFor` answers the first, and neither ever multiplies. The
 * multiplication happens once, in the database, in a generated column — see
 * `store_order_lines.line_total_agorot` in 0032.
 *
 * ── `quote` and `starting_from` are answers, not gaps ──────────────────────
 *
 * A caterer for thirty people is quoted. A product whose model is `quote` has
 * no `basePriceAgorot` at all, and this module refuses to invent one: the
 * guest is shown "בקש הצעה" and the order line is written with a price a
 * person typed and a `priceSource` of `quote`.
 *
 * `starting_from` is the other honest answer — a real number that is a floor
 * rather than a promise. It prices exactly like `fixed` and is *labelled*
 * differently, which is a rendering decision and belongs to `labels.ts`.
 *
 * ── Money ─────────────────────────────────────────────────────────────────
 *
 * Integer agorot throughout, and this file never divides. The one place a
 * fraction could appear is a percentage discount, and that goes through
 * `applyPercent` in `src/lib/finance/money.ts`, which is the product's single
 * rounding rule. There is no second one here.
 */

import { applyPercent } from '../finance/money'
import type { Agorot } from '../booking/types'
import type { StorePricingModel } from '../contracts/states'
import type {
  BookingFacts,
  CatalogueItem,
  StoreItemAddon,
  StoreItemOption,
  StoreItemOptionValue,
  StoreItemPropertyOverride,
  StorePromoCode,
} from './types'
import { partySize } from './types'

/* -------------------------------------------------------------- quantity -- */

/** What the guest asked for, where the model lets them ask. */
export type QuantityRequest = {
  /** For `per_unit`, `per_hour` and `fixed`. Ignored by the derived models. */
  requested?: number
}

/** Nights between two ISO dates. Whole days; a stay is never half a night. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const from = Date.parse(`${checkIn}T00:00:00Z`)
  const to = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.max(0, Math.round((to - from) / 86_400_000))
}

/**
 * Is the multiplier the guest's to choose, or the booking's to state?
 *
 * The models below the line derive their quantity from the stay, and a screen
 * that offered a quantity box for them would be offering a contradiction: a
 * per-night price for a three-night stay is not a thing anybody buys two of.
 */
export function quantityIsChosenByGuest(model: StorePricingModel): boolean {
  return (
    model === 'fixed' ||
    model === 'per_unit' ||
    model === 'per_hour' ||
    model === 'starting_from' ||
    model === 'quote'
  )
}

/**
 * How many units this purchase is, for this booking.
 *
 * Clamped to the item's own `minQuantity` / `maxQuantity`, because a family of
 * eight buying a product capped at six is a real situation and silently
 * charging for eight is the wrong resolution of it. `eligibility.ts` is what
 * *refuses* in that case; this function is what prices whatever survived the
 * refusal.
 */
export function quantityFor(
  item: Pick<CatalogueItem, 'pricingModel' | 'minQuantity' | 'maxQuantity'>,
  booking: BookingFacts | null,
  request: QuantityRequest = {},
): number {
  const derived = ((): number => {
    switch (item.pricingModel) {
      case 'per_guest':
        return booking ? partySize(booking) : 1
      case 'per_child':
        return booking ? booking.children : 1
      case 'per_night':
        return booking ? nightsBetween(booking.checkIn, booking.checkOut) : 1
      case 'fixed':
      case 'per_unit':
      case 'per_hour':
      case 'starting_from':
      case 'quote':
        return Math.trunc(request.requested ?? item.minQuantity)
    }
  })()

  const floor = Math.max(1, item.minQuantity)
  const ceiling = item.maxQuantity ?? Number.MAX_SAFE_INTEGER
  return Math.min(Math.max(derived, floor), ceiling)
}

/* ------------------------------------------------------------ unit price -- */

/**
 * The price of one unit, right now, at this property.
 *
 * THIS IS A CATALOGUE READ AND IT IS ONLY EVER CORRECT BEFORE A PURCHASE.
 * Once an order exists, its line carries `unitPriceAgorot` and that is the
 * only figure anybody may use. Nothing in this module calls this function with
 * an order in hand; `snapshot.ts` calls it exactly once, at the moment of
 * purchase, and freezes the answer.
 *
 * Returns `null` for `quote`, which is not a failure: it is the product saying
 * it has no number, and the caller's job is to render "בקש הצעה" rather than
 * to substitute a zero.
 */
export function unitPriceFor(
  item: Pick<CatalogueItem, 'pricingModel' | 'basePriceAgorot'>,
  override?: Pick<StoreItemPropertyOverride, 'priceOverrideAgorot'> | null,
): Agorot | null {
  if (item.pricingModel === 'quote') return null

  const overridden = override?.priceOverrideAgorot
  if (overridden !== null && overridden !== undefined) return overridden

  return item.basePriceAgorot ?? null
}

/** Which of the two the price came from. Written onto the line as provenance. */
export function priceSourceFor(
  item: Pick<CatalogueItem, 'pricingModel'>,
  override?: Pick<StoreItemPropertyOverride, 'priceOverrideAgorot'> | null,
): 'catalogue' | 'override' | 'quote' {
  if (item.pricingModel === 'quote') return 'quote'
  const overridden = override?.priceOverrideAgorot
  return overridden !== null && overridden !== undefined
    ? 'override'
    : 'catalogue'
}

/* --------------------------------------------------- options and add-ons -- */

/** One chosen option value, as the cart carries it before it is snapshotted. */
export type ChosenOption = {
  optionId: string
  optionValueId: string
}

export type ResolvedOption = {
  optionId: string
  optionName: string
  optionValueId: string
  valueLabel: string
  priceDeltaAgorot: Agorot
}

/**
 * Turn the ids a cart holds into the labels and deltas a line needs.
 *
 * Unknown ids are dropped rather than defaulted. A cart naming an option that
 * no longer exists is exactly the mid-checkout catalogue change §12 is about,
 * and `cart.ts` compares the resolved set against the requested set to tell
 * the guest what changed. Silently substituting a default here would hide the
 * one event the guest most needs to be told about.
 */
export function resolveOptions(
  options: readonly StoreItemOption[],
  chosen: readonly ChosenOption[],
): readonly ResolvedOption[] {
  const resolved: ResolvedOption[] = []

  for (const pick of chosen) {
    const group = options.find((option) => option.id === pick.optionId)
    if (!group) continue

    const value: StoreItemOptionValue | undefined = group.values.find(
      (candidate) => candidate.id === pick.optionValueId,
    )
    if (!value || !value.isAvailable) continue

    resolved.push({
      optionId: group.id,
      optionName: group.name,
      optionValueId: value.id,
      valueLabel: value.label,
      priceDeltaAgorot: value.priceDeltaAgorot,
    })
  }

  return resolved
}

/**
 * What the chosen options add to one unit. Signed, because a delta may be
 * negative and a smaller size costing less is not an error to be clamped away.
 *
 * The result is floored at the negative of the unit price by the caller, not
 * here: this function's job is arithmetic, and refusing an order whose options
 * take it below zero is a domain rule that belongs in `snapshot.ts`.
 */
export function optionsTotalAgorot(
  resolved: readonly ResolvedOption[],
): Agorot {
  return resolved.reduce((sum, option) => sum + option.priceDeltaAgorot, 0)
}

/** One chosen add-on, as the cart carries it. */
export type ChosenAddon = {
  addonId: string
  quantity: number
}

export type ResolvedAddon = {
  addonId: string
  name: string
  quantity: number
  unitPriceAgorot: Agorot
  totalAgorot: Agorot
}

export function resolveAddons(
  addons: readonly StoreItemAddon[],
  chosen: readonly ChosenAddon[],
): readonly ResolvedAddon[] {
  const resolved: ResolvedAddon[] = []

  for (const pick of chosen) {
    const addon = addons.find((candidate) => candidate.id === pick.addonId)
    if (!addon || !addon.isActive) continue

    const capped = Math.min(
      Math.max(1, Math.trunc(pick.quantity)),
      addon.maxQuantity ?? Number.MAX_SAFE_INTEGER,
    )

    resolved.push({
      addonId: addon.id,
      name: addon.name,
      quantity: capped,
      unitPriceAgorot: addon.priceAgorot,
      totalAgorot: addon.priceAgorot * capped,
    })
  }

  return resolved
}

export function addonsTotalAgorot(resolved: readonly ResolvedAddon[]): Agorot {
  return resolved.reduce((sum, addon) => sum + addon.totalAgorot, 0)
}

/* ----------------------------------------------------------- promo codes -- */

export type PromoOutcome =
  { ok: true; discountAgorot: Agorot } | { ok: false; reason: PromoRefusal }

export type PromoRefusal =
  | 'inactive'
  | 'not_yet_valid'
  | 'expired'
  | 'exhausted'
  | 'below_minimum'
  | 'not_applicable'

/**
 * What a promo code takes off an order, or why it takes nothing.
 *
 * Returns a reason rather than a zero, because "this code does not apply to
 * anything in your basket" and "this code is worth nothing" are different
 * sentences and only the first one is useful to a guest.
 *
 * The discount is clamped to the subtotal. A ₪200 code on a ₪150 order takes
 * ₪150 and does not produce a negative total, which is the shape a refund
 * would have and is not what a discount means.
 */
export function evaluatePromoCode(
  code: StorePromoCode,
  input: {
    subtotalAgorot: Agorot
    /** The item ids actually in the basket. */
    itemIds: readonly string[]
    now: Date
  },
): PromoOutcome {
  if (!code.isActive) return { ok: false, reason: 'inactive' }

  const at = input.now.getTime()
  if (code.validFrom && at < Date.parse(code.validFrom)) {
    return { ok: false, reason: 'not_yet_valid' }
  }
  if (code.validUntil && at >= Date.parse(code.validUntil)) {
    return { ok: false, reason: 'expired' }
  }
  if (code.maxUses !== null && code.uses >= code.maxUses) {
    return { ok: false, reason: 'exhausted' }
  }
  if (input.subtotalAgorot < code.minOrderAgorot) {
    return { ok: false, reason: 'below_minimum' }
  }

  // An empty `itemIds` on the code means "everything". A non-empty one has to
  // intersect the basket, or the code applies to nothing that is in it.
  if (code.itemIds.length > 0) {
    const applies = input.itemIds.some((id) => code.itemIds.includes(id))
    if (!applies) return { ok: false, reason: 'not_applicable' }
  }

  const raw =
    code.discountKind === 'percent'
      ? applyPercent(input.subtotalAgorot, code.percent ?? 0)
      : (code.amountAgorot ?? 0)

  return {
    ok: true,
    discountAgorot: Math.min(Math.max(0, raw), input.subtotalAgorot),
  }
}
