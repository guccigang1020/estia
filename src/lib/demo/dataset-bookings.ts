/**
 * Guests, stays, and the rows a stay drags behind it.
 *
 * ── The stays are laid out by hand, and that is deliberate ────────────────
 *
 * `STAYS` is a table of `(unit, first night, nights)` written out in full
 * rather than generated from a loop. Two constraints make a generator the
 * wrong tool here:
 *
 *   1. `unit_occupancy` carries an exclusion constraint — one unit cannot be
 *      occupied twice over the same night. A hand-written table can be read
 *      and checked; a generator that drifts into an overlap produces a
 *      dataset that would be rejected by the database it claims to imitate.
 *
 *   2. The demo has to show a specific set of situations *today*: somebody
 *      mid-stay, somebody arriving this afternoon, somebody leaving this
 *      morning. Those three are written first and everything else fills in
 *      around them, because an arrivals board with nothing on it is not a
 *      demonstration of an arrivals board.
 *
 * The offsets are days from today, resolved when the module loads. Nothing
 * here is a fixed date.
 *
 * ── Status follows the calendar ───────────────────────────────────────────
 *
 * A stay that ended last week is not "confirmed", and a stay starting in
 * seven weeks is not "checked in". `statusFor` derives the status from where
 * the stay sits relative to today, so the dataset stays true on any day it is
 * loaded rather than only on the day it was written.
 *
 * ── Money is computed, never typed twice ──────────────────────────────────
 *
 * `total_agorot` on the booking is the sum of its own price lines, and each
 * line is computed from the unit's own rates. The alternative — a total typed
 * beside a list of lines — is the defect this product exists to prevent, and
 * shipping it in the demo would be teaching it.
 */

import type { DemoRow } from './types'
import {
  AGENCY_ID,
  ID_GROUP,
  dateRange,
  day,
  demoUuid,
  idsFor,
  momentOn,
  stamped,
  stampedNoDelete,
} from './dataset-support'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { unit, type DemoUnit } from './dataset-inventory'

const guestIds = idsFor(ID_GROUP.guest)
const bookingIds = idsFor(ID_GROUP.booking)
const historyIds = idsFor(ID_GROUP.statusHistory)
const priceLineIds = idsFor(ID_GROUP.priceLine)
const holdIds = idsFor(ID_GROUP.hold)
const occupancyIds = idsFor(ID_GROUP.occupancy)

const RECEPTION_ID = person('reception').userId
const AGENT_ID = person('sales-agent').userId
const MANAGER_ID = person('general-manager').userId

/* ------------------------------------------------------------ guests ----- */

type GuestSeed = {
  name: string
  email: string | null
  phone: string
  city: string
  tags: readonly string[]
  consent: boolean
  /**
   * What the desk wrote down about this person.
   *
   * Seeded on a handful rather than on everybody, and the ratio is the point:
   * a guest card whose notes panel is always full never demonstrates the empty
   * state, and one that is always empty leaves a whole panel undemonstrated.
   *
   * `guests.notes` has no field-level grant of its own — unlike
   * `bookings.internal_notes`, which `booking.note.internal` guards — so
   * whatever is written here is read by anybody holding `guest.view`. The text
   * is written with that in mind: operational, never a judgement about the
   * person.
   */
  notes?: string
  /**
   * An identity document, on the two guests who arrived with a passport.
   *
   * `guest.view_document_id` is a grant no shipped preset in `roles.ts`
   * carries, which is the schema's stated intent — "almost no role needs to
   * see this". That is exactly why these are seeded: a redaction with nothing
   * behind it proves nothing, and the test beside the guest screens asserts
   * that even the owner does not receive the number.
   *
   * `guests_id_document_type` allows only these four values, and
   * `guests_country_format` requires two upper-case letters.
   */
  document?: {
    type: 'id_card' | 'passport' | 'driver_license' | 'other'
    number: string
    country: string
  }
}

