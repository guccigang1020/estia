/**
 * What the business actually sells: two properties, six units, and the teams
 * and amenities attached to them.
 *
 * The two properties are deliberately different in kind. אחוזת רימונים is a
 * four-unit zimmer complex in ראש פינה; וילה כחול ים is a single villa in
 * זכרון יעקב with a guest studio beside it. One property would make the
 * property switcher, the scoped `property_manager` persona and the `properties`
 * plan limit all unobservable — three separate mechanisms that only show
 * themselves when there is more than one thing to choose between.
 *
 * Prices are agorot, and they are the unit's own: `listBookableUnits` reads
 * them to quote a stay, so a base rate invented in a form would be a number
 * nobody could reconcile. ₪1,150 a night for a Galilee suite in season is a
 * real price, and the cleaning fees and deposits are sized against it.
 */

import type { DemoRow } from './types'
import { ID_GROUP, idsFor, stamped } from './dataset-support'
import { ORGANIZATION_ID, OWNER_ID, person } from './dataset-identity'

const propertyIds = idsFor(ID_GROUP.property)
const unitGroupIds = idsFor(ID_GROUP.unitGroup)
const unitIds = idsFor(ID_GROUP.unit)
const teamIds = idsFor(ID_GROUP.team)
const amenityIds = idsFor(ID_GROUP.amenity)

/* ------------------------------------------------------------- teams ----- */

export const TEAM_IDS = {
  housekeeping: teamIds(1),
  frontDesk: teamIds(2),
  maintenance: teamIds(3),
} as const

/* -------------------------------------------------------- properties ----- */

export const PROPERTY_IDS = {
  rimonim: propertyIds(1),
  kacholYam: propertyIds(2),
} as const

export const PROPERTY_ROWS: DemoRow[] = [
  {
    id: PROPERTY_IDS.rimonim,
    organization_id: ORGANIZATION_ID,
    slug: 'ahuzat-rimonim',
    name: 'אחוזת רימונים',
    legal_name: 'אחוזת הגליל אירוח בע״מ',
    description:
      'ארבע יחידות אירוח בשולי ראש פינה, בין מטע רימונים ותיק לבין הנוף אל הכנרת. בריכה מחוממת משותפת ופינת מדורה.',
    property_type: 'zimmer',
    status: 'active',
    address_line1: 'דרך הרימונים 14',
    address_line2: null,
    city: 'ראש פינה',
    region: 'הגליל העליון',
    postal_code: '1200000',
    country: 'IL',
    latitude: '32.968400',
    longitude: '35.542100',
    timezone: 'Asia/Jerusalem',
    currency: 'ILS',
    default_check_in_time: '15:00:00',
    default_check_out_time: '11:00:00',
    min_nights: 1,
    policies: { quiet_hours: '23:00-07:00', pets: 'on_request' },
    house_rules:
      'אין לעשן בתוך היחידות. שעות שקט מ-23:00. הבריכה סגורה בין 22:00 ל-08:00.',
    cancellation_policy: { free_until_days: 14, partial_until_days: 7 },
    cancellation_policy_text:
      'ביטול עד 14 יום לפני ההגעה — החזר מלא. עד 7 ימים — 50%. לאחר מכן אין החזר.',
    tax_id: '515882471',
    tax_rate_bps: 1700,
    tax_included_in_price: true,
    tourist_vat_exempt: false,
    contact_name: 'אבי כהן',
    contact_phone: '+972 52-916-4402',
    contact_email: 'rimonim@ahuzat-hagalil.co.il',
    cover_image_url: null,
    sort_order: 1,
    metadata: {},
    ...stamped(OWNER_ID, -410),
  },
  {
    id: PROPERTY_IDS.kacholYam,
    organization_id: ORGANIZATION_ID,
    slug: 'vila-kachol-yam',
    name: 'וילה כחול ים',
    legal_name: 'אחוזת הגליל אירוח בע״מ',
    description:
      'וילה פרטית עם בריכה מוצנעת ברמת הנדיב, ולצידה יחידת אורחים נפרדת. מושכרת בשלמותה למשפחות ולאירועים קטנים.',
    property_type: 'villa',
    status: 'active',
    address_line1: 'הכרמים 3',
    address_line2: null,
    city: 'זכרון יעקב',
    region: 'חוף הכרמל',
    postal_code: '3095000',
    country: 'IL',
    latitude: '32.573900',
    longitude: '34.951700',
    timezone: 'Asia/Jerusalem',
    currency: 'ILS',
    default_check_in_time: '16:00:00',
    default_check_out_time: '10:00:00',
    min_nights: 2,
    policies: { quiet_hours: '22:30-08:00', events: 'up_to_30_guests' },
    house_rules:
      'אירוע עד 30 איש באישור מראש בלבד. אין מוזיקה בחצר אחרי 22:30.',
    cancellation_policy: { free_until_days: 21, partial_until_days: 10 },
    cancellation_policy_text:
      'ביטול עד 21 יום לפני ההגעה — החזר מלא. עד 10 ימים — 50%. לאחר מכן אין החזר.',
    tax_id: '515882471',
    tax_rate_bps: 1700,
    tax_included_in_price: true,
    tourist_vat_exempt: false,
    contact_name: 'מיכל בר-ששת',
    contact_phone: '+972 50-338-2274',
    contact_email: 'kacholyam@ahuzat-hagalil.co.il',
    cover_image_url: null,
    sort_order: 2,
    metadata: {},
    ...stamped(OWNER_ID, -280),
  },
]

