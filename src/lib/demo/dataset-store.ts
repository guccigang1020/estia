/**
 * The shop אחוזת הגליל actually runs.
 *
 * ── What this dataset is arguing ──────────────────────────────────────────
 *
 * The organization is on `simple`. That is the point of the whole seed: a
 * two-property Galilee business selling a שולחן שוק, pool heating, a late
 * checkout and a DJ, with **no payment provider anywhere**, no stock, no
 * suppliers and no margin. Every screen the demo walks has to be honest at
 * that setting, because it is the setting most of the product's real
 * customers will choose.
 *
 * So: `store_settings.mode` is `simple`, `default_payment_mode` is
 * `with_booking`, and no row here carries `cost_agorot` or
 * `supplier_reference` — the two `advanced` columns. A demo that seeded a
 * margin would demonstrate a screen the business would never see.
 *
 * ── Every product exists to make one rule visible ─────────────────────────
 *
 *   שולחן שוק        the price snapshot. It is ₪1,500, and the seeded order
 *                    below is ₪1,500, and both stay that way when somebody
 *                    edits the catalogue on screen.
 *   חימום בריכה      booking-aware eligibility. It needs `heated_pool` and
 *                    24 hours' notice, so it is offered at one house and
 *                    refused at the other with a sentence.
 *   צ׳ק אאוט מאוחר   the calendar. Its verdict is a caveat rather than a
 *                    promise, because the occupancy port answers "unknown".
 *   תקליטן            the external provider, and the fact that the request
 *                    that goes to them carries no guest and no money.
 *   ארוחת בוקר       per-guest pricing, which is what a change in the party
 *                    re-prices — as an amendment, never a silent charge.
 *   קייטרינג          `quote`, so the store has to say "בקש הצעה" rather than
 *                    pretend to a number.
 *
 * ── What is deliberately NOT seeded ───────────────────────────────────────
 *
 * `store_price_history` is written by a trigger, `store_order_payments` by a
 * person pressing a button, and `store_provider_requests` by somebody choosing
 * to send one. All three are declared empty: seeding them would be fabricating
 * the record of acts nobody performed, which is the one kind of fiction this
 * product must never ship.
 *
 * One order IS seeded, because a store with no order has no order screen to
 * demonstrate — and it is seeded at the state a real one reaches on its own:
 * `awaiting_approval`, unpaid, with its price frozen at what the guest agreed.
 */

import type { DemoRow } from './types'
import { day, idsFor, momentOn, stampedNoDelete } from './dataset-support'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { PROPERTY_IDS, TEAM_IDS } from './dataset-inventory'
import { bookingAt } from './dataset-bookings'

/**
 * Id groups above `ID_GROUP`'s last entry (35).
 *
 * Declared here rather than in `dataset-support.ts`, which belongs to the
 * coordinator: `demoUuid` takes a number, so a module can own its own range
 * without editing a shared file, and the numbers are stated together so the
 * next module can see which are taken.
 */
const STORE_ID_GROUP = {
  settings: 40,
  category: 41,
  provider: 42,
  item: 43,
  option: 44,
  optionValue: 45,
  addon: 46,
  package: 47,
  packageItem: 48,
  override: 49,
  availabilityRule: 50,
  promoCode: 51,
  order: 52,
  orderLine: 53,
  orderLineOption: 54,
} as const

const settingsIds = idsFor(STORE_ID_GROUP.settings)
const categoryIds = idsFor(STORE_ID_GROUP.category)
const providerIds = idsFor(STORE_ID_GROUP.provider)
const itemIds = idsFor(STORE_ID_GROUP.item)
const optionIds = idsFor(STORE_ID_GROUP.option)
const optionValueIds = idsFor(STORE_ID_GROUP.optionValue)
const addonIds = idsFor(STORE_ID_GROUP.addon)
const packageIds = idsFor(STORE_ID_GROUP.package)
const packageItemIds = idsFor(STORE_ID_GROUP.packageItem)
const overrideIds = idsFor(STORE_ID_GROUP.override)
const ruleIds = idsFor(STORE_ID_GROUP.availabilityRule)
const promoIds = idsFor(STORE_ID_GROUP.promoCode)
const orderIds = idsFor(STORE_ID_GROUP.order)
const orderLineIds = idsFor(STORE_ID_GROUP.orderLine)
const orderLineOptionIds = idsFor(STORE_ID_GROUP.orderLineOption)