const GUEST_SEEDS: readonly GuestSeed[] = [
  {
    name: 'תמר גולדשטיין',
    email: 'tamar.g@gmail.com',
    phone: '+972 54-220-1188',
    city: 'תל אביב',
    tags: ['חוזרת'],
    consent: true,
    notes: 'מעדיפה קומה עליונה ושקט. הגיעה שלוש פעמים, תמיד באמצע השבוע.',
  },
  {
    name: 'אורי בן-דוד',
    email: 'uri.bendavid@outlook.com',
    phone: '+972 52-771-3390',
    city: 'מודיעין',
    tags: [],
    consent: false,
  },
  {
    name: 'שירין מנסור',
    email: 'shireen.m@gmail.com',
    phone: '+972 50-664-2214',
    city: 'חיפה',
    tags: ['ירח דבש'],
    consent: true,
    notes: 'אלרגיה לאגוזים — לעדכן את הניקיון לפני סידור סל הקבלה.',
  },
  {
    name: 'יעל ורדי',
    email: 'yael.vardi@gmail.com',
    phone: '+972 53-889-0071',
    city: 'רעננה',
    tags: [],
    consent: true,
  },
  {
    name: 'משה אלפסי',
    email: null,
    phone: '+972 52-334-9910',
    city: 'ירושלים',
    tags: ['ללא אימייל'],
    consent: false,
  },
  {
    name: 'נטע רוזנברג',
    email: 'neta.r@walla.co.il',
    phone: '+972 54-118-7723',
    city: 'גבעתיים',
    tags: ['חוזרת'],
    consent: true,
  },
  {
    name: 'ג׳ורג׳ חורי',
    email: 'george.khoury@gmail.com',
    phone: '+972 50-990-4417',
    city: 'נצרת',
    tags: [],
    consent: true,
  },
  {
    name: 'אלכס פטרוב',
    email: 'alex.petrov@gmail.com',
    phone: '+972 53-221-6605',
    city: 'אשדוד',
    tags: [],
    consent: false,
  },
  {
    name: 'רותם אשכנזי',
    email: 'rotem.ash@gmail.com',
    phone: '+972 52-447-8812',
    city: 'הרצליה',
    tags: ['משפחה'],
    consent: true,
  },
  {
    name: 'דניאל שגב',
    email: 'daniel.segev@gmail.com',
    phone: '+972 54-006-3329',
    city: 'כפר סבא',
    tags: [],
    consent: true,
  },
  {
    name: 'לינוי כרמלי',
    email: 'linoy.c@gmail.com',
    phone: '+972 50-773-1140',
    city: 'ראשון לציון',
    tags: [],
    consent: false,
  },
  {
    name: 'עומר צדוק',
    email: 'omer.tsadok@gmail.com',
    phone: '+972 52-885-2276',
    city: 'באר שבע',
    tags: [],
    consent: true,
  },
  {
    name: 'הדס בן-שמעון',
    email: 'hadas.bs@gmail.com',
    phone: '+972 53-441-9903',
    city: 'זכרון יעקב',
    tags: ['מקומית'],
    consent: true,
  },
  {
    name: 'איתי לרנר',
    email: 'itay.lerner@gmail.com',
    phone: '+972 54-330-5518',
    city: 'פתח תקווה',
    tags: [],
    consent: false,
  },
  {
    name: 'מאיה אזולאי',
    email: 'maya.azoulay@gmail.com',
    phone: '+972 50-227-6634',
    city: 'נתניה',
    tags: ['חוזרת'],
    consent: true,
  },
  {
    name: 'ניר ברקוביץ׳',
    email: 'nir.b@gmail.com',
    phone: '+972 52-119-4450',
    city: 'רמת גן',
    tags: [],
    consent: true,
  },
  {
    name: 'סיוון דהן',
    email: 'sivan.dahan@gmail.com',
    phone: '+972 53-668-7791',
    city: 'אשקלון',
    tags: [],
    consent: false,
  },
  {
    name: 'רון קפלן',
    email: 'ron.kaplan@gmail.com',
    phone: '+972 54-772-0026',
    city: 'תל אביב',
    tags: ['עסקי'],
    consent: true,
  },
  {
    name: 'עדי מלכה',
    email: 'adi.malka@gmail.com',
    phone: '+972 50-338-1162',
    city: 'חולון',
    tags: [],
    consent: true,
  },
  {
    name: 'ליאור חדד',
    email: 'lior.haddad@gmail.com',
    phone: '+972 52-990-5583',
    city: 'עפולה',
    tags: [],
    consent: false,
  },
  {
    name: 'Sophie Laurent',
    email: 'sophie.laurent@free.fr',
    phone: '+33 6 12 44 90 21',
    city: 'Lyon',
    tags: ['תייר'],
    consent: true,
    notes: 'מדברת אנגלית בלבד. ביקשה הוראות הגעה בכתב לפני הנחיתה.',
    document: { type: 'passport', number: '19FR84221', country: 'FR' },
  },
  {
    name: 'Michael Brennan',
    email: 'm.brennan@gmail.com',
    phone: '+44 7700 900412',
    city: 'Manchester',
    tags: ['תייר'],
    consent: true,
    document: { type: 'passport', number: '533901882', country: 'GB' },
  },
  {
    name: 'נועם אלימלך',
    email: 'noam.e@gmail.com',
    phone: '+972 54-556-2287',
    city: 'קריית טבעון',
    tags: [],
    consent: true,
  },
  {
    name: 'אביגיל שטרית',
    email: 'avigail.s@gmail.com',
    phone: '+972 50-118-3345',
    city: 'בית שאן',
    tags: [],
    consent: false,
  },
  {
    name: 'תום פרידמן',
    email: 'tom.friedman@gmail.com',
    phone: '+972 53-224-9968',
    city: 'רחובות',
    tags: ['משפחה'],
    consent: true,
  },
  {
    name: 'שקד ניסים',
    email: 'shaked.n@gmail.com',
    phone: '+972 52-667-4413',
    city: 'צפת',
    tags: [],
    consent: true,
  },
]

