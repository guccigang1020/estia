/**
 * The laundry, for the demo organization.
 *
 * ── Where the quantities come from, and the honest caveat ─────────────────
 *
 * In the product, a laundry order line's `calculated_quantity` is a canonical
 * preparation requirement that `src/lib/laundry/requirements.ts` filtered and
 * bundled. The demo cannot reproduce that chain, because `dataset.ts` leaves
 * the preparation tables declared and empty on purpose — they are written by
 * the product as it runs, and seeding them would be seeding the output of the
 * very code path the demo exists to exercise.
 *
 * So the figures below are derived here, in this fixture, from the real
 * bookings the dataset already holds — one linen set per sleeping guest, one
 * bath towel per guest, one hand towel per couple — and the `explanation`
 * column on each line says so in the same shape the engine produces. That is
 * standing in for preparation, and it is stated rather than hidden because the
 * alternative reading is that the demo proves the engine works. It does not.
 * `src/lib/laundry/requirements.test.ts` proves that.
 *
 * What the demo DOES exercise, honestly and completely: the five modes and
 * what each one renders, the per-property breakdown of a consolidated run, the
 * three-column quantity with a real adjustment and a real reason on one line,
 * a turnaround that genuinely cannot make its deadline, and the fact that a
 * cleaner reaches none of the provider rows.
 *
 * ── The organization runs `hybrid`, deliberately ──────────────────────────
 *
 * It is the only mode that renders every section, so the demo shows the whole
 * module rather than a subset — and it is the mode where the per-item routing
 * matters, which is the part of the configuration story that is hardest to
 * explain in prose and obvious on a screen.
 */

import type { DemoRow } from './types'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { PROPERTY_IDS } from './dataset-inventory'
import { BOOKINGS } from './dataset-bookings'
import { demoUuid, momentOn, stampedNoDelete } from './dataset-support'

/* ------------------------------------------------------------------ ids -- */

/**
 * Id groups for the five laundry tables.
 *
 * Numbered from 36, continuing `ID_GROUP` in `dataset-support.ts` rather than
 * being added to it — that file belongs to another owner, and `demoUuid` takes
 * a plain number precisely so a module can claim a range without editing it.
 * If these ever move into `ID_GROUP`, the values must stay the same or every
 * id in the demo changes.
 */
const GROUP = {
  provider: 36,
  itemProfile: 37,
  settings: 38,
  order: 39,
  orderLine: 40,
} as const

const providerIds = (index: number) => demoUuid(GROUP.provider, index)
const profileIds = (index: number) => demoUuid(GROUP.itemProfile, index)
const settingsIds = (index: number) => demoUuid(GROUP.settings, index)
const orderIds = (index: number) => demoUuid(GROUP.order, index)
const lineIds = (index: number) => demoUuid(GROUP.orderLine, index)

const OWNER_ID = person('owner').userId
const MANAGER_ID = person('general-manager').userId
const PROPERTY_MANAGER_ID = person('property-manager').userId

export const LAUNDRY_PROVIDER_IDS = {
  north: providerIds(1),
  express: providerIds(2),
} as const

/* ------------------------------------------------------------ providers -- */

export const LAUNDRY_PROVIDER_ROWS: DemoRow[] = [
  {
    id: LAUNDRY_PROVIDER_IDS.north,
    organization_id: ORGANIZATION_ID,
    name: 'מכבסת הצפון',
    contact_name: 'רונית לוי',
    phone: '04-6000000',
    email: 'ronit@mechbasat-tzafon.example',
    default_channel: 'whatsapp',
    turnaround_hours: 48,
    // Sunday and Wednesday, ISO weekday numbers.
    pickup_days: [3, 7],
    delivery_days: [1, 5],
    minimum_order_units: 40,
    price_list: {
      linen_set: { label: 'מערכת מצעים', unitAgorot: 1200 },
      towel_bath: { label: 'מגבת רחצה', unitAgorot: 350 },
      towel_hand: { label: 'מגבת ידיים', unitAgorot: 200 },
    },
    notes: 'אוספים מהחניה האחורית. לא עובדים בשישי אחר הצהריים.',
    is_active: true,
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -180),
    deleted_at: null,
  },
  {
    // The expensive one, kept for the weeks the first cannot make the
    // turnaround. A business with one provider has no decision to make, and a
    // demo with one provider cannot show the comparison the screen is for.
    id: LAUNDRY_PROVIDER_IDS.express,
    organization_id: ORGANIZATION_ID,
    name: 'אקספרס כביסה',
    contact_name: 'עופר',
    phone: '04-6111111',
    email: null,
    default_channel: 'sms',
    turnaround_hours: 12,
    pickup_days: [1, 2, 3, 4, 5, 7],
    delivery_days: [1, 2, 3, 4, 5, 7],
    minimum_order_units: 0,
    price_list: {
      linen_set: { label: 'מערכת מצעים', unitAgorot: 2400 },
      towel_bath: { label: 'מגבת רחצה', unitAgorot: 700 },
    },
    notes: 'יקר, אבל מחזירים באותו יום. לשימוש כשהזמן קצר.',
    is_active: true,
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -90),
    deleted_at: null,
  },
]

