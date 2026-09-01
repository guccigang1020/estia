/**
 * The guest's basket, and the moment before it becomes an order.
 *
 * ── The failure this module is written around ─────────────────────────────
 *
 * A guest puts שולחן שוק in the basket at ₪1,500 on Tuesday, leaves the tab
 * open, and checks out on Thursday. In between, the owner raised the price to
 * ₪1,800, paused the product, or sold the last slot for that Saturday.
 *
 * Three wrong answers, all of which somebody ships:
 *
 *   · Charge ₪1,500 because that is what the cart says — the business loses
 *     money on a price it never agreed to.
 *   · Charge ₪1,800 quietly — the guest is charged more than the screen in
 *     front of them said, which in Israel is also a consumer-law problem.
 *   · Empty the basket with "something changed" — the guest starts again and
 *     mostly does not.
 *
 * The right answer is the fourth: **revalidate, and show the guest exactly
 * what changed, in words, before anything is submitted.** `revalidateCart`
 * produces that list. The checkout screen renders it and requires a second,
 * deliberate confirmation when it is non-empty.
 *
 * ── Why the cart is not a table ───────────────────────────────────────────
 *
 * A basket is not a business record. It has no audit trail, nobody is owed
 * anything for it, and storing one per guest would put an abandoned-cart table
 * into a product whose whole premise is that it does not chase people. It
 * lives in the browser — see `store-cart.tsx`, which persists it to
 * `localStorage` so a refresh does not lose it — and it exists on the server
 * only for the length of one revalidation.
 *
 * What IS stored is the moment it became a commitment: a `store_orders` row,
 * with `submission_key` so that two taps cannot make two of them.
 */

import type { Agorot } from '../booking/types'
import { evaluateEligibility, type EligibilityInput } from './eligibility'
import { resolveAddons, resolveOptions, unitPriceFor } from './pricing'
import type { CatalogueItem, StoreItemPropertyOverride } from './types'

/** One line of the basket, as the browser holds it. */
export type CartLine = {
  itemId: string
  quantity: number
  optionValueIds: readonly string[]
  addons: readonly { addonId: string; quantity: number }[]
  answers: Readonly<Record<string, string | number>>
  /** What the guest was shown, per unit, when they added it. */
  seenUnitPriceAgorot: Agorot
  /** What the guest was shown as the line total when they added it. */
  seenLineTotalAgorot: Agorot
}

export type Cart = {
  lines: readonly CartLine[]
  /** ISO instant. Used against `cartTtlHours` to expire a stale basket. */
  updatedAt: string
}

export const EMPTY_CART: Cart = { lines: [], updatedAt: '' }

/* ---------------------------------------------------------------- changes -- */

export type CartChangeKind =
  | 'price_increased'
  | 'price_decreased'
  | 'item_unavailable'
  | 'item_removed'
  | 'option_removed'
  | 'quantity_reduced'

/**
 * One thing the guest has to be told before they submit.
 *
 * `message` is a whole Hebrew sentence rather than a code the screen
 * interpolates, because the sentence differs by more than a noun: a price that
 * went down is good news and a product that vanished is an apology.
 */
export type CartChange = {
  kind: CartChangeKind
  itemId: string
  itemName: string
  message: string
  /** For the price changes. Signed, in agorot, per unit. */
  deltaAgorot?: Agorot
}

export type RevalidatedLine = CartLine & {
  item: CatalogueItem
  /** The price as it stands NOW. This is what the order will be written with. */
  unitPriceAgorot: Agorot
  lineTotalAgorot: Agorot
}

export type CartRevalidation = {
  /** The lines that survived, priced as they stand now. */
  lines: readonly RevalidatedLine[]
  /** What to tell the guest. Empty means the basket is exactly as they left it. */
  changes: readonly CartChange[]
  subtotalAgorot: Agorot
  /** True when the guest must confirm again before this may be submitted. */
  requiresReconfirmation: boolean
}

/**
 * Compare the basket against the catalogue as it stands, right now.
 *
 * The eligibility check is the same one the store listing used — passed in as
 * a partially-applied context rather than reimplemented — so a product that is
 * eligible on the listing and ineligible at checkout can only be a genuine
 * change in the world between the two, never a disagreement between two copies
 * of the rules.
 */