const OWNER_ID = person('owner').userId
const MANAGER_ID = person('general-manager').userId
const RECEPTION_ID = person('reception').userId

/* ------------------------------------------------------------- settings -- */

/**
 * `simple`, and that is the whole argument.
 *
 * `payment_modes_enabled` names three, and `pay_now` is not among them —
 * `store_settings_no_live_payment_in_simple` would refuse the row if it were.
 */
export const STORE_SETTINGS_ROWS: DemoRow[] = [
  {
    id: settingsIds(1),
    organization_id: ORGANIZATION_ID,
    property_id: null,
    mode: 'simple',
    default_payment_mode: 'with_booking',
    payment_modes_enabled: ['with_booking', 'manual', 'on_arrival'],
    approval_required_default: true,
    guest_store_enabled: true,
    guest_store_heading: 'מה עוד אפשר להוסיף לשהות',
    guest_store_intro:
      'כמה דברים שאנחנו מסדרים לאורחים שלנו. אפשר לבקש כאן, ואנחנו נחזור אליכם לאישור.',
    currency: 'ILS',
    order_reference_prefix: 'S',
    cart_ttl_hours: 72,
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -120),
  },
]

/* ----------------------------------------------------------- categories -- */

export const STORE_CATEGORY_IDS = {
  table: categoryIds(1),
  comfort: categoryIds(2),
  events: categoryIds(3),
} as const

export const STORE_CATEGORY_ROWS: DemoRow[] = [
  {
    id: STORE_CATEGORY_IDS.table,
    organization_id: ORGANIZATION_ID,
    name: 'על השולחן',
    slug: 'table',
    description: 'אוכל ושתייה שמחכים לכם כשאתם מגיעים.',
    icon: '🍇',
    sort_order: 1,
    is_active: true,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -118),
  },
  {
    id: STORE_CATEGORY_IDS.comfort,
    organization_id: ORGANIZATION_ID,
    name: 'נוחות בנכס',
    slug: 'comfort',
    description: 'דברים קטנים שעושים את ההבדל בשהות עצמה.',
    icon: '🛁',
    sort_order: 2,
    is_active: true,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -118),
  },
  {
    id: STORE_CATEGORY_IDS.events,
    organization_id: ORGANIZATION_ID,
    name: 'אירועים',
    slug: 'events',
    description: 'כשיש מה לחגוג, ואתם רוצים שמישהו אחר יסדר את זה.',
    icon: '🎉',
    sort_order: 3,
    is_active: true,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(MANAGER_ID, -90),
  },
]

/* ------------------------------------------------------------ providers -- */

export const STORE_PROVIDER_IDS = { dj: providerIds(1) } as const

export const STORE_PROVIDER_ROWS: DemoRow[] = [
  {
    id: STORE_PROVIDER_IDS.dj,
    organization_id: ORGANIZATION_ID,
    name: 'סאונד גליל',
    contact_name: 'איתי',
    phone: '0521234567',
    email: null,
    service_types: ['dj', 'sound'],
    default_channel: 'whatsapp',
    lead_time_hours: 72,
    notes: 'מגיעים עם מערכת משלהם. צריך חשמל בחצר.',
    is_active: true,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(MANAGER_ID, -90),
  },
]

/* ----------------------------------------------------------------- items -- */

export const STORE_ITEM_IDS = {
  marketTable: itemIds(1),
  poolHeating: itemIds(2),
  lateCheckout: itemIds(3),
  dj: itemIds(4),
  breakfast: itemIds(5),
  catering: itemIds(6),
} as const

/** ₪1,500, in agorot. Named, because it is asserted in three places. */
export const MARKET_TABLE_AGOROT = 150_000