/* --------------------------------------------------------- item profiles -- */

/**
 * What this organization treats as laundry.
 *
 * THIS IS CONFIGURATION AND NOT A LIST IN CODE. It reads like an obvious list
 * of linen because it is one business's obvious list; the next customer's
 * differs, which is the whole reason `laundry_item_profiles` is a table.
 *
 * Note the last three rows. Toilet paper and coffee have profiles that say
 * "not laundry" rather than no row at all, because a manager who opens the
 * configuration screen and sees an item missing cannot tell whether it was
 * considered. The weighted blanket says "not washable", which is the fact that
 * stops it going in a machine.
 */
type ProfileSeed = {
  itemId: string
  label: string
  managed: boolean
  washable: boolean
  externalAllowed: boolean
  route: string | null
  provider: string | null
  turnaround: number | null
  unit: string
  bundle: number
  buffer: number
  notes: string | null
}

const PROFILE_SEEDS: readonly ProfileSeed[] = [
  {
    itemId: 'linen_set',
    label: 'מערכות מצעים',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'external',
    provider: LAUNDRY_PROVIDER_IDS.north,
    turnaround: 48,
    unit: 'set',
    bundle: 5,
    buffer: 2,
    notes: 'נשלח החוצה תמיד. המכונה בבית לא מתמודדת עם כיסויי פוך.',
  },
  {
    itemId: 'pillowcase',
    label: 'ציפיות',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'external',
    provider: LAUNDRY_PROVIDER_IDS.north,
    turnaround: null,
    unit: 'piece',
    bundle: 10,
    buffer: 4,
    notes: null,
  },
  {
    itemId: 'towel_bath',
    label: 'מגבות רחצה',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'external',
    provider: LAUNDRY_PROVIDER_IDS.north,
    turnaround: null,
    unit: 'piece',
    bundle: 1,
    buffer: 3,
    notes: null,
  },
  {
    // Washed in the utility room. This is what makes the organization hybrid
    // rather than external, and it is a real decision: hand towels come back
    // in a day and cost nothing to do in-house.
    itemId: 'towel_hand',
    label: 'מגבות ידיים',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'internal',
    provider: null,
    turnaround: 24,
    unit: 'piece',
    bundle: 1,
    buffer: 2,
    notes: 'נעשה במכונה של הבית.',
  },
  {
    itemId: 'towel_pool',
    label: 'מגבות בריכה',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'internal',
    provider: null,
    turnaround: 24,
    unit: 'piece',
    bundle: 1,
    buffer: 4,
    notes: null,
  },
  {
    itemId: 'bath_mat',
    label: 'שטיחוני אמבטיה',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'internal',
    provider: null,
    turnaround: 24,
    unit: 'piece',
    bundle: 1,
    buffer: 1,
    notes: null,
  },
  {
    itemId: 'robe',
    label: 'חלוקים',
    managed: true,
    washable: true,
    externalAllowed: true,
    route: 'external',
    provider: LAUNDRY_PROVIDER_IDS.north,
    turnaround: 48,
    unit: 'piece',
    bundle: 1,
    buffer: 1,
    notes: null,
  },
  {
    itemId: 'blanket_weighted',
    label: 'שמיכות כבדות',
    managed: false,
    washable: false,
    externalAllowed: false,
    route: null,
    provider: null,
    turnaround: null,
    unit: 'piece',
    bundle: 1,
    buffer: 0,
    notes: 'ניקוי יבש בלבד. לא נכנס לאף מכונה.',
  },
  {
    itemId: 'toilet_paper',
    label: 'נייר טואלט',
    managed: false,
    washable: false,
    externalAllowed: false,
    route: null,
    provider: null,
    turnaround: null,
    unit: 'pack',
    bundle: 1,
    buffer: 0,
    notes: 'מתכלה. מופיע ברשימת ההכנה, לא בכביסה.',
  },
  {
    itemId: 'coffee',
    label: 'קפה',
    managed: false,
    washable: false,
    externalAllowed: false,
    route: null,
    provider: null,
    turnaround: null,
    unit: 'pack',
    bundle: 1,
    buffer: 0,
    notes: 'מתכלה.',
  },
]

