/**
 * What this organization actually runs — stated, never inferred.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * A detector that says "הזמינו 6 מגבות מהמלאי" to a business with no stock
 * module has done something worse than being unhelpful. It has told that
 * customer the product is for somebody else — the exact reaction
 * `laundry/mode.ts` and `inventory/settings.ts` were both written to prevent —
 * and it has done it in an alert, which is the one place a person cannot
 * choose not to look.
 *
 * So the enabled modules are an INPUT to every detector, and there is no
 * default. A caller that has not asked the organization what it runs cannot
 * construct this record, which is the point: the type system asks the question
 * that a `?? true` would have silently answered wrong.
 *
 * ── Why two of these are not booleans ─────────────────────────────────────
 *
 * `laundry` and `inventory` carry their real configuration rather than a flag,
 * because "on" is not one thing for either of them:
 *
 *   · A `simple` laundry operation is one person and a machine. It has no
 *     provider, no order and no van, and `FORBIDDEN_IN_SIMPLE` lists the words
 *     that would imply otherwise. A boolean would have thrown that away and
 *     the first signal about a late collection would have invented a van.
 *   · `basic` inventory counts things and cannot project or reserve. A signal
 *     saying "יוקצו 6 מגבות" to a business that cannot reserve is a promise
 *     the product will not keep.
 *
 * `InventoryCapabilities` is consumed rather than `InventoryMode` because
 * `inventory/settings.ts` says in as many words: read the capabilities, never
 * the mode. Two callers deriving "can it reserve" from a mode is two answers.
 */

import type { InventoryCapabilities } from '../../inventory/types'
import type { LaundryMode } from '../../contracts/states'
import { vocabularyFor, type LaundryVocabulary } from '../../laundry/mode'

/**
 * The modules a signal can be about.
 *
 * Not the same list as `Entitlement`, and deliberately so. An entitlement is
 * what the customer bought; this is what they switched on. A business can hold
 * the `operations` entitlement and run no laundry at all, and a signal that
 * consulted the invoice rather than the settings would be wrong for them.
 */
export const SIGNAL_MODULES = [
  'guest_portal',
  'contracts',
  'payments',
  'preparation',
  'cleaning',
  'inspection',
  'laundry',
  'inventory',
  'maintenance',
  'access',
] as const

export type SignalModule = (typeof SIGNAL_MODULES)[number]

export interface EnabledModules {
  /** The guest's own screens: confirmation, details, arrival information. */
  guest_portal: boolean
  contracts: boolean
  payments: boolean
  preparation: boolean
  cleaning: boolean
  /** Whether a unit must be inspected before it counts as ready. */
  inspection: boolean
  maintenance: boolean
  /** Codes, locks, and the release of the arrival instructions. */
  access: boolean
  /** `off` means there is no laundry module. See `laundry/mode.ts`. */
  laundry: LaundryMode
  /** From `capabilitiesFor(settings)`, never from the mode. */
  inventory: InventoryCapabilities
}

export function isModuleEnabled(
  modules: EnabledModules,
  module: SignalModule,
): boolean {
  switch (module) {
    case 'laundry':
      return modules.laundry !== 'off'
    case 'inventory':
      return modules.inventory.enabled
    default:
      return modules[module]
  }
}

/**
 * May a signal about this module use the language of stock reservation?
 *
 * The distinction the brief draws in one line: with inventory off you may say
 * "ההכנה דורשת 6 מגבות נוספות" and you may not say "הזמינו 6 מגבות מהמלאי".
 * With `basic` inventory the same holds — the business counts towels, it does
 * not promise them to a date.
 */
export function canReserveStock(modules: EnabledModules): boolean {
  return modules.inventory.reservations
}

/** May a signal talk about a forward projection at all. */
export function canProjectStock(modules: EnabledModules): boolean {
  return modules.inventory.forecast
}

/**
 * The words this organization's laundry is allowed to be described with.
 *
 * Delegated rather than restated. `laundry/mode.ts` owns the vocabulary and
 * proves in its own suite that `simple` contains none of the forbidden words;
 * a second table here would be a second answer that drifts.
 */
export function laundryWords(modules: EnabledModules): LaundryVocabulary {
  return vocabularyFor(modules.laundry)
}

/** Is there an outside party to chase, or is this one person and a machine. */
export function laundryHasProvider(modules: EnabledModules): boolean {
  return modules.laundry === 'external' || modules.laundry === 'hybrid'
}

export const MODULE_LABEL: Readonly<Record<SignalModule, string>> = {
  guest_portal: 'אזור האורח',
  contracts: 'חוזים',
  payments: 'תשלומים',
  preparation: 'הכנה לאירוח',
  cleaning: 'ניקיון',
  inspection: 'בדיקת מוכנות',
  laundry: 'כביסה',
  inventory: 'מלאי',
  maintenance: 'תחזוקה',
  access: 'כניסה לנכס',
}

/**
 * Every module off, and inventory reporting no capability at all.
 *
 * For tests and for the honest starting point of a business that has just
 * signed up. Exported rather than rebuilt in nine test files, because a
 * fixture copied nine times is nine fixtures that drift.
 */
/**
 * Everything on, at the deepest configuration each module offers.
 *
 * The other end of `NO_MODULES`, and the fixture a test reaches for when the
 * point it is making is not about modules at all. Named as a maximum rather
 * than as a default, because there is no default: a real organization is
 * always somewhere between these two, and a caller that used this as one would
 * be assuming exactly what `EnabledModules` exists to stop it assuming.
 */
export const ALL_MODULES: EnabledModules = {
  guest_portal: true,
  contracts: true,
  payments: true,
  preparation: true,
  cleaning: true,
  inspection: true,
  maintenance: true,
  access: true,
  laundry: 'external',
  inventory: {
    enabled: true,
    counting: true,
    reservations: true,
    circulation: true,
    forecast: true,
    transfers: true,
    discrepancies: true,
    procurement: true,
    warehouse: true,
    sharedStock: true,
  },
}

export const NO_MODULES: EnabledModules = {
  guest_portal: false,
  contracts: false,
  payments: false,
  preparation: false,
  cleaning: false,
  inspection: false,
  maintenance: false,
  access: false,
  laundry: 'off',
  inventory: {
    enabled: false,
    counting: false,
    reservations: false,
    circulation: false,
    forecast: false,
    transfers: false,
    discrepancies: false,
    procurement: false,
    warehouse: false,
    sharedStock: false,
  },
}