export const TEAM_ROWS: DemoRow[] = [
  {
    id: TEAM_IDS.housekeeping,
    organization_id: ORGANIZATION_ID,
    property_id: null,
    name: 'צוות משק בית',
    description: 'ניקיון והכנת יחידות בשני הנכסים.',
    kind: 'housekeeping',
    color: '#3F8F7A',
    metadata: {},
    ...stamped(OWNER_ID, -400),
  },
  {
    id: TEAM_IDS.frontDesk,
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    name: 'צוות קבלה — רימונים',
    description: 'קבלת אורחים, שיחות ותפעול יומי.',
    kind: 'front_desk',
    color: '#2F6DB0',
    metadata: {},
    ...stamped(OWNER_ID, -400),
  },
  {
    id: TEAM_IDS.maintenance,
    organization_id: ORGANIZATION_ID,
    property_id: null,
    name: 'צוות אחזקה',
    description: 'תקלות, בריכה, גינון ותחזוקה מונעת.',
    kind: 'maintenance',
    color: '#B0742F',
    metadata: {},
    ...stamped(OWNER_ID, -390),
  },
]

/* -------------------------------------------------------- unit groups ---- */

export const UNIT_GROUP_IDS = {
  suites: unitGroupIds(1),
  cabins: unitGroupIds(2),
} as const

export const UNIT_GROUP_ROWS: DemoRow[] = [
  {
    id: UNIT_GROUP_IDS.suites,
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    name: 'סוויטות',
    description: 'יחידות עם ג׳קוזי פרטי ומרפסת אל הנוף.',
    sort_order: 1,
    metadata: {},
    ...stamped(OWNER_ID, -405),
  },
  {
    id: UNIT_GROUP_IDS.cabins,
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.rimonim,
    name: 'בקתות ומשפחתי',
    description: 'יחידות עץ בשולי המטע.',
    sort_order: 2,
    metadata: {},
    ...stamped(OWNER_ID, -405),
  },
]

/* -------------------------------------------------------------- units ---- */

/**
 * The sellable inventory, in the shape the rest of the dataset needs.
 *
 * Kept as a typed record and turned into rows below, so a price used to build
 * a booking's lines is the same number the `units` row carries. Two copies of
 * a nightly rate is how a demo ends up quoting one figure on the calendar and
 * a different one on the invoice.
 */
export type DemoUnit = {
  id: string
  propertyId: string
  unitGroupId: string | null
  code: string
  name: string
  unitType: string
  maxGuests: number
  standardGuests: number
  bedrooms: number
  beds: number
  bathrooms: string
  sizeSqm: string
  minNights: number
  baseAgorot: number
  extraGuestAgorot: number
  cleaningAgorot: number
  depositAgorot: number
  status: string
  description: string
  /**
   * How long ago the unit was added, in days. Defaults to the day the
   * inventory was set up.
   *
   * It exists for the one unit that is still a draft: a unit created four
   * hundred days ago and never made sellable reads as neglect, and a unit
   * added last week reads as work in progress. The occupancy metric also
   * counts nights from `units.created_at`, so a draft that claims to have
   * existed all year would drag the denominator down for a room that was never
   * on the market.
   */
  createdDaysAgo?: number
}