export const STORE_ITEM_ROWS: DemoRow[] = [
  // ── THE PRICE SNAPSHOT'S OWN PRODUCT ───────────────────────────────────
  {
    id: STORE_ITEM_IDS.marketTable,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.table,
    name: 'שולחן שוק',
    slug: 'market-table',
    short_description: 'שולחן עמוס בטוב של האזור, מחכה לכם על השולחן בכניסה.',
    description:
      'גבינות מהרפת ליד, זיתים, לחם מהמאפייה בראש פינה, פירות העונה ובקבוק יין מקומי. אנחנו מסדרים הכול לפני שאתם מגיעים.',
    item_type: 'experience',
    status: 'active',
    pricing_model: 'fixed',
    base_price_agorot: MARKET_TABLE_AGOROT,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: 2,
    max_per_booking: 2,
    unit_label: null,
    lead_time_hours: 48,
    capacity_per_day: 4,
    requires_capability: null,
    min_guests: null,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: null,
    payment_mode: null,
    fulfilment_kind: 'staff_task',
    fulfilment_recipe: {
      taskType: 'guest_request',
      title: 'להכין שולחן שוק',
      dueOffsetHours: -3,
      checklist: [
        'לקנות במכולת ובמאפייה',
        'לסדר על השולחן בכניסה',
        'לצנן את היין',
      ],
      teamId: TEAM_IDS.housekeeping,
    },
    provider_id: null,
    customization_questions: [],
    cancellation_policy: { kind: 'free_until_hours', hoursBefore: 48 },
    media: [],
    tags: ['מקומי', 'קבלת פנים'],
    audience: { suitsCouple: true, suitsFamily: true, occasions: ['birthday'] },
    is_featured: true,
    sort_order: 1,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -118),
  },

  // ── ELIGIBILITY: a capability and a lead time ──────────────────────────
  {
    id: STORE_ITEM_IDS.poolHeating,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.comfort,
    name: 'חימום בריכה',
    slug: 'pool-heating',
    short_description: 'בריכה מחוממת לכל ימי השהות.',
    description: 'מחממים את הבריכה מהערב שלפני ההגעה ועד היציאה.',
    item_type: 'property_addon',
    status: 'active',
    pricing_model: 'per_night',
    base_price_agorot: 25_000,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: null,
    max_per_booking: 1,
    unit_label: 'לילה',
    lead_time_hours: 24,
    capacity_per_day: null,
    // Only at a house that has one. `כחול ים` does not.
    requires_capability: 'heated_pool',
    min_guests: null,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: false,
    payment_mode: null,
    fulfilment_kind: 'staff_task',
    fulfilment_recipe: {
      taskType: 'maintenance',
      title: 'להדליק חימום בריכה',
      dueOffsetHours: -12,
      checklist: ['להדליק את המשאבה', 'לבדוק טמפרטורה בבוקר'],
      teamId: TEAM_IDS.maintenance,
    },
    provider_id: null,
    customization_questions: [],
    cancellation_policy: { kind: 'free_until_hours', hoursBefore: 24 },
    media: [],
    tags: ['חורף'],
    audience: { suitsFamily: true, suitsCouple: true },
    is_featured: false,
    sort_order: 2,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -110),
  },

  // ── THE CALENDAR'S PRODUCT: offered with a caveat ──────────────────────
  {
    id: STORE_ITEM_IDS.lateCheckout,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.comfort,
    name: 'צ׳ק אאוט מאוחר',
    slug: 'late-checkout',
    short_description: 'יציאה בארבע אחר הצהריים במקום באחת עשרה.',
    description: null,
    item_type: 'property_addon',
    status: 'active',
    pricing_model: 'fixed',
    base_price_agorot: 15_000,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: 1,
    max_per_booking: 1,
    unit_label: null,
    lead_time_hours: 12,
    capacity_per_day: null,
    requires_capability: null,
    min_guests: null,
    max_guests: null,
    visibility_rule: 'during_stay',
    visibility_days_before: null,
    requires_approval: true,
    payment_mode: null,
    fulfilment_kind: 'none',
    fulfilment_recipe: {},
    provider_id: null,
    customization_questions: [],
    cancellation_policy: { kind: 'free_until_hours', hoursBefore: 12 },
    media: [],
    tags: [],
    audience: {},
    is_featured: false,
    sort_order: 3,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(MANAGER_ID, -100),
  },

  // ── THE EXTERNAL PROVIDER ──────────────────────────────────────────────
  {
    id: STORE_ITEM_IDS.dj,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.events,
    name: 'תקליטן לערב',
    slug: 'dj',
    short_description: 'תקליטן עם מערכת, לערב אחד.',
    description: 'ארבע שעות. אפשר להאריך בשעה נוספת.',
    item_type: 'service',
    status: 'active',
    pricing_model: 'per_hour',
    base_price_agorot: 45_000,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 4,
    max_quantity: 6,
    max_per_booking: 1,
    unit_label: 'שעה',
    lead_time_hours: 72,
    capacity_per_day: 1,
    requires_capability: null,
    min_guests: 10,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: true,
    payment_mode: null,
    fulfilment_kind: 'external_provider',
    fulfilment_recipe: {},
    provider_id: STORE_PROVIDER_IDS.dj,
    customization_questions: [
      {
        key: 'style',
        label: 'סגנון מוזיקה',
        kind: 'choice',
        required: true,
        choices: ['ים תיכוני', 'לועזי', 'מעורב'],
      },
    ],
    cancellation_policy: { kind: 'percentage', refundPercent: 50 },
    media: [],
    tags: ['אירועים'],
    audience: { suitsGroup: true, occasions: ['birthday', 'wedding'] },
    is_featured: false,
    sort_order: 4,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(MANAGER_ID, -88),
  },

  // ── PER-GUEST PRICING, which a changed party re-prices ─────────────────
  {
    id: STORE_ITEM_IDS.breakfast,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.table,
    name: 'ארוחת בוקר',
    slug: 'breakfast',
    short_description: 'ארוחת בוקר בוקר לכל אורח, מוגשת בשמונה וחצי.',
    description: null,
    item_type: 'service',
    status: 'active',
    pricing_model: 'per_guest',
    base_price_agorot: 6_000,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: null,
    max_per_booking: null,
    unit_label: 'אורח',
    lead_time_hours: 24,
    capacity_per_day: 20,
    requires_capability: null,
    min_guests: null,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: false,
    payment_mode: null,
    fulfilment_kind: 'staff_task',
    fulfilment_recipe: {
      taskType: 'guest_request',
      title: 'ארוחת בוקר לאורחים',
      dueOffsetHours: -1,
      checklist: ['לסדר את השולחן', 'לחמם את הלחם'],
      teamId: TEAM_IDS.housekeeping,
    },
    provider_id: null,
    customization_questions: [
      { key: 'diet', label: 'הגבלות תזונה', kind: 'text', required: false },
    ],
    cancellation_policy: { kind: 'free_until_hours', hoursBefore: 24 },
    media: [],
    tags: [],
    audience: { suitsFamily: true },
    is_featured: false,
    sort_order: 5,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -80),
  },

  // ── `quote`: an honest answer, not a missing price ─────────────────────
  {
    id: STORE_ITEM_IDS.catering,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.events,
    name: 'קייטרינג לאירוע',
    slug: 'catering',
    short_description: 'ארוחה לקבוצה. מתמחרים לפי מה שאתם רוצים.',
    description: null,
    item_type: 'service',
    status: 'active',
    pricing_model: 'quote',
    base_price_agorot: null,
    cost_agorot: null,
    supplier_reference: null,
    tax_rate_bps: null,
    min_quantity: 1,
    max_quantity: null,
    max_per_booking: 1,
    unit_label: null,
    lead_time_hours: 168,
    capacity_per_day: null,
    requires_capability: null,
    min_guests: 12,
    max_guests: null,
    visibility_rule: 'always',
    visibility_days_before: null,
    requires_approval: true,
    payment_mode: null,
    fulfilment_kind: 'external_provider',
    fulfilment_recipe: {},
    provider_id: STORE_PROVIDER_IDS.dj,
    customization_questions: [],
    cancellation_policy: { kind: 'unspecified' },
    media: [],
    tags: ['אירועים'],
    audience: { suitsGroup: true },
    is_featured: false,
    sort_order: 6,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(MANAGER_ID, -60),
  },
]