export function revalidateCart(input: {
  cart: Cart
  /** The catalogue, as it stands now. Items absent from here are gone. */
  items: readonly CatalogueItem[]
  overrides: Readonly<Record<string, StoreItemPropertyOverride>>
  /** Builds the eligibility question for one item. */
  eligibilityFor: (item: CatalogueItem) => EligibilityInput
}): CartRevalidation {
  const lines: RevalidatedLine[] = []
  const changes: CartChange[] = []

  for (const line of input.cart.lines) {
    const item = input.items.find((candidate) => candidate.id === line.itemId)

    // Gone from the catalogue entirely — archived, deleted, or moved out of
    // this property's offering.
    if (!item) {
      changes.push({
        kind: 'item_removed',
        itemId: line.itemId,
        itemName: 'פריט שהוסר',
        message: 'אחד הפריטים בעגלה כבר אינו מוצע, והוא הוסר מההזמנה.',
      })
      continue
    }

    const verdict = evaluateEligibility(input.eligibilityFor(item))
    if (!verdict.eligible) {
      changes.push({
        kind: 'item_unavailable',
        itemId: item.id,
        itemName: item.name,
        message: `${item.name}: ${verdict.message ?? 'אינו זמין כרגע'}. הפריט הוסר מההזמנה.`,
      })
      continue
    }

    // Capacity may have narrowed since the basket was filled.
    let quantity = line.quantity
    if (verdict.remaining !== null && quantity > verdict.remaining) {
      if (verdict.remaining <= 0) {
        changes.push({
          kind: 'item_unavailable',
          itemId: item.id,
          itemName: item.name,
          message: `${item.name}: כל המקומות נתפסו בינתיים. הפריט הוסר מההזמנה.`,
        })
        continue
      }
      changes.push({
        kind: 'quantity_reduced',
        itemId: item.id,
        itemName: item.name,
        message: `${item.name}: נותרו ${verdict.remaining} בלבד, והכמות עודכנה בהתאם.`,
      })
      quantity = verdict.remaining
    }

    const override = input.overrides[item.id] ?? null
    const price = unitPriceFor(item, override)

    // A product that became quote-priced while it sat in a basket has no
    // number any more, and inventing one would sell it for whatever was
    // remembered.
    if (price === null) {
      changes.push({
        kind: 'item_unavailable',
        itemId: item.id,
        itemName: item.name,
        message: `${item.name}: המחיר נקבע כעת לפי הצעה. פנה אלינו ונשמח לתמחר.`,
      })
      continue
    }

    if (price !== line.seenUnitPriceAgorot) {
      changes.push({
        kind:
          price > line.seenUnitPriceAgorot
            ? 'price_increased'
            : 'price_decreased',
        itemId: item.id,
        itemName: item.name,
        deltaAgorot: price - line.seenUnitPriceAgorot,
        message:
          price > line.seenUnitPriceAgorot
            ? `${item.name}: המחיר עודכן מאז שהוספת לעגלה. המחיר המעודכן מוצג כעת, ולא נחייב אותך יותר בלי שתאשר.`
            : `${item.name}: המחיר ירד מאז שהוספת לעגלה, והסכום המעודכן מוצג כעת.`,
      })
    }

    // Options that no longer exist are dropped by `resolveOptions`, and the
    // difference between what was asked for and what resolved is exactly what
    // the guest has to be told about.
    const chosen = line.optionValueIds.map((valueId) => ({
      optionId:
        item.options.find((option) =>
          option.values.some((value) => value.id === valueId),
        )?.id ?? '',
      optionValueId: valueId,
    }))
    const resolvedOptions = resolveOptions(item.options, chosen)

    if (resolvedOptions.length < line.optionValueIds.length) {
      changes.push({
        kind: 'option_removed',
        itemId: item.id,
        itemName: item.name,
        message: `${item.name}: אחת האפשרויות שבחרת כבר אינה זמינה. בחר שוב לפני שליחת ההזמנה.`,
      })
    }

    const optionsAgorot = resolvedOptions.reduce(
      (sum, option) => sum + option.priceDeltaAgorot,
      0,
    )
    const resolvedAddons = resolveAddons(item.addons, line.addons)
    const addonsAgorot = resolvedAddons.reduce(
      (sum, addon) => sum + addon.totalAgorot,
      0,
    )

    lines.push({
      ...line,
      quantity,
      item,
      unitPriceAgorot: price,
      lineTotalAgorot: (price + optionsAgorot + addonsAgorot) * quantity,
    })
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalAgorot, 0)

  return {
    lines,
    changes,
    subtotalAgorot: subtotal,
    // A price that went DOWN still requires reconfirmation. It is a smaller
    // number than the one on the screen the guest is looking at, and a total
    // that changes under somebody's hand — in either direction — is a total
    // they did not agree to.
    requiresReconfirmation: changes.length > 0,
  }
}

/**
 * Has this basket gone stale?
 *
 * A cart older than the organization's `cartTtlHours` is not silently
 * submitted: prices, availability and the stay itself have had time to move,
 * and the guest is asked to look at it again.
 */
export function isCartExpired(
  cart: Cart,
  cartTtlHours: number,
  now: Date,
): boolean {
  if (!cart.updatedAt) return false
  const at = Date.parse(cart.updatedAt)
  if (Number.isNaN(at)) return false
  return now.getTime() - at > cartTtlHours * 3_600_000
}

/** How many things are in the basket. For the badge on the cart button. */
export function cartCount(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0)
}