export const LAUNDRY_ITEM_PROFILE_ROWS: DemoRow[] = PROFILE_SEEDS.map(
  (seed, index) => ({
    id: profileIds(index + 1),
    organization_id: ORGANIZATION_ID,
    item_id: seed.itemId,
    label: seed.label,
    laundry_managed: seed.managed,
    washable: seed.washable,
    external_laundry_allowed: seed.externalAllowed,
    route: seed.route,
    default_provider_id: seed.provider,
    turnaround_hours: seed.turnaround,
    unit: seed.unit,
    bundle_size: seed.bundle,
    minimum_buffer: seed.buffer,
    notes: seed.notes,
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -180),
  }),
)

/* ------------------------------------------------------------- settings -- */

export const LAUNDRY_SETTINGS_ROWS: DemoRow[] = [
  {
    id: settingsIds(1),
    organization_id: ORGANIZATION_ID,
    property_id: null,
    mode: 'hybrid',
    dispatch_mode: 'approval_required',
    default_channel: 'whatsapp',
    default_provider_id: LAUNDRY_PROVIDER_IDS.north,
    turnaround_hours: 48,
    pickup_days: [3, 7],
    delivery_days: [1, 5],
    forecast_horizon_days: 7,
    standing_notes: 'הכניסה מהחניה האחורית. לתאם מראש בשישי.',
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -180),
  },
  {
    // A property override, whole rather than per column — see the header of
    // `src/lib/laundry/settings.ts` for why the fallback is not per field.
    // כחול ים is small and sends everything out.
    id: settingsIds(2),
    organization_id: ORGANIZATION_ID,
    property_id: PROPERTY_IDS.kacholYam,
    mode: 'external',
    dispatch_mode: 'approval_required',
    default_channel: 'whatsapp',
    default_provider_id: LAUNDRY_PROVIDER_IDS.north,
    turnaround_hours: 48,
    pickup_days: [3, 7],
    delivery_days: [1, 5],
    forecast_horizon_days: 14,
    standing_notes: null,
    metadata: {},
    ...stampedNoDelete(PROPERTY_MANAGER_ID, -60),
  },
]

/* --------------------------------------------------------------- orders -- */

/**
 * Standing in for preparation.
 *
 * One linen set and one bath towel per guest, one hand towel per couple. These
 * are the shapes preparation's own rules take, computed here because the demo
 * has no preparation plans — see the header. Every figure a screen shows comes
 * with the `explanation` chain below, in the same shape the engine produces,
 * so the explainability the module promises is genuinely visible in the demo.
 */
type LineSeed = {
  itemId: string
  label: string
  unit: string
  /** What preparation would have said, before the laundry buffer. */
  base: number
  buffer: number
  bundle: number
}

function linesForGuests(guests: number, external: boolean): LineSeed[] {
  const couples = Math.ceil(guests / 2)

  return external
    ? [
        {
          itemId: 'linen_set',
          label: 'מערכות מצעים',
          unit: 'set',
          base: guests,
          buffer: 2,
          bundle: 5,
        },
        {
          itemId: 'towel_bath',
          label: 'מגבות רחצה',
          unit: 'piece',
          base: guests,
          buffer: 3,
          bundle: 1,
        },
      ]
    : [
        {
          itemId: 'towel_hand',
          label: 'מגבות ידיים',
          unit: 'piece',
          base: couples,
          buffer: 2,
          bundle: 1,
        },
        {
          itemId: 'towel_pool',
          label: 'מגבות בריכה',
          unit: 'piece',
          base: guests,
          buffer: 4,
          bundle: 1,
        },
      ]
}