export const UNITS: readonly DemoUnit[] = [
  {
    id: unitIds(1),
    propertyId: PROPERTY_IDS.rimonim,
    unitGroupId: UNIT_GROUP_IDS.suites,
    code: 'RIM-01',
    name: 'סוויטת הזית',
    unitType: 'suite',
    maxGuests: 2,
    standardGuests: 2,
    bedrooms: 1,
    beds: 1,
    bathrooms: '1.0',
    sizeSqm: '42.00',
    minNights: 1,
    baseAgorot: 115_000,
    extraGuestAgorot: 0,
    cleaningAgorot: 18_000,
    depositAgorot: 50_000,
    status: 'active',
    description: 'סוויטה זוגית עם ג׳קוזי פרטי ומרפסת אל עמק החולה.',
  },
  {
    id: unitIds(2),
    propertyId: PROPERTY_IDS.rimonim,
    unitGroupId: UNIT_GROUP_IDS.cabins,
    code: 'RIM-02',
    name: 'בקתת הרימון',
    unitType: 'cabin',
    maxGuests: 4,
    standardGuests: 2,
    bedrooms: 2,
    beds: 3,
    bathrooms: '1.0',
    sizeSqm: '58.00',
    minNights: 2,
    baseAgorot: 98_000,
    extraGuestAgorot: 12_000,
    cleaningAgorot: 20_000,
    depositAgorot: 50_000,
    status: 'active',
    description: 'בקתת עץ משפחתית בשולי מטע הרימונים, עם מטבחון וחצר.',
  },
  {
    id: unitIds(3),
    propertyId: PROPERTY_IDS.rimonim,
    unitGroupId: UNIT_GROUP_IDS.suites,
    code: 'RIM-03',
    name: 'סוויטת התאנה',
    unitType: 'suite',
    maxGuests: 3,
    standardGuests: 2,
    bedrooms: 1,
    beds: 2,
    bathrooms: '1.5',
    sizeSqm: '48.00',
    minNights: 1,
    baseAgorot: 128_000,
    extraGuestAgorot: 14_000,
    cleaningAgorot: 18_000,
    depositAgorot: 60_000,
    status: 'active',
    description: 'הסוויטה הגדולה, עם אמבט חיצוני וכניסה נפרדת.',
  },
  {
    id: unitIds(4),
    propertyId: PROPERTY_IDS.rimonim,
    unitGroupId: UNIT_GROUP_IDS.cabins,
    code: 'RIM-04',
    name: 'חדר הגפן',
    unitType: 'room',
    maxGuests: 2,
    standardGuests: 2,
    bedrooms: 1,
    beds: 1,
    bathrooms: '1.0',
    sizeSqm: '28.00',
    minNights: 1,
    baseAgorot: 72_000,
    extraGuestAgorot: 0,
    cleaningAgorot: 12_000,
    depositAgorot: 30_000,
    status: 'active',
    description: 'החדר הקטן והזול ביותר. פופולרי באמצע השבוע.',
  },
  {
    id: unitIds(5),
    propertyId: PROPERTY_IDS.kacholYam,
    unitGroupId: null,
    code: 'KAY-01',
    name: 'וילה כחול ים — האגף הראשי',
    unitType: 'villa',
    maxGuests: 12,
    standardGuests: 8,
    bedrooms: 4,
    beds: 7,
    bathrooms: '3.5',
    sizeSqm: '240.00',
    minNights: 2,
    baseAgorot: 420_000,
    extraGuestAgorot: 22_000,
    cleaningAgorot: 65_000,
    depositAgorot: 250_000,
    status: 'active',
    description: 'הווילה במלואה: ארבעה חדרים, בריכה מחוממת ומטבח שף.',
  },
  {
    id: unitIds(6),
    propertyId: PROPERTY_IDS.kacholYam,
    unitGroupId: null,
    code: 'KAY-02',
    name: 'יחידת האורחים',
    unitType: 'studio',
    maxGuests: 2,
    standardGuests: 2,
    bedrooms: 1,
    beds: 1,
    bathrooms: '1.0',
    sizeSqm: '34.00',
    minNights: 1,
    baseAgorot: 89_000,
    extraGuestAgorot: 0,
    cleaningAgorot: 15_000,
    depositAgorot: 40_000,
    status: 'active',
    description: 'סטודיו נפרד בקצה הגן, מושכר גם כשהווילה תפוסה.',
  },
  /**
   * The one unit that cannot be sold, and the reason it is here.
   *
   * Six active units made every screen agree with every other screen, which
   * made one of the sharpest rules in the product invisible: `loadRules` in
   * `persistence/booking.ts` returns `null` for any unit whose status is not
   * `active`, and `checkAvailability` turns that into a refusal — so a draft
   * unit has a name, a price and a capacity, and the engine will not sell it a
   * single night. On the calendar it simply shows as blocked all year, which
   * from the outside looks like a defect rather than like a decision.
   *
   * A demo where that state does not exist cannot show the difference between
   * inventory and sellable inventory, and the units screen would have had
   * nothing to distinguish. So there is one, in ראש פינה, added recently and
   * plainly mid-preparation. It is deliberately *not* wired into a booking,
   * an occupancy row or a task: an unsellable unit that somebody has sold
   * would be a dataset contradicting itself.
   */
  {
    id: unitIds(7),
    propertyId: PROPERTY_IDS.rimonim,
    unitGroupId: UNIT_GROUP_IDS.cabins,
    code: 'RIM-05',
    name: 'בקתת הרימון הקטנה',
    unitType: 'cabin',
    maxGuests: 2,
    standardGuests: 2,
    bedrooms: 1,
    beds: 1,
    bathrooms: '1.0',
    sizeSqm: '31.00',
    minNights: 1,
    baseAgorot: 86_000,
    extraGuestAgorot: 0,
    cleaningAgorot: 14_000,
    depositAgorot: 30_000,
    // The whole reason this row exists. Not a typo, and not a unit somebody
    // forgot to activate — it is the state the product has to be able to show.
    status: 'draft',
    createdDaysAgo: 9,
    description:
      'בקתה שנייה בשולי המטע, בהכנה. טרם נפתחה למכירה: היומן מציג אותה כחסומה, ומנוע ההזמנות מסרב לה.',
  },
]