/* -------------------------------------------------------- options, addons -- */

export const STORE_ITEM_OPTION_IDS = { tableSize: optionIds(1) } as const
export const STORE_ITEM_OPTION_VALUE_IDS = {
  tableForFour: optionValueIds(1),
  tableForEight: optionValueIds(2),
} as const

export const STORE_ITEM_OPTION_ROWS: DemoRow[] = [
  {
    id: STORE_ITEM_OPTION_IDS.tableSize,
    organization_id: ORGANIZATION_ID,
    item_id: STORE_ITEM_IDS.marketTable,
    name: 'גודל השולחן',
    selection: 'single',
    is_required: true,
    sort_order: 1,
    ...stampedNoDelete(OWNER_ID, -118),
  },
]

export const STORE_ITEM_OPTION_VALUE_ROWS: DemoRow[] = [
  {
    id: STORE_ITEM_OPTION_VALUE_IDS.tableForFour,
    organization_id: ORGANIZATION_ID,
    option_id: STORE_ITEM_OPTION_IDS.tableSize,
    label: 'עד ארבעה סועדים',
    price_delta_agorot: 0,
    is_default: true,
    is_available: true,
    sort_order: 1,
    ...stampedNoDelete(OWNER_ID, -118),
  },
  {
    id: STORE_ITEM_OPTION_VALUE_IDS.tableForEight,
    organization_id: ORGANIZATION_ID,
    option_id: STORE_ITEM_OPTION_IDS.tableSize,
    label: 'עד שמונה סועדים',
    price_delta_agorot: 40_000,
    is_default: false,
    is_available: true,
    sort_order: 2,
    ...stampedNoDelete(OWNER_ID, -118),
  },
]

