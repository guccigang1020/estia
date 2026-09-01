/**
 * THE ONE PLACE IN THIS MODULE WHERE BUSINESS NUMBERS BELONG.
 *
 * Every other file in `src/lib/laundry` is scanned by
 * `no-hardcoded-numbers.test.ts` and may hold no numeric literal that is not
 * structural. This file is excluded, and a separate assertion in that test
 * proves no shipped module imports it — because a fixture that leaked into the
 * product would be a hardcoded configuration wearing a test's clothes.
 *
 * ── The worked example ────────────────────────────────────────────────────
 *
 * Two properties in one organization. A party of twenty-five arrives at the
 * Galilee house on Friday; a party of twelve at the Carmel house the same day.
 *
 * The preparation engine — NOT this module — decided what they need:
 *
 *     bath towels    25 base, 25 after preparation's buffer
 *     linen sets     25 base, 28 after preparation's buffer
 *     hand towels    13 base (one per couple, rounded up)
 *     mattresses     15 (not laundry, and has no profile at all)
 *     toilet paper    2 packs (has a profile, laundry_managed false)
 *
 * This module then does the only two things it is allowed to do:
 *
 *     bath towels    25 + 3 laundry buffer            = 28
 *     linen sets     28 + 2 laundry buffer = 30, in bundles of 5 = 30
 *     hand towels    13 + 0                           = 13
 *     mattresses     skipped, no profile
 *     toilet paper   skipped, not laundry managed
 *
 * Every figure above is an OUTPUT. If any of them appeared as a literal in a
 * shipped file, the next customer — with four beds, or a different buffer —
 * would get the wrong order and nobody would find out until a provider
 * delivered the wrong count.
 */

import type { Requirement } from '../../preparation/types'
import type {
  LaundryItemProfile,
  LaundryProvider,
  LaundrySettings,
} from '../types'

export const ORGANIZATION = 'org-example'
export const GALILEE = 'property-galilee'
export const CARMEL = 'property-carmel'
export const PROVIDER = 'provider-north'

/** Friday afternoon, when the guests arrive and the beds must be made. */
export const REQUIRED_BY = '2026-09-04T13:00:00.000Z'

/** Thursday morning, when the van comes. */
export const PICKUP_AT = '2026-09-03T06:00:00.000Z'

// ── Configuration ─────────────────────────────────────────────────────────

export const SETTINGS: LaundrySettings = {
  organizationId: ORGANIZATION,
  propertyId: null,
  mode: 'external',
  dispatchMode: 'approval_required',
  defaultChannel: 'whatsapp',
  defaultProviderId: PROVIDER,
  turnaroundHours: 24,
  // Sunday, Wednesday. ISO weekday numbers.
  pickupDays: [3, 7],
  deliveryDays: [4, 1],
  forecastHorizonDays: 7,
  standingNotes: 'הכניסה מהחניה האחורית.',
}

export const PROVIDER_ROW: LaundryProvider = {
  id: PROVIDER,
  organizationId: ORGANIZATION,
  name: 'מכבסת הצפון',
  contactName: 'רונית',
  phone: '050-0000000',
  email: null,
  defaultChannel: 'whatsapp',
  turnaroundHours: 24,
  pickupDays: [3, 7],
  deliveryDays: [4, 1],
  minimumOrderUnits: 20,
  notes: null,
  isActive: true,
}

/**
 * The item profiles, which are the whole point.
 *
 * Note what is here and what is not. Bath towels, hand towels and linen sets
 * are laundry. Toilet paper has a profile and is not. Mattresses have no
 * profile at all, which is the ordinary case for most of a preparation plan.
 */
export const PROFILES: readonly LaundryItemProfile[] = [
  {
    organizationId: ORGANIZATION,
    itemId: 'towel_bath',
    label: 'מגבות רחצה',
    laundryManaged: true,
    washable: true,
    externalLaundryAllowed: true,
    route: 'external',
    defaultProviderId: PROVIDER,
    turnaroundHours: null,
    unit: 'piece',
    bundleSize: 1,
    minimumBuffer: 3,
  },
  {
    organizationId: ORGANIZATION,
    itemId: 'towel_hand',
    label: 'מגבות ידיים',
    laundryManaged: true,
    washable: true,
    externalLaundryAllowed: true,
    route: 'external',
    defaultProviderId: PROVIDER,
    turnaroundHours: null,
    unit: 'piece',
    bundleSize: 1,
    minimumBuffer: 0,
  },
  {
    organizationId: ORGANIZATION,
    itemId: 'linen_set',
    label: 'מערכות מצעים',
    laundryManaged: true,
    washable: true,
    externalLaundryAllowed: true,
    route: 'external',
    defaultProviderId: PROVIDER,
    // A duvet cover takes longer than a hand towel, and the provider knows it.
    turnaroundHours: 48,
    unit: 'set',
    bundleSize: 5,
    minimumBuffer: 2,
  },
  {
    organizationId: ORGANIZATION,
    itemId: 'toilet_paper',
    label: 'נייר טואלט',
    laundryManaged: false,
    washable: false,
    externalLaundryAllowed: false,
    route: null,
    defaultProviderId: null,
    turnaroundHours: null,
    unit: 'pack',
    bundleSize: 1,
    minimumBuffer: 0,
  },
]

// ── Canonical preparation requirements ────────────────────────────────────

function requirement(
  itemId: string,
  label: string,
  base: number,
  buffered: number,
  unit: Requirement['unit'],
  category: Requirement['category'],
): Requirement {
  return {
    category,
    itemId,
    label,
    unit,
    quantity: buffered,
    section: 'towels',
    requiresPhoto: false,
    instructions: null,
    minutes: 0,
    sources: [
      {
        ruleId: `rule-${itemId}`,
        origin: 'rule',
        section: 'towels',
        base,
        buffered,
        minutes: 0,
      },
    ],
  }
}

/** What preparation computed for the party of twenty-five at the Galilee. */
export const GALILEE_REQUIREMENTS: readonly Requirement[] = [
  requirement('towel_bath', 'מגבות רחצה', 25, 25, 'piece', 'towels'),
  requirement('towel_hand', 'מגבות ידיים', 13, 13, 'piece', 'towels'),
  requirement('linen_set', 'מערכות מצעים', 25, 28, 'set', 'linen'),
  requirement('mattress', 'מזרנים', 15, 15, 'piece', 'sleeping'),
  requirement('toilet_paper', 'נייר טואלט', 2, 2, 'pack', 'consumables'),
]

/** And for the party of twelve at the Carmel, the same Friday. */
export const CARMEL_REQUIREMENTS: readonly Requirement[] = [
  requirement('towel_bath', 'מגבות רחצה', 12, 12, 'piece', 'towels'),
  requirement('linen_set', 'מערכות מצעים', 12, 12, 'set', 'linen'),
]

/**
 * A booking carrying everything a laundry provider must never see.
 *
 * Used by `message.test.ts`, which drives the whole path from here to a
 * rendered message and asserts that not one of these strings survives. The
 * values are deliberately distinctive — a real name and a real-looking
 * telephone number — because an assertion against "0" would pass by accident.
 */
export const SENSITIVE_BOOKING = {
  id: 'booking-sensitive',
  guestName: 'מרים בן־חיים',
  guestPhone: '052-7654321',
  guestEmail: 'miriam@example.com',
  totalAgorot: 950000,
  paymentStatus: 'partially_paid',
  agentName: 'סוכנות הצפון',
  agentId: 'agent-north',
} as const