/** A unit by code. Throws on a typo, because a silent `undefined` is worse. */
export function unit(code: string): DemoUnit {
  const found = UNITS.find((candidate) => candidate.code === code)
  if (!found) throw new Error(`Demo dataset: no unit with code "${code}"`)
  return found
}

export const UNIT_ROWS: DemoRow[] = UNITS.map((entry, index) => ({
  id: entry.id,
  organization_id: ORGANIZATION_ID,
  property_id: entry.propertyId,
  unit_group_id: entry.unitGroupId,
  code: entry.code,
  name: entry.name,
  description: entry.description,
  unit_type: entry.unitType,
  status: entry.status,
  max_guests: entry.maxGuests,
  standard_guests: entry.standardGuests,
  max_adults: entry.maxGuests,
  max_children: Math.max(entry.maxGuests - entry.standardGuests, 0),
  bedrooms: entry.bedrooms,
  // `numeric` arrives from PostgREST as a string, and 1.5 bathrooms is a real
  // listing. Sending a JavaScript number here would be a shape the product
  // never actually receives.
  bathrooms: entry.bathrooms,
  beds: entry.beds,
  size_sqm: entry.sizeSqm,
  floor: null,
  base_price_agorot: entry.baseAgorot,
  extra_guest_price_agorot: entry.extraGuestAgorot,
  cleaning_fee_agorot: entry.cleaningAgorot,
  deposit_agorot: entry.depositAgorot,
  check_in_time:
    entry.propertyId === PROPERTY_IDS.rimonim ? '15:00:00' : '16:00:00',
  check_out_time:
    entry.propertyId === PROPERTY_IDS.rimonim ? '11:00:00' : '10:00:00',
  min_nights: entry.minNights,
  max_nights: null,
  cover_image_url: null,
  sort_order: index + 1,
  metadata: {},
  ...stamped(OWNER_ID, -(entry.createdDaysAgo ?? 400)),
}))

/* ---------------------------------------------------------- amenities ---- */

type AmenitySeed = {
  code: string
  name: string
  nameHe: string
  category: string
  icon: string
}