export const STORE_ITEM_ADDON_ROWS: DemoRow[] = [
  {
    id: addonIds(1),
    organization_id: ORGANIZATION_ID,
    item_id: STORE_ITEM_IDS.dj,
    name: 'שעה נוספת',
    description: 'להאריך את הערב בשעה.',
    price_agorot: 45_000,
    pricing_model: 'fixed',
    max_quantity: 2,
    is_active: true,
    sort_order: 1,
    ...stampedNoDelete(MANAGER_ID, -88),
  },
  {
    id: addonIds(2),
    organization_id: ORGANIZATION_ID,
    item_id: STORE_ITEM_IDS.dj,
    name: 'תאורת אווירה',
    description: null,
    price_agorot: 30_000,
    pricing_model: 'fixed',
    max_quantity: 1,
    is_active: true,
    sort_order: 2,
    ...stampedNoDelete(MANAGER_ID, -88),
  },
]

/* -------------------------------------------------------------- packages -- */

const CELEBRATION_PACKAGE = packageIds(1)

export const STORE_PACKAGE_ROWS: DemoRow[] = [
  {
    id: CELEBRATION_PACKAGE,
    organization_id: ORGANIZATION_ID,
    category_id: STORE_CATEGORY_IDS.events,
    name: 'ערב חגיגה',
    slug: 'celebration',
    short_description: 'שולחן שוק, תקליטן וארוחת בוקר למחרת.',
    description: null,
    // NOT the sum of its members — that is the whole point of a package.
    // ₪1,500 + ₪1,800 + ₪240 is ₪3,540; this is ₪2,990.
    price_agorot: 299_000,
    pricing_model: 'fixed',
    status: 'active',
    media: [],
    audience: { suitsGroup: true, occasions: ['birthday'] },
    cancellation_policy: { kind: 'percentage', refundPercent: 50 },
    visibility_rule: 'always',
    visibility_days_before: null,
    is_featured: true,
    sort_order: 1,
    metadata: {},
    deleted_at: null,
    ...stampedNoDelete(OWNER_ID, -40),
  },
]

export const STORE_PACKAGE_ITEM_ROWS: DemoRow[] = [
  {
    id: packageItemIds(1),
    organization_id: ORGANIZATION_ID,
    package_id: CELEBRATION_PACKAGE,
    item_id: STORE_ITEM_IDS.marketTable,
    quantity: 1,
    sort_order: 1,
    ...stampedNoDelete(OWNER_ID, -40),
  },
  {
    id: packageItemIds(2),
    organization_id: ORGANIZATION_ID,
    package_id: CELEBRATION_PACKAGE,
    item_id: STORE_ITEM_IDS.dj,
    quantity: 4,
    sort_order: 2,
    ...stampedNoDelete(OWNER_ID, -40),
  },
  {
    id: packageItemIds(3),
    organization_id: ORGANIZATION_ID,
    package_id: CELEBRATION_PACKAGE,
    item_id: STORE_ITEM_IDS.breakfast,
    quantity: 4,
    sort_order: 3,
    ...stampedNoDelete(OWNER_ID, -40),
  },
]

/* ------------------------------------------------------------- overrides -- */

/**
 * The same product, two houses.
 *
 * `כחול ים` has no pool, so pool heating is switched off there — and the
 * eligibility engine refuses it with "המוצר הזה אינו מוצע בנכס הזה" rather
 * than with a technical reason. The market table costs ₪200 more there
 * because the shops are further away.
 */