/**
 * One guest the business will not take again.
 *
 * `is_blocked` with a reason exists on this table for a reason, and a dataset
 * with no blocked guest never exercises the screen that has to say so.
 */
const BLOCKED_GUEST: GuestSeed = {
  name: 'ע. ג׳ריס',
  email: null,
  phone: '+972 52-000-1199',
  city: 'לא ידוע',
  tags: ['חסום'],
  consent: false,
  notes: 'לא לאשר הזמנה חדשה בלי אישור של מנהל הנכס.',
}

const ALL_GUESTS: readonly GuestSeed[] = [...GUEST_SEEDS, BLOCKED_GUEST]

export const GUEST_ROWS: DemoRow[] = ALL_GUESTS.map((seed, index) => {
  const blocked = seed === BLOCKED_GUEST
  const [first, ...rest] = seed.name.split(' ')
  return {
    id: guestIds(index + 1),
    organization_id: ORGANIZATION_ID,
    full_name: seed.name,
    first_name: first,
    last_name: rest.join(' ') || null,
    email: seed.email,
    phone: seed.phone,
    // A generated column: Postgres computes it and PostgREST returns it, so a
    // dataset that omitted it would be a shape the product never receives.
    phone_e164: seed.phone.replace(/[^\d+]/g, ''),
    phone_alt: null,
    language: seed.city === 'Lyon' || seed.city === 'Manchester' ? 'en' : 'he',
    nationality:
      seed.city === 'Lyon' ? 'FR' : seed.city === 'Manchester' ? 'GB' : 'IL',
    date_of_birth: null,
    id_document_type: seed.document?.type ?? null,
    id_document_number: seed.document?.number ?? null,
    id_document_country: seed.document?.country ?? null,
    address_line1: null,
    city: seed.city,
    postal_code: null,
    country:
      seed.city === 'Lyon' ? 'FR' : seed.city === 'Manchester' ? 'GB' : 'IL',
    tags: [...seed.tags],
    notes: seed.notes ?? null,
    marketing_consent: seed.consent,
    marketing_consent_at: seed.consent ? momentOn(-200, '11:00') : null,
    is_blocked: blocked,
    blocked_reason: blocked ? 'נזק שלא שולם ביוני, ושתי שיחות שלא נענו.' : null,
    metadata: {},
    ...stamped(RECEPTION_ID, -180),
  }
})

const guestIdAt = (index: number): string =>
  guestIds((index % GUEST_SEEDS.length) + 1)

/* ------------------------------------------------------------- stays ----- */

type StaySpec = {
  unitCode: string
  /** First night, as days from today. */
  start: number
  nights: number
  guest: number
  adults: number
  children: number
  infants: number
  source: string
  /** Set only where the calendar cannot decide it — cancellations, no-shows. */
  status?: string
  discountPercent?: number
  /** Excluded from `unit_occupancy`: a cancelled stay releases the room. */
  releasesRoom?: boolean
}

/**
 * Every stay in the demo, unit by unit, in date order.
 *
 * Read down a unit's block and the gaps between `start + nights` and the next
 * `start` are the nights that unit is free. That is the property the
 * exclusion constraint enforces in Postgres, and it is checked here by the
 * test rather than trusted.
 */