/** Rounded up to whole bundles, exactly as `requirements.ts` does it. */
function calculated(seed: LineSeed): number {
  return Math.ceil((seed.base + seed.buffer) / seed.bundle) * seed.bundle
}

/** The chain, in the shape `ExplanationStep` declares. */
function explanationFor(seed: LineSeed): unknown[] {
  const needed = seed.base + seed.buffer
  const quantity = calculated(seed)
  const steps: unknown[] = [
    {
      kind: 'preparation',
      text: `${seed.base} ${seed.label} — לפי כללי ההכנה של העסק.`,
      value: seed.base,
    },
  ]

  if (seed.buffer > 0) {
    steps.push({
      kind: 'laundry_buffer',
      text: `${needed} אחרי מרווח הכביסה (${seed.buffer} נוספים לפריטים שחוזרים פגומים).`,
      value: needed,
    })
  }

  if (seed.bundle > 1) {
    steps.push({
      kind: 'bundle',
      text: `${quantity} — ${quantity / seed.bundle} חבילות של ${seed.bundle}, מעוגל כלפי מעלה.`,
      value: quantity,
    })
  }

  return steps
}

/**
 * The runs the demo shows.
 *
 * Chosen so the dashboard has something in every column: one sent and coming
 * back, one waiting to be approved, one internal batch in the machine now, one
 * that is genuinely late, and one consolidated across both properties with the
 * breakdown intact.
 */
type OrderSeed = {
  index: number
  properties: readonly string[]
  provider: string | null
  route: 'internal' | 'external'
  status: string
  /** Days from today the linen is needed. */
  requiredOffset: number
  pickupOffset: number | null
  sentOffset: number | null
  guestsPerProperty: number
  internalNotes: string | null
  providerNotes: string | null
  /** Applied to the first line, with a reason. */
  adjustment: { amount: number; reason: string } | null
}

const ORDER_SEEDS: readonly OrderSeed[] = [
  {
    // Consolidated: one van, both houses, breakdown preserved on the lines.
    index: 1,
    properties: [PROPERTY_IDS.rimonim, PROPERTY_IDS.kacholYam],
    provider: LAUNDRY_PROVIDER_IDS.north,
    route: 'external',
    status: 'collected',
    requiredOffset: 2,
    pickupOffset: -1,
    sentOffset: -2,
    guestsPerProperty: 12,
    internalNotes: 'לתאם עם רונית שהאיסוף מהחניה האחורית.',
    providerNotes: 'שתי כתובות באותו איסוף. מצורף פירוט לכל בית.',
    adjustment: null,
  },
  {
    // Waiting for somebody to press send. The default dispatch mode is
    // `approval_required` and this is what that looks like.
    index: 2,
    properties: [PROPERTY_IDS.rimonim],
    provider: LAUNDRY_PROVIDER_IDS.north,
    route: 'external',
    status: 'awaiting_approval',
    requiredOffset: 5,
    pickupOffset: 3,
    sentOffset: null,
    guestsPerProperty: 18,
    internalNotes: null,
    providerNotes: null,
    adjustment: {
      amount: 5,
      reason: 'אירוע גדול בסוף השבוע, מרווח נוסף מעבר לחישוב.',
    },
  },
  {
    // In the utility room, now. The internal half of `hybrid`.
    index: 3,
    properties: [PROPERTY_IDS.rimonim],
    provider: null,
    route: 'internal',
    status: 'washing',
    requiredOffset: 1,
    pickupOffset: 0,
    sentOffset: null,
    guestsPerProperty: 10,
    internalNotes: 'ורד התחילה בבוקר.',
    providerNotes: null,
    adjustment: null,
  },
  {
    // Late. It was needed yesterday and it is not back.
    index: 4,
    properties: [PROPERTY_IDS.kacholYam],
    provider: LAUNDRY_PROVIDER_IDS.north,
    route: 'external',
    status: 'washing',
    requiredOffset: -1,
    pickupOffset: -3,
    sentOffset: -4,
    guestsPerProperty: 8,
    internalNotes: 'התקשרתי פעמיים. אמרו מחר בבוקר.',
    providerNotes: null,
    adjustment: null,
  },
  {
    // Back at the property and finished, so the dashboard has a completed row
    // and the history is not empty.
    index: 5,
    properties: [PROPERTY_IDS.rimonim],
    provider: LAUNDRY_PROVIDER_IDS.north,
    route: 'external',
    status: 'completed',
    requiredOffset: -6,
    pickupOffset: -9,
    sentOffset: -10,
    guestsPerProperty: 14,
    internalNotes: null,
    providerNotes: null,
    adjustment: null,
  },
]