export const STORE_ITEM_PROPERTY_OVERRIDE_ROWS: DemoRow[] = [
  {
    id: overrideIds(1),
    organization_id: ORGANIZATION_ID,
    item_id: STORE_ITEM_IDS.poolHeating,
    property_id: PROPERTY_IDS.kacholYam,
    is_available: false,
    price_override_agorot: null,
    lead_time_hours_override: null,
    capacity_per_day_override: null,
    provider_override_id: null,
    notes: 'אין בריכה בנכס הזה.',
    ...stampedNoDelete(MANAGER_ID, -95),
  },
  {
    id: overrideIds(2),
    organization_id: ORGANIZATION_ID,
    item_id: STORE_ITEM_IDS.marketTable,
    property_id: PROPERTY_IDS.kacholYam,
    is_available: true,
    price_override_agorot: 170_000,
    lead_time_hours_override: 72,
    capacity_per_day_override: 2,
    provider_override_id: null,
    notes: 'המכולת רחוקה יותר, ולכן צריך יום נוסף.',
    ...stampedNoDelete(MANAGER_ID, -95),
  },
]

/* ---------------------------------------------------- availability rules -- */

export const STORE_AVAILABILITY_RULE_ROWS: DemoRow[] = [
  {
    id: ruleIds(1),
    organization_id: ORGANIZATION_ID,
    // The DJ works Thursday, Friday and Saturday. A PERMITTING rule, so it is
    // a whitelist: anything outside it is refused with "השירות ניתן רק בימים
    // ובתאריכים מסוימים".
    item_id: STORE_ITEM_IDS.dj,
    property_id: null,
    kind: 'weekday',
    weekdays: [4, 5, 6],
    from_date: null,
    to_date: null,
    from_time: null,
    to_time: null,
    max_per_day: null,
    is_blocking: false,
    note: null,
    is_active: true,
    ...stampedNoDelete(MANAGER_ID, -88),
  },
  {
    id: ruleIds(2),
    organization_id: ORGANIZATION_ID,
    // Everything, everywhere, for the fortnight the family is away.
    item_id: null,
    property_id: null,
    kind: 'blackout',
    weekdays: [],
    from_date: day(120),
    to_date: day(134),
    from_time: null,
    to_time: null,
    max_per_day: null,
    is_blocking: true,
    note: 'סגורים לחופשה שנתית. נשמח לסדר הכול לפני או אחרי.',
    is_active: true,
    ...stampedNoDelete(OWNER_ID, -30),
  },
]

/* ----------------------------------------------------------- promo codes -- */

export const STORE_PROMO_CODE_ROWS: DemoRow[] = [
  {
    id: promoIds(1),
    organization_id: ORGANIZATION_ID,
    code: 'CHOREF10',
    description: 'עשרה אחוז על תוספות בחודשי החורף.',
    discount_kind: 'percent',
    percent: 10,
    amount_agorot: null,
    min_order_agorot: 20_000,
    max_uses: 50,
    uses: 3,
    max_uses_per_booking: 1,
    valid_from: momentOn(-30, '00:00'),
    valid_until: momentOn(60, '23:59'),
    item_ids: [],
    is_active: true,
    ...stampedNoDelete(OWNER_ID, -30),
  },
]

/* ---------------------------------------------------------------- orders -- */

/**
 * One order, at the state a real one reaches on its own.
 *
 * It belongs to a booking that already exists in `dataset-bookings`, at that
 * booking's own property, so the order screen and the calendar tell the same
 * story about the same stay. `awaiting_approval` and `unpaid`, because the
 * organization's `approval_required_default` is true and its payment mode
 * asks nothing of the guest until somebody says yes.
 *
 * THE MONEY IS THE SNAPSHOT. `unit_price_agorot` is ₪1,500 — what the guest
 * agreed — and it stays ₪1,500 when somebody edits the catalogue on screen.
 * The order's own totals are what `tg_store_order_totals` would have written
 * from the lines: ₪1,500 + ₪400 for the larger table.
 */
const SEEDED_BOOKING = bookingAt(3)
const SEEDED_ORDER = orderIds(1)
const SEEDED_LINE = orderLineIds(1)