const AMENITY_SEEDS: readonly AmenitySeed[] = [
  {
    code: 'wifi',
    name: 'Wi-Fi',
    nameHe: 'אינטרנט אלחוטי',
    category: 'general',
    icon: 'wifi',
  },
  {
    code: 'air_conditioning',
    name: 'Air conditioning',
    nameHe: 'מיזוג אוויר',
    category: 'general',
    icon: 'snowflake',
  },
  {
    code: 'private_jacuzzi',
    name: 'Private jacuzzi',
    nameHe: 'ג׳קוזי פרטי',
    category: 'wellness',
    icon: 'bath',
  },
  {
    code: 'heated_pool',
    name: 'Heated pool',
    nameHe: 'בריכה מחוממת',
    category: 'outdoor',
    icon: 'waves',
  },
  {
    code: 'kitchenette',
    name: 'Kitchenette',
    nameHe: 'מטבחון',
    category: 'kitchen',
    icon: 'utensils',
  },
  {
    code: 'bbq',
    name: 'Barbecue',
    nameHe: 'מנגל',
    category: 'outdoor',
    icon: 'flame',
  },
  {
    code: 'baby_cot',
    name: 'Baby cot',
    nameHe: 'מיטת תינוק',
    category: 'family',
    icon: 'baby',
  },
  {
    code: 'accessible_entrance',
    name: 'Accessible entrance',
    nameHe: 'כניסה נגישה',
    category: 'accessibility',
    icon: 'accessibility',
  },
  {
    code: 'breakfast_basket',
    name: 'Breakfast basket',
    nameHe: 'ארוחת בוקר בסלסלה',
    category: 'services',
    icon: 'basket',
  },
  {
    code: 'smart_tv',
    name: 'Smart TV',
    nameHe: 'טלוויזיה חכמה',
    category: 'entertainment',
    icon: 'tv',
  },
]

const AMENITY_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    AMENITY_SEEDS.map((seed, index) => [seed.code, amenityIds(index + 1)]),
  ),
)

/**
 * The amenity catalogue is global — `organization_id` is nullable on this
 * table precisely so ESTIA ships a shared list nobody has to retype.
 */
export const AMENITY_ROWS: DemoRow[] = AMENITY_SEEDS.map((seed, index) => ({
  id: AMENITY_IDS[seed.code],
  organization_id: null,
  code: seed.code,
  name: seed.name,
  name_he: seed.nameHe,
  category: seed.category,
  icon: seed.icon,
  sort_order: (index + 1) * 10,
  metadata: {},
  ...stamped(null, -420),
}))

const PROPERTY_AMENITY_CODES: Readonly<Record<string, readonly string[]>> = {
  [PROPERTY_IDS.rimonim]: [
    'wifi',
    'heated_pool',
    'bbq',
    'breakfast_basket',
    'accessible_entrance',
  ],
  [PROPERTY_IDS.kacholYam]: ['wifi', 'heated_pool', 'bbq'],
}

export const PROPERTY_AMENITY_ROWS: DemoRow[] = Object.entries(
  PROPERTY_AMENITY_CODES,
).flatMap(([propertyId, codes]) =>
  codes.map((code) => ({
    organization_id: ORGANIZATION_ID,
    property_id: propertyId,
    amenity_id: AMENITY_IDS[code],
    notes: null,
    created_at: UNIT_ROWS[0].created_at,
    created_by: OWNER_ID,
  })),
)

const UNIT_AMENITY_CODES: Readonly<Record<string, readonly string[]>> = {
  'RIM-01': ['air_conditioning', 'private_jacuzzi', 'smart_tv'],
  'RIM-02': ['air_conditioning', 'kitchenette', 'baby_cot', 'smart_tv'],
  'RIM-03': ['air_conditioning', 'private_jacuzzi', 'kitchenette', 'smart_tv'],
  'RIM-04': ['air_conditioning', 'smart_tv'],
  'KAY-01': ['air_conditioning', 'kitchenette', 'baby_cot', 'smart_tv'],
  'KAY-02': ['air_conditioning', 'smart_tv'],
}

export const UNIT_AMENITY_ROWS: DemoRow[] = Object.entries(
  UNIT_AMENITY_CODES,
).flatMap(([code, amenityCodes]) => {
  const target = unit(code)
  return amenityCodes.map((amenityCode) => ({
    organization_id: ORGANIZATION_ID,
    property_id: target.propertyId,
    unit_id: target.id,
    amenity_id: AMENITY_IDS[amenityCode],
    quantity: 1,
    notes: null,
    created_at: UNIT_ROWS[0].created_at,
    created_by: OWNER_ID,
  }))
})

/** The member who looks after each property, used by the operations rows. */
export const PROPERTY_MANAGER_ID = person('property-manager').userId
