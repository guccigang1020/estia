/**
 * What the stock module is allowed to do for one organization.
 *
 * ── `off` is a first-class answer, and this file is where that is true ────
 *
 * The default is `off` and the default is correct. A single villa owner takes
 * bookings, prepares the property, sends the linen out and gets paid without
 * counting a single towel, and the product must not treat that as an
 * unfinished configuration. What `off` turns off is *stock validation and
 * forecasting* — nothing else. Preparation still calculates, the cleaner's
 * plan still lists what to do, the laundry requirement is still a number, the
 * booking is still taken and the invoice is still issued.
 *
 * That is the rule most likely to be broken by accident, because breaking it
 * looks like defensive coding: one `if (stock < required) throw` on a shared
 * path and a business that never opened this module can no longer confirm a
 * booking. `settings.test.ts` asserts the whole of the above rather than
 * trusting the sentence.
 *
 * ── The mode sets what is available; the flags set what is on ─────────────
 *
 * They are not redundant. `advanced` makes discrepancy tracking *possible*;
 * an operation whose cleaners do not count linen back in still turns it off.
 * So a capability is the AND of the two, computed here and nowhere else — a
 * screen that read `mode === 'advanced'` and offered a transfer the action
 * then refused is the drift this function exists to prevent.
 */

import { INVENTORY_MODES, type InventoryMode } from '../contracts/states'
import type { InventoryCapabilities, InventorySettings } from './types'

/**
 * What an organization with no settings row gets.
 *
 * A missing row is `off`, and the migration says so: the application reads the
 * absence rather than requiring a row to exist. Inventing `basic` here so that
 * the screens had something to show would switch a module on for every
 * business that never asked for one.
 */
export function defaultInventorySettings(
  organizationId: string,
): InventorySettings {
  return {
    organizationId,
    mode: 'off',
    safetyBufferUnits: 0,
    safetyBufferPercent: 0,
    shortageWarningHorizonDays: 7,
    forecastHorizonDays: 30,
    linenTurnaroundDays: null,
    sharedStock: false,
    reservationsEnabled: false,
    warehouseEnabled: false,
    discrepancyTracking: false,
    transfersEnabled: false,
  }
}

/**
 * The settings a business gets when it first switches the module on.
 *
 * Two days of turnaround is the one guess in this file, and it is only ever
 * offered as a form default a person can see and change — never written by
 * anything that runs without being asked. A stored `null` stays `null`.
 */
export function startingSettingsFor(
  organizationId: string,
  mode: Exclude<InventoryMode, 'off'>,
): InventorySettings {
  const base = defaultInventorySettings(organizationId)
  return {
    ...base,
    mode,
    reservationsEnabled: mode === 'tracked' || mode === 'advanced',
    linenTurnaroundDays: mode === 'basic' ? null : 2,
    discrepancyTracking: mode === 'advanced',
    transfersEnabled: mode === 'advanced',
  }
}

/** Where each capability first becomes possible. */
const MODE_RANK: Readonly<Record<InventoryMode, number>> = {
  off: 0,
  basic: 1,
  tracked: 2,
  advanced: 3,
}

function atLeast(mode: InventoryMode, floor: InventoryMode): boolean {
  return MODE_RANK[mode] >= MODE_RANK[floor]
}

/**
 * The one place `mode` and the flags are combined.
 *
 * Read this, never `settings.mode`, from a screen or an action. The two
 * questions "could this business do it" and "has this business asked for it"
 * have one answer here and would have several if each caller composed them.
 */
export function capabilitiesFor(
  settings: InventorySettings,
): InventoryCapabilities {
  const enabled = settings.mode !== 'off'

  if (!enabled) {
    return {
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
    }
  }

  const reservations =
    atLeast(settings.mode, 'tracked') && settings.reservationsEnabled

  return {
    enabled: true,
    counting: true,
    reservations,
    // Circulation is the clean/dirty/laundry loop. It needs a turnaround to
    // be a loop at all: without one, "it comes back" has no date and the
    // forecast would have to invent one.
    circulation:
      atLeast(settings.mode, 'tracked') &&
      settings.linenTurnaroundDays !== null,
    // The forecast is the point of `tracked`. It runs on reservations, and
    // without them there is no future demand to walk — a timeline over no
    // claims is a flat line dressed up as an answer.
    forecast: reservations,
    transfers: atLeast(settings.mode, 'advanced') && settings.transfersEnabled,
    discrepancies:
      atLeast(settings.mode, 'advanced') && settings.discrepancyTracking,
    procurement: atLeast(settings.mode, 'tracked'),
    warehouse: settings.warehouseEnabled,
    sharedStock: settings.sharedStock,
  }
}

/**
 * The floor one item keeps, in whole units.
 *
 * The larger of the absolute and the percentage, because both are things a
 * real operator says — "always keep ten spare sheets" and "always keep twenty
 * percent" — and taking the smaller would silently discard whichever they
 * meant. The percentage is of the par level and not of the quantity on hand:
 * a floor that shrinks as stock runs down is not a floor.
 *
 * An item with no par level gets the absolute alone. Guessing a par from the
 * current count would set the floor to whatever happens to be in the cupboard
 * on the day somebody first opened the screen.
 */
export function safetyBufferFor(
  settings: InventorySettings,
  item: { parLevel: number | null; minQuantity: number | null },
): number {
  if (settings.mode === 'off') return 0

  const fromPercent =
    item.parLevel === null
      ? 0
      : Math.ceil((item.parLevel * settings.safetyBufferPercent) / 100)

  // `min_quantity` is the reorder point the business already set per item, and
  // it is a floor by any other name. Honouring it here means an organization
  // that never opened the settings screen still gets the behaviour it
  // configured item by item in 0011.
  return Math.max(
    settings.safetyBufferUnits,
    fromPercent,
    item.minQuantity ?? 0,
  )
}

/** Hebrew names for the four modes, total over the frozen tuple. */
export const INVENTORY_MODE_LABEL: Readonly<Record<InventoryMode, string>> = {
  off: 'כבוי',
  basic: 'ספירה בלבד',
  tracked: 'מעקב ותחזית',
  advanced: 'מתקדם',
}

export const INVENTORY_MODE_SUMMARY: Readonly<Record<InventoryMode, string>> = {
  off: 'הכנה, תוכנית הניקיון, חישוב הכביסה, ההזמנות והכספים עובדים במלואם. מה שכבוי הוא בדיקת המלאי והתחזית בלבד.',
  basic: 'ספירת פריטים, נקודת הזמנה והתראה כשנגמר. בלי שריון ובלי תחזית.',
  tracked:
    'שריון מלאי להזמנות עתידיות, מחזור נקי־מלוכלך־כביסה ותחזית יומית שרואה מחסור לפני שהוא קורה.',
  advanced: 'הכול, ובנוסף העברות בין נכסים, יישוב פערי ספירה והצעות רכש.',
}

/** The modes, in order, for a settings form. */
export const INVENTORY_MODE_OPTIONS: readonly InventoryMode[] = INVENTORY_MODES
