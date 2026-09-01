/**
 * How much of a shop this business is running, and what it is therefore
 * allowed to be shown.
 *
 * ── The rule, stated once ─────────────────────────────────────────────────
 *
 * A BUSINESS ON `simple` MUST NEVER MEET SUPPLIER OR MARGIN VOCABULARY.
 *
 * Not "the screen hides those fields" — that is a promise a screen makes and
 * a future screen forgets. The mode decides what the product *is*, in one
 * place, and every screen asks this module rather than deciding for itself.
 * The database backs it up: `tg_store_items_mode_vocabulary` in 0032 refuses
 * to store a cost or a supplier reference outside `advanced`, so even a screen
 * that forgot cannot create the row.
 *
 * ── `off` is a real answer and it is the default ──────────────────────────
 *
 * `off` means the store does not appear at all — no menu item, no section in
 * the guest portal, no order list — and bookings carry on exactly as they did
 * before this module existed. A great many single-villa businesses will never
 * turn it on, and the product must not treat that as an unfinished
 * configuration to nag about.
 *
 * ── Live payment is a capability, not a requirement ───────────────────────
 *
 * `commerce` is the mode that *permits* live payment. It does not compel it:
 * an organization on `commerce` whose default mode is `with_booking` never
 * meets a payment provider either. What `simple` cannot do is reach `pay_now`
 * at all, and `store_settings_no_live_payment_in_simple` is the constraint.
 */

import type { StoreMode, StorePaymentMode } from '../contracts/states'

/**
 * What a mode makes available.
 *
 * Read as data rather than as a chain of `if (mode === 'advanced')`, because
 * the chain is what drifts: one screen checks `!== 'simple'` and another
 * checks `=== 'advanced'`, and they disagree about `commerce` forever after.
 */
export type StoreCapabilities = {
  /** Does the store appear anywhere at all? */
  visible: boolean
  /** A catalogue the owner maintains. */
  catalogue: boolean
  /** Orders, approvals and fulfilment. */
  orders: boolean
  /** A guest-facing store inside the booking portal. */
  guestStore: boolean
  /** `pay_now` may be offered. Never required — see the header. */
  livePayment: boolean
  /** Stock counting and reservation against the inventory module. */
  stock: boolean
  /** Suppliers, cost prices and margin. */
  supplierAndMargin: boolean
  /** Operational recipes that create tasks with checklists. */
  recipes: boolean
  /** External providers and the request that goes to them. */
  externalProviders: boolean
}

const CAPABILITIES: Readonly<Record<StoreMode, StoreCapabilities>> = {
  off: {
    visible: false,
    catalogue: false,
    orders: false,
    guestStore: false,
    livePayment: false,
    stock: false,
    supplierAndMargin: false,
    recipes: false,
    externalProviders: false,
  },
  // A catalogue and orders handled by hand. NO PAYMENT PROVIDER ANYWHERE.
  // Providers are on, because "ring the DJ" is a telephone call and needs no
  // commerce whatsoever — a villa owner selling a שולחן שוק still has a
  // supplier of tables, and the request that goes to them is a WhatsApp
  // message rather than a purchase order.
  simple: {
    visible: true,
    catalogue: true,
    orders: true,
    guestStore: true,
    livePayment: false,
    stock: false,
    supplierAndMargin: false,
    recipes: false,
    externalProviders: true,
  },
  commerce: {
    visible: true,
    catalogue: true,
    orders: true,
    guestStore: true,
    livePayment: true,
    stock: false,
    supplierAndMargin: false,
    recipes: true,
    externalProviders: true,
  },
  advanced: {
    visible: true,
    catalogue: true,
    orders: true,
    guestStore: true,
    livePayment: true,
    stock: true,
    supplierAndMargin: true,
    recipes: true,
    externalProviders: true,
  },
}

export function storeCapabilities(mode: StoreMode): StoreCapabilities {
  return CAPABILITIES[mode]
}

/**
 * The payment modes this business may actually offer.
 *
 * The intersection of what it enabled and what its mode permits, with the
 * default always included — a business whose enabled list is empty has not
 * refused every mode, it has simply never opened that screen, and offering it
 * nothing would make checkout impossible.
 */
export function offerablePaymentModes(input: {
  mode: StoreMode
  defaultPaymentMode: StorePaymentMode
  enabled: readonly StorePaymentMode[]
}): readonly StorePaymentMode[] {
  const capabilities = storeCapabilities(input.mode)

  const candidates =
    input.enabled.length > 0
      ? [input.defaultPaymentMode, ...input.enabled]
      : [input.defaultPaymentMode]

  const unique = [...new Set(candidates)]

  return unique.filter((mode) => mode !== 'pay_now' || capabilities.livePayment)
}

/**
 * Is this word one the business has agreed to be shown?
 *
 * Used by the settings and product screens to decide whether a field exists,
 * so that "cost" and "supplier" are absent rather than disabled. A disabled
 * field still teaches a vocabulary, and §5 is that a business on `simple`
 * never learns it.
 */
export function showsVocabulary(
  mode: StoreMode,
  word: 'cost' | 'supplier' | 'margin' | 'stock' | 'recipe' | 'provider',
): boolean {
  const capabilities = storeCapabilities(mode)
  switch (word) {
    case 'cost':
    case 'supplier':
    case 'margin':
      return capabilities.supplierAndMargin
    case 'stock':
      return capabilities.stock
    case 'recipe':
      return capabilities.recipes
    case 'provider':
      return capabilities.externalProviders
  }
}

/** The Hebrew a business reads about its own mode. */
export const STORE_MODE_LABEL: Readonly<Record<StoreMode, string>> = {
  off: 'כבויה',
  simple: 'פשוטה',
  commerce: 'עם תשלום',
  advanced: 'מתקדמת',
}

export const STORE_MODE_SUMMARY: Readonly<Record<StoreMode, string>> = {
  off: 'החנות אינה מופיעה בשום מקום, וההזמנות ממשיכות בדיוק כמו קודם.',
  simple:
    'קטלוג והזמנות שאתה מטפל בהם בעצמך. בלי ספק תשלומים, בלי מלאי ובלי רווחיות.',
  commerce: 'הכול מהחנות הפשוטה, ובנוסף אפשרות לתשלום מקוון ומתכוני תפעול.',
  advanced: 'הכול, ובנוסף מלאי, ספקים ורווחיות לכל מוצר.',
}