const STAYS: readonly StaySpec[] = [
  // ── RIM-01 · סוויטת הזית ────────────────────────────────────────────────
  {
    unitCode: 'RIM-01',
    start: -46,
    nights: 3,
    guest: 0,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'RIM-01',
    start: -30,
    nights: 3,
    guest: 5,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'airbnb',
  },
  {
    unitCode: 'RIM-01',
    start: -12,
    nights: 3,
    guest: 10,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  // Mid-stay right now. The one row an arrivals board and an in-house list
  // must both be able to find.
  {
    unitCode: 'RIM-01',
    start: -2,
    nights: 4,
    guest: 2,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'RIM-01',
    start: 9,
    nights: 3,
    guest: 14,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'booking_com',
  },
  {
    unitCode: 'RIM-01',
    start: 26,
    nights: 3,
    guest: 17,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'agent',
    discountPercent: 5,
  },
  {
    unitCode: 'RIM-01',
    start: 47,
    nights: 4,
    guest: 20,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },

  // ── RIM-02 · בקתת הרימון ────────────────────────────────────────────────
  {
    unitCode: 'RIM-02',
    start: -38,
    nights: 3,
    guest: 8,
    adults: 2,
    children: 2,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'RIM-02',
    start: -20,
    nights: 3,
    guest: 24,
    adults: 2,
    children: 1,
    infants: 1,
    source: 'booking_com',
  },
  {
    unitCode: 'RIM-02',
    start: -5,
    nights: 2,
    guest: 13,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  // Arriving today.
  {
    unitCode: 'RIM-02',
    start: 0,
    nights: 3,
    guest: 3,
    adults: 2,
    children: 2,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'RIM-02',
    start: 14,
    nights: 2,
    guest: 19,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'airbnb',
  },
  {
    unitCode: 'RIM-02',
    start: 33,
    nights: 3,
    guest: 22,
    adults: 2,
    children: 2,
    infants: 0,
    source: 'agent',
  },
  {
    unitCode: 'RIM-02',
    start: 55,
    nights: 3,
    guest: 6,
    adults: 2,
    children: 1,
    infants: 0,
    source: 'direct_website',
  },

  // ── RIM-03 · סוויטת התאנה ───────────────────────────────────────────────
  {
    unitCode: 'RIM-03',
    start: -44,
    nights: 4,
    guest: 4,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'RIM-03',
    start: -25,
    nights: 3,
    guest: 15,
    adults: 2,
    children: 1,
    infants: 0,
    source: 'agent',
    discountPercent: 5,
  },
  // Checking out this morning.
  {
    unitCode: 'RIM-03',
    start: -3,
    nights: 3,
    guest: 9,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'booking_com',
  },
  {
    unitCode: 'RIM-03',
    start: 5,
    nights: 3,
    guest: 25,
    adults: 2,
    children: 1,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'RIM-03',
    start: 21,
    nights: 3,
    guest: 1,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'agent',
    discountPercent: 8,
  },
  {
    unitCode: 'RIM-03',
    start: 40,
    nights: 4,
    guest: 21,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },

  // ── RIM-04 · חדר הגפן ───────────────────────────────────────────────────
  {
    unitCode: 'RIM-04',
    start: -33,
    nights: 2,
    guest: 11,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_manual',
  },
  // Booked, paid the deposit, and never arrived.
  {
    unitCode: 'RIM-04',
    start: -22,
    nights: 2,
    guest: 16,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'airbnb',
    status: 'no_show',
  },
  {
    unitCode: 'RIM-04',
    start: -15,
    nights: 2,
    guest: 18,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'RIM-04',
    start: 2,
    nights: 2,
    guest: 7,
    adults: 1,
    children: 0,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'RIM-04',
    start: 17,
    nights: 2,
    guest: 12,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'booking_com',
  },
  {
    unitCode: 'RIM-04',
    start: 36,
    nights: 2,
    guest: 23,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },

  // ── KAY-01 · וילה כחול ים ───────────────────────────────────────────────
  {
    unitCode: 'KAY-01',
    start: -41,
    nights: 5,
    guest: 8,
    adults: 8,
    children: 3,
    infants: 1,
    source: 'direct_manual',
  },
  {
    unitCode: 'KAY-01',
    start: -18,
    nights: 4,
    guest: 17,
    adults: 6,
    children: 2,
    infants: 0,
    source: 'agent',
  },
  // In house, and the largest number on the board.
  {
    unitCode: 'KAY-01',
    start: -1,
    nights: 5,
    guest: 24,
    adults: 9,
    children: 3,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'KAY-01',
    start: 11,
    nights: 4,
    guest: 21,
    adults: 8,
    children: 0,
    infants: 0,
    source: 'agent',
    discountPercent: 6,
  },
  {
    unitCode: 'KAY-01',
    start: 30,
    nights: 5,
    guest: 6,
    adults: 8,
    children: 4,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'KAY-01',
    start: 52,
    nights: 5,
    guest: 9,
    adults: 10,
    children: 2,
    infants: 0,
    source: 'direct_manual',
  },

  // ── KAY-02 · יחידת האורחים ──────────────────────────────────────────────
  {
    unitCode: 'KAY-02',
    start: -28,
    nights: 2,
    guest: 12,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'KAY-02',
    start: -8,
    nights: 2,
    guest: 3,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_manual',
  },
  {
    unitCode: 'KAY-02',
    start: 6,
    nights: 3,
    guest: 20,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'booking_com',
  },
  {
    unitCode: 'KAY-02',
    start: 23,
    nights: 3,
    guest: 15,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'direct_website',
  },
  {
    unitCode: 'KAY-02',
    start: 45,
    nights: 3,
    guest: 2,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'airbnb',
  },

  // ── Cancelled, and therefore holding nothing ────────────────────────────
  // Both sit on nights another booking now occupies, which is what actually
  // happens: the room was released and re-sold. They carry no occupancy row,
  // so the exclusion constraint they would otherwise violate is satisfied.
  {
    unitCode: 'RIM-01',
    start: -12,
    nights: 3,
    guest: 19,
    adults: 2,
    children: 0,
    infants: 0,
    source: 'booking_com',
    status: 'cancelled',
    releasesRoom: true,
  },
  {
    unitCode: 'KAY-01',
    start: 30,
    nights: 5,
    guest: 13,
    adults: 8,
    children: 2,
    infants: 0,
    source: 'agent',
    status: 'cancelled',
    releasesRoom: true,
  },
]

/* -------------------------------------------------- derived quantities --- */

/** Where a stay sits relative to today, and therefore what it is called. */
function statusFor(spec: StaySpec, index: number): string {
  if (spec.status) return spec.status

  const end = spec.start + spec.nights

  if (end < 0) {
    // Finished. Most are completed; a few are still working through the tail
    // of the flow, which is what those statuses are for.
    const tail = ['completed', 'checked_out', 'completed', 'review_requested']
    return tail[index % tail.length]
  }
  if (end === 0) return 'checkout_pending'
  if (spec.start === 0) return 'ready_for_check_in'
  if (spec.start < 0) return 'in_house'
  if (spec.start <= 3) return 'pre_arrival'
  if (spec.start <= 14) return 'confirmed'
  if (spec.start <= 40) return index % 3 === 0 ? 'deposit_paid' : 'confirmed'
  const far = ['option', 'awaiting_payment', 'quote']
  return far[index % far.length]
}

type PriceLine = {
  kind: string
  label: string
  amountAgorot: number
  quantity: string
}

/** The lines a stay is made of, from the unit's own rates. */
function linesFor(spec: StaySpec, room: DemoUnit): readonly PriceLine[] {
  const lines: PriceLine[] = [
    {
      kind: 'accommodation',
      label: `לינה · ${spec.nights} לילות`,
      amountAgorot: room.baseAgorot * spec.nights,
      quantity: spec.nights.toFixed(3),
    },
  ]

  const extraGuests = Math.max(
    spec.adults + spec.children - room.standardGuests,
    0,
  )
  if (extraGuests > 0 && room.extraGuestAgorot > 0) {
    lines.push({
      kind: 'extra_guest',
      label: `אורח נוסף · ${extraGuests} × ${spec.nights} לילות`,
      amountAgorot: room.extraGuestAgorot * extraGuests * spec.nights,
      quantity: (extraGuests * spec.nights).toFixed(3),
    })
  }

  lines.push({
    kind: 'cleaning_fee',
    label: 'דמי ניקיון',
    amountAgorot: room.cleaningAgorot,
    quantity: '1.000',
  })

  if (spec.discountPercent) {
    const before = lines.reduce((sum, line) => sum + line.amountAgorot, 0)
    lines.push({
      kind: 'discount',
      label: `הנחת סוכן · ${spec.discountPercent}%`,
      // The sign constraint on this table: a discount is negative money.
      amountAgorot: -Math.round((before * spec.discountPercent) / 100),
      quantity: '1.000',
    })
  }

  return lines
}

/** Everything the rest of the dataset needs to know about one stay. */
export type DemoBooking = {
  id: string
  reference: string
  unit: DemoUnit
  guestId: string
  guestName: string
  checkIn: string
  checkOut: string
  startOffset: number
  nights: number
  status: string
  source: string
  agentUserId: string | null
  totalAgorot: number
  lines: readonly PriceLine[]
  occupies: boolean
  adults: number
  children: number
  infants: number
}

export const BOOKINGS: readonly DemoBooking[] = STAYS.map((spec, index) => {
  const room = unit(spec.unitCode)
  const lines = linesFor(spec, room)
  const status = statusFor(spec, index)
  return {
    id: bookingIds(index + 1),
    reference: `B${(0xa1b2c000 + index * 7919).toString(16).toUpperCase()}`,
    unit: room,
    guestId: guestIdAt(spec.guest),
    guestName: GUEST_SEEDS[spec.guest % GUEST_SEEDS.length].name,
    checkIn: day(spec.start),
    checkOut: day(spec.start + spec.nights),
    startOffset: spec.start,
    nights: spec.nights,
    status,
    source: spec.source,
    agentUserId: spec.source === 'agent' ? AGENT_ID : null,
    totalAgorot: lines.reduce((sum, line) => sum + line.amountAgorot, 0),
    lines,
    occupies: spec.releasesRoom !== true,
    adults: spec.adults,
    children: spec.children,
    infants: spec.infants,
  }
})

/** A booking by reference index, for the modules that hang rows off one. */
export function bookingAt(index: number): DemoBooking {
  const found = BOOKINGS[index]
  if (!found) throw new Error(`Demo dataset: no booking at index ${index}`)
  return found
}

/** Bookings whose money is real: not a quote, not an option, not cancelled. */
export const SOLD_BOOKINGS: readonly DemoBooking[] = BOOKINGS.filter(
  (booking) =>
    !['quote', 'option', 'inquiry', 'awaiting_payment', 'cancelled'].includes(
      booking.status,
    ),
)

/* --------------------------------------------------------------- rows ---- */

/** Who entered the booking. An agent's booking was entered by the agent. */
function enteredBy(booking: DemoBooking): string {
  return booking.agentUserId ?? RECEPTION_ID
}

/** How long before arrival the booking was made — never after it. */
function bookedOffset(booking: DemoBooking): number {
  return booking.startOffset - (14 + (booking.nights % 5) * 3)
}

export const BOOKING_ROWS: DemoRow[] = BOOKINGS.map((booking, index) => ({
  id: booking.id,
  organization_id: ORGANIZATION_ID,
  property_id: booking.unit.propertyId,
  unit_id: booking.unit.id,
  guest_id: booking.guestId,
  reference: booking.reference,
  status: booking.status,
  status_reason:
    booking.status === 'cancelled'
      ? 'ביטול ביוזמת האורח, בתוך חלון הביטול החינם.'
      : booking.status === 'no_show'
        ? 'האורח לא הגיע ולא ענה לטלפון בערב ההגעה.'
        : null,
  check_in: booking.checkIn,
  check_out: booking.checkOut,
  // A generated column in Postgres, returned by PostgREST like any other.
  stay: dateRange(booking.checkIn, booking.checkOut),
  arrival_time: index % 4 === 0 ? '17:30:00' : null,
  adults: booking.adults,
  children: booking.children,
  infants: booking.infants,

  // ── The party, as 0028 stores it ─────────────────────────────────────────
  //
  // Without these five the preparation plan page fails for every *seeded*
  // booking — `loadBooking` reads columns the demo row does not carry — while
  // working perfectly for one created through the form, which is the worst
  // shape a demo gap can take: it looks like a bug in the feature rather than
  // an absence in the fixture.
  //
  // Derived rather than invented. `couples` is floor(adults / 2), which is what
  // the booking form itself defaults to and pre-fills for the desk to correct;
  // it satisfies `bookings_couples_within_adults` by construction. Every other
  // field takes the column's own default, because a fixture that guesses at a
  // guest's request is fabricating one.
  couples: Math.floor(booking.adults / 2),
  extra_beds_requested: 0,
  cots_requested: booking.infants,
  // Two stays carry a real event type and a real request, so the demo can show
  // what an event template and a special request actually do. Chosen by index
  // rather than at random: a dataset whose shape moved between renders would
  // produce a plan that disagrees with the screen it was drawn beside.
  event_type: index % 9 === 3 ? 'shabbat' : 'accommodation',
  special_requests:
    index % 9 === 3
      ? 'שתי מיטות תינוק, אחת בחדר ההורים. מגיעים אחרי כניסת שבת.'
      : booking.infants > 0
        ? 'מיטת תינוק בבקשה.'
        : null,
  source: booking.source,
  source_channel:
    booking.source === 'airbnb'
      ? 'airbnb.co.il'
      : booking.source === 'booking_com'
        ? 'booking.com'
        : null,
  // `bookings_agent_attributed`: a booking whose source is an agent must name
  // one. Anything else must not pretend to have had one.
  agent_user_id: booking.agentUserId,
  agency_id: booking.agentUserId ? AGENCY_ID : null,
  campaign_id: null,
  referral_id: null,
  currency: 'ILS',
  total_agorot: booking.totalAgorot,
  tax_rate_bps: 1700,
  tourist_vat_exempt: false,
  guest_token: (
    demoUuid(ID_GROUP.booking, index + 1) +
    demoUuid(ID_GROUP.booking, index + 5001)
  ).replace(/-/g, ''),
  guest_notes: index % 7 === 0 ? 'מבקשים מיטת תינוק ושעת כניסה מאוחרת.' : null,
  internal_notes:
    index % 11 === 0 ? 'אורח חוזר — לתת שדרוג אם יש יחידה פנויה.' : null,
  metadata: {},
  ...stamped(enteredBy(booking), bookedOffset(booking)),
}))

/**
 * Two history rows per booking: created, then moved to where it is now.
 *
 * Not a full transition log. Inventing the intermediate steps of a stay that
 * never happened would be fabricating an audit trail, and an audit trail that
 * is partly fiction is worse than a short one.
 */
export const BOOKING_STATUS_HISTORY_ROWS: DemoRow[] = BOOKINGS.flatMap(
  (booking, index) => {
    const created = bookedOffset(booking)
    const first = {
      id: historyIds(index * 2 + 1),
      organization_id: ORGANIZATION_ID,
      property_id: booking.unit.propertyId,
      booking_id: booking.id,
      from_status: null,
      to_status: 'inquiry',
      changed_by: enteredBy(booking),
      reason: null,
      occurred_at: momentOn(created, '09:20'),
      metadata: {},
      created_at: momentOn(created, '09:20'),
    }

    if (booking.status === 'inquiry') return [first]

    return [
      first,
      {
        id: historyIds(index * 2 + 2),
        organization_id: ORGANIZATION_ID,
        property_id: booking.unit.propertyId,
        booking_id: booking.id,
        from_status: 'inquiry',
        to_status: booking.status,
        changed_by: enteredBy(booking),
        reason:
          booking.status === 'cancelled'
            ? 'ביטול ביוזמת האורח.'
            : booking.status === 'no_show'
              ? 'לא הגיע.'
              : null,
        occurred_at: momentOn(Math.min(created + 1, 0), '11:05'),
        metadata: {},
        created_at: momentOn(Math.min(created + 1, 0), '11:05'),
      },
    ]
  },
)

export const BOOKING_PRICE_LINE_ROWS: DemoRow[] = BOOKINGS.flatMap(
  (booking, bookingIndex) =>
    booking.lines.map((line, lineIndex) => ({
      id: priceLineIds(bookingIndex * 10 + lineIndex + 1),
      organization_id: ORGANIZATION_ID,
      property_id: booking.unit.propertyId,
      booking_id: booking.id,
      kind: line.kind,
      label: line.label,
      amount_agorot: line.amountAgorot,
      quantity: line.quantity,
      line_date: line.kind === 'accommodation' ? booking.checkIn : null,
      sort_order: lineIndex,
      metadata: {},
      ...stampedNoDelete(enteredBy(booking), bookedOffset(booking)),
    })),
)

/* -------------------------------------------------------------- holds ---- */

type HoldSpec = {
  unitCode: string
  start: number
  nights: number
  reason: string
  minutes: number
  releasedDaysAgo?: number
  note: string
}

/**
 * Three holds on nights nothing else has.
 *
 * A hold is an occupancy too, and the same exclusion constraint applies — so
 * these sit in gaps between stays, and the released one carries no occupancy
 * row at all, because releasing a hold is exactly what gives the room back.
 */
const HOLD_SPECS: readonly HoldSpec[] = [
  {
    unitCode: 'RIM-04',
    start: 12,
    nights: 2,
    reason: 'agent_quote',
    minutes: 120,
    note: 'החזקה לסוכן עד שהלקוח יאשר.',
  },
  {
    unitCode: 'KAY-02',
    start: 17,
    nights: 3,
    reason: 'guest_checkout',
    minutes: 45,
    note: 'האורח באמצע תשלום באתר.',
  },
  {
    unitCode: 'RIM-01',
    start: 20,
    nights: 2,
    reason: 'staff_manual',
    minutes: 60,
    releasedDaysAgo: 2,
    note: 'הוחזק בטלפון ושוחרר — הלקוח בחר תאריך אחר.',
  },
]

export const HOLDS = HOLD_SPECS.map((spec, index) => {
  const room = unit(spec.unitCode)
  const released = spec.releasedDaysAgo !== undefined
  return {
    id: holdIds(index + 1),
    room,
    checkIn: day(spec.start),
    checkOut: day(spec.start + spec.nights),
    reason: spec.reason,
    minutes: spec.minutes,
    released,
    releasedDaysAgo: spec.releasedDaysAgo ?? null,
    note: spec.note,
  }
})

export const HOLD_ROWS: DemoRow[] = HOLDS.map((hold) => ({
  id: hold.id,
  organization_id: ORGANIZATION_ID,
  property_id: hold.room.propertyId,
  unit_id: hold.room.id,
  check_in: hold.checkIn,
  check_out: hold.checkOut,
  stay: dateRange(hold.checkIn, hold.checkOut),
  reason: hold.reason,
  held_by_user_id: hold.reason === 'agent_quote' ? AGENT_ID : RECEPTION_ID,
  expires_at: hold.released
    ? momentOn(-(hold.releasedDaysAgo ?? 0), '15:00')
    : minutesFromNow(hold.minutes),
  released_at: hold.released
    ? momentOn(-(hold.releasedDaysAgo ?? 0), '14:10')
    : null,
  released_by: hold.released ? RECEPTION_ID : null,
  converted_to_booking_id: null,
  note: hold.note,
  metadata: {},
  ...stampedNoDelete(
    hold.reason === 'agent_quote' ? AGENT_ID : RECEPTION_ID,
    hold.released ? -(hold.releasedDaysAgo ?? 0) : 0,
  ),
}))

/**
 * An expiry a demo can watch tick, rather than one already in the past.
 *
 * Written in UTC rather than through `moment()`: this is an instant computed
 * from the clock, not a wall-clock time somebody wrote down, and rendering it
 * in Jerusalem local time would be dressing it up as something it is not.
 */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/* ---------------------------------------------------------- occupancy ---- */

/**
 * The one table that decides whether a night is free.
 *
 * A booking that was cancelled has no row here, and neither has a released
 * hold — which is the whole mechanism by which those nights become sellable
 * again. Everything else occupies exactly its own range.
 */
export const UNIT_OCCUPANCY_ROWS: DemoRow[] = [
  ...BOOKINGS.filter((booking) => booking.occupies).map((booking, index) => ({
    id: occupancyIds(index + 1),
    organization_id: ORGANIZATION_ID,
    property_id: booking.unit.propertyId,
    unit_id: booking.unit.id,
    kind: 'booking',
    booking_id: booking.id,
    hold_id: null,
    during: dateRange(booking.checkIn, booking.checkOut),
    // `unit_occupancy_shape`: a booking's occupancy never expires.
    expires_at: null,
    created_at: momentOn(bookedOffset(booking), '09:20'),
  })),
  ...HOLDS.filter((hold) => !hold.released).map((hold, index) => ({
    id: occupancyIds(500 + index),
    organization_id: ORGANIZATION_ID,
    property_id: hold.room.propertyId,
    unit_id: hold.room.id,
    kind: 'hold',
    booking_id: null,
    hold_id: hold.id,
    during: dateRange(hold.checkIn, hold.checkOut),
    expires_at: minutesFromNow(hold.minutes),
    created_at: momentOn(0, '08:40'),
  })),
]

/** Used by the finance and operations modules to date their own rows. */
export { bookedOffset, MANAGER_ID, RECEPTION_ID, AGENT_ID }