/** A booking at this property, if the dataset has one, for `source_booking_id`. */
function bookingAt(propertyId: string): string | null {
  const match = BOOKINGS.find(
    (booking) =>
      booking.unit.propertyId === propertyId && booking.status === 'confirmed',
  )
  return match?.id ?? null
}

const orderRows: DemoRow[] = []
const orderLineRows: DemoRow[] = []
let lineCounter = 0

for (const seed of ORDER_SEEDS) {
  const orderId = orderIds(seed.index)
  const requiredBy = momentOn(seed.requiredOffset, '14:00')
  const consolidated = seed.properties.length > 1

  orderRows.push({
    id: orderId,
    organization_id: ORGANIZATION_ID,
    // NULL when the run spans more than one property. The breakdown lives on
    // the lines and is never collapsed into a total.
    property_id: consolidated ? null : (seed.properties[0] ?? null),
    provider_id: seed.provider,
    status: seed.status,
    mode: seed.route,
    dispatch_mode: 'approval_required',
    channel: 'whatsapp',
    reference: `L${momentOn(seed.requiredOffset, '00:00').slice(0, 10).split('-').join('')}-${orderId.slice(0, 8).toUpperCase()}`,
    requirement_key: `demo-${orderId}`,
    required_by: requiredBy,
    pickup_at:
      seed.pickupOffset === null ? null : momentOn(seed.pickupOffset, '07:00'),
    expected_return_at:
      seed.pickupOffset === null
        ? null
        : momentOn(seed.pickupOffset + 2, '16:00'),
    returned_at:
      seed.status === 'completed'
        ? momentOn(seed.requiredOffset, '11:00')
        : null,
    sent_at:
      seed.sentOffset === null ? null : momentOn(seed.sentOffset, '09:30'),
    sent_by: seed.sentOffset === null ? null : MANAGER_ID,
    sent_body:
      seed.sentOffset === null
        ? null
        : `שלום, כאן אחוזת הגליל.\n\nהזמנת כביסה\n\nנדרש עד: ${requiredBy}`,
    internal_notes: seed.internalNotes,
    provider_notes: seed.providerNotes,
    metadata: {},
    ...stampedNoDelete(MANAGER_ID, seed.sentOffset ?? seed.requiredOffset - 3),
  })

  for (const propertyId of seed.properties) {
    const seeds = linesForGuests(
      seed.guestsPerProperty,
      seed.route === 'external',
    )

    seeds.forEach((line, position) => {
      lineCounter += 1
      const adjust =
        seed.adjustment !== null && position === 0 ? seed.adjustment : null

      orderLineRows.push({
        id: lineIds(lineCounter),
        organization_id: ORGANIZATION_ID,
        order_id: orderId,
        property_id: propertyId,
        item_id: line.itemId,
        label: line.label,
        unit: line.unit,
        calculated_quantity: calculated(line),
        adjustment_quantity: adjust?.amount ?? 0,
        // `final_quantity` is a generated column in Postgres. The demo client
        // does not compute generated columns, so it is written here to the
        // value the database would have produced — and it is the ONLY place in
        // this file where a number is stated twice, which is why it is
        // computed from the same two inputs rather than typed out.
        final_quantity: calculated(line) + (adjust?.amount ?? 0),
        adjustment_reason: adjust?.reason ?? null,
        adjusted_by: adjust === null ? null : MANAGER_ID,
        adjusted_at:
          adjust === null ? null : momentOn(seed.requiredOffset - 2, '10:00'),
        explanation: explanationFor(line),
        source_booking_id: bookingAt(propertyId),
        required_by: momentOn(seed.requiredOffset, '14:00'),
        notes: null,
        ...stampedNoDelete(MANAGER_ID, seed.requiredOffset - 3),
      })
    })
  }
}

export const LAUNDRY_ORDER_ROWS: DemoRow[] = orderRows
export const LAUNDRY_ORDER_LINE_ROWS: DemoRow[] = orderLineRows