export const STORE_ORDER_ROWS: DemoRow[] = [
  {
    id: SEEDED_ORDER,
    organization_id: ORGANIZATION_ID,
    property_id: SEEDED_BOOKING.unit.propertyId,
    booking_id: SEEDED_BOOKING.id,
    guest_id: SEEDED_BOOKING.guestId,
    reference: 'S-260218-KQ7',
    source: 'guest_portal',
    status: 'awaiting_approval',
    payment_status: 'unpaid',
    payment_mode: 'with_booking',
    currency: 'ILS',
    subtotal_agorot: MARKET_TABLE_AGOROT + 40_000,
    discount_agorot: 0,
    tax_agorot: 0,
    total_agorot: MARKET_TABLE_AGOROT + 40_000,
    promo_code_id: null,
    promo_code_snapshot: null,
    requested_for_date: SEEDED_BOOKING.checkIn,
    requested_for_time: '16:00:00',
    guest_notes: 'אם אפשר בלי גבינות כחולות, תודה.',
    internal_notes: null,
    submission_key: null,
    approved_at: null,
    approved_by: null,
    confirmed_at: null,
    fulfilled_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    refunded_at: null,
    amendment_count: 0,
    metadata: {},
    ...stampedNoDelete(RECEPTION_ID, -3),
  },
]

export const STORE_ORDER_LINE_ROWS: DemoRow[] = [
  {
    id: SEEDED_LINE,
    organization_id: ORGANIZATION_ID,
    order_id: SEEDED_ORDER,
    item_id: STORE_ITEM_IDS.marketTable,
    package_id: null,
    item_name_snapshot: 'שולחן שוק',
    item_type_snapshot: 'experience',
    pricing_model_snapshot: 'fixed',
    unit_price_agorot: MARKET_TABLE_AGOROT,
    options_agorot: 40_000,
    addons_agorot: 0,
    line_discount_agorot: 0,
    quantity: 1,
    // A generated column in Postgres, returned by PostgREST like any other —
    // the same treatment `bookings.stay` gets in `dataset-bookings.ts`.
    line_total_agorot: MARKET_TABLE_AGOROT + 40_000,
    price_snapshot_at: momentOn(-3, '11:20'),
    price_source: 'catalogue',
    customization_answers: {},
    fulfilment_kind_snapshot: 'staff_task',
    fulfilment_recipe_snapshot: {
      taskType: 'guest_request',
      title: 'להכין שולחן שוק',
      dueOffsetHours: -3,
      checklist: [
        'לקנות במכולת ובמאפייה',
        'לסדר על השולחן בכניסה',
        'לצנן את היין',
      ],
      teamId: TEAM_IDS.housekeeping,
    },
    lead_time_hours_snapshot: 48,
    cancellation_policy_snapshot: { kind: 'free_until_hours', hoursBefore: 48 },
    provider_id: null,
    line_status: 'pending',
    notes: null,
    sort_order: 0,
    ...stampedNoDelete(RECEPTION_ID, -3),
  },
]

export const STORE_ORDER_LINE_OPTION_ROWS: DemoRow[] = [
  {
    id: orderLineOptionIds(1),
    organization_id: ORGANIZATION_ID,
    order_line_id: SEEDED_LINE,
    option_id: STORE_ITEM_OPTION_IDS.tableSize,
    option_value_id: STORE_ITEM_OPTION_VALUE_IDS.tableForEight,
    option_name_snapshot: 'גודל השולחן',
    value_label_snapshot: 'עד שמונה סועדים',
    price_delta_agorot: 40_000,
    sort_order: 0,
    created_at: momentOn(-3, '11:20'),
    created_by: RECEPTION_ID,
  },
]

/**
 * The booking this order hangs off, exported so a screen can be walked to it.
 *
 * The guest portal is reached by `bookings.guest_token`, which
 * `dataset-bookings.ts` generates; this is the index, so the walkthrough does
 * not have to guess which stay has a store order on it.
 */
export const STORE_DEMO_BOOKING_ID = SEEDED_BOOKING.id

/** Left to the product to write. See the header. */
export const STORE_PRICE_HISTORY_ROWS: DemoRow[] = []
export const STORE_ORDER_PAYMENT_ROWS: DemoRow[] = []
export const STORE_ORDER_AMENDMENT_ROWS: DemoRow[] = []
export const STORE_PROVIDER_REQUEST_ROWS: DemoRow[] = []
