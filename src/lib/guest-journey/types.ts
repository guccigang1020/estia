/**
 * The guest journey's vocabulary, and the shape of what the portal reads.
 *
 * ── Why these are not in `src/lib/contracts` ──────────────────────────────
 *
 * That file states the test for what belongs in it: a vocabulary lives in the
 * frozen contracts when two modules would otherwise each define it and drift,
 * "and the disagreement surfaces as a customer seeing two different numbers
 * for the same booking". Nothing outside the guest journey has an opinion
 * about what "release the address after the deposit" means, so these live
 * here, beside the only code that reads them.
 *
 * Two that genuinely ARE shared are imported rather than restated:
 * `PaymentCollectionPolicy` and `ConfirmationRequirement` come from the frozen
 * contracts, because the settings screen, the booking screen and this portal
 * all have to mean the same thing by "deposit". See `ports.ts`.
 *
 * ── These mirror migration 0034 ───────────────────────────────────────────
 *
 * Every array below is a Postgres enum in `0034_guest_journey.sql`, in the
 * same order. A member added on one side and not the other is a runtime cast
 * failure at the database, which is the loud direction for that mistake to
 * fail.
 */

// ── The steps a business may require ──────────────────────────────────────

/** `public.guest_contract_mode`. */
export const GUEST_CONTRACT_MODES = [
  'disabled',
  'optional',
  'mandatory',
] as const

export type GuestContractMode = (typeof GUEST_CONTRACT_MODES)[number]

/** `public.guest_arrival_release`. */
export const GUEST_ARRIVAL_RELEASES = [
  'immediate',
  'after_confirmation',
  'after_contract',
  'after_deposit',
  'after_full_payment',
  'hours_before',
  'manual',
] as const

export type GuestArrivalRelease = (typeof GUEST_ARRIVAL_RELEASES)[number]

export const GUEST_ARRIVAL_RELEASE_LABEL: Record<GuestArrivalRelease, string> =
  {
    immediate: 'מיד עם פתיחת הקישור',
    after_confirmation: 'אחרי אישור האורח',
    after_contract: 'אחרי חתימה על החוזה',
    after_deposit: 'אחרי תשלום מקדמה',
    after_full_payment: 'אחרי תשלום מלא',
    hours_before: 'זמן קצוב לפני ההגעה',
    manual: 'שחרור ידני',
  }

/** `public.guest_request_category`. */
export const GUEST_REQUEST_CATEGORIES = [
  'towels',
  'linen',
  'cleaning',
  'maintenance',
  'equipment',
  'other',
] as const

export type GuestRequestCategory = (typeof GUEST_REQUEST_CATEGORIES)[number]

export const GUEST_REQUEST_CATEGORY_LABEL: Record<
  GuestRequestCategory,
  string
> = {
  towels: 'מגבות',
  linen: 'מצעים',
  cleaning: 'ניקיון',
  maintenance: 'תחזוקה',
  equipment: 'ציוד',
  other: 'אחר',
}

/**
 * `public.guest_request_state`.
 *
 * Four values, against the nine in `TASK_STATUSES`. The migration's trigger
 * does the collapsing and its comment says why: that the linen has not arrived
 * is a fact about the business's day, and a guest told their towels are
 * BLOCKED learns something alarming they cannot act on.
 */
export const GUEST_REQUEST_STATES = [
  'received',
  'in_progress',
  'completed',
  'cancelled',
] as const

export type GuestRequestState = (typeof GUEST_REQUEST_STATES)[number]

export const GUEST_REQUEST_STATE_LABEL: Record<GuestRequestState, string> = {
  received: 'התקבלה',
  in_progress: 'בטיפול',
  completed: 'הושלמה',
  cancelled: 'בוטלה',
}

/** `public.guest_link_channel`. */
export const GUEST_LINK_CHANNELS = ['whatsapp', 'sms', 'email', 'copy'] as const

export type GuestLinkChannel = (typeof GUEST_LINK_CHANNELS)[number]

export const GUEST_LINK_CHANNEL_LABEL: Record<GuestLinkChannel, string> = {
  whatsapp: 'וואטסאפ',
  sms: 'הודעת SMS',
  email: 'דוא״ל',
  copy: 'העתקת הודעה',
}

// ── The details a business may collect ────────────────────────────────────

/**
 * The fields an operator may ask for, and the only keys the portal will render
 * or store.
 *
 * A closed list rather than free-form keys, and the reason is not tidiness: the
 * details form is filled in by somebody with no account, and an open key space
 * would let a crafted request write arbitrary names into a jsonb column that a
 * staff screen later renders. The database caps the payload's size; this caps
 * its shape.
 */
export const GUEST_DETAIL_FIELDS = [
  'full_name',
  'id_number',
  'phone',
  'email',
  'address',
  'arrival_estimate',
  'vehicle',
  'guest_names',
  'dietary',
  'notes',
] as const

export type GuestDetailField = (typeof GUEST_DETAIL_FIELDS)[number]

export const GUEST_DETAIL_FIELD_LABEL: Record<GuestDetailField, string> = {
  full_name: 'שם מלא',
  id_number: 'מספר תעודת זהות',
  phone: 'טלפון',
  email: 'דוא״ל',
  address: 'כתובת',
  arrival_estimate: 'שעת הגעה משוערת',
  vehicle: 'מספר רכב',
  guest_names: 'שמות האורחים',
  dietary: 'העדפות תזונה',
  notes: 'הערות',
}

/** Which control the field gets. Nothing here is a password or a card number. */
export const GUEST_DETAIL_FIELD_KIND: Record<
  GuestDetailField,
  'text' | 'tel' | 'email' | 'time' | 'multiline'
> = {
  full_name: 'text',
  id_number: 'text',
  phone: 'tel',
  email: 'email',
  address: 'multiline',
  arrival_estimate: 'time',
  vehicle: 'text',
  guest_names: 'multiline',
  dietary: 'multiline',
  notes: 'multiline',
}

const DETAIL_FIELD_SET: ReadonlySet<string> = new Set(GUEST_DETAIL_FIELDS)

export function isGuestDetailField(value: string): value is GuestDetailField {
  return DETAIL_FIELD_SET.has(value)
}

// ── What invalidates an approval ──────────────────────────────────────────

/**
 * The kinds of change that can void a confirmation the guest already gave.
 *
 * `cancellation` is in the list and is the one people forget: a business that
 * rewrites its cancellation terms after a guest agreed has changed the deal as
 * surely as if it had moved the price.
 */
export const RECONFIRMATION_TRIGGERS = [
  'dates',
  'guests',
  'price',
  'cancellation',
] as const

export type ReconfirmationTrigger = (typeof RECONFIRMATION_TRIGGERS)[number]

// ── What `guest_portal_journey` returns ───────────────────────────────────

export type GuestJourneySettings = {
  contractMode: GuestContractMode
  requireGuestConfirmation: boolean
  requiredDetailFields: GuestDetailField[]
  optionalDetailFields: GuestDetailField[]
  arrivalRelease: GuestArrivalRelease
  arrivalReleaseHours: number
  duringStayTopics: string[]
  requestsEnabled: boolean
  requestCategories: GuestRequestCategory[]
  checkoutDeclarationEnabled: boolean
  reviewEnabled: boolean
  reviewUrl: string | null
  rebookEnabled: boolean
  reconfirmationTriggers: ReconfirmationTrigger[]
}

/** The live terms. Every field is already in 0033's projection. */
export type GuestJourneyTerms = {
  bookingVersion: number
  status: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  infants: number
  totalAgorot: number
  currency: string
  cancellationTerms: string | null
  inStay: boolean
}

/**
 * The terms as they stood when the guest approved them.
 *
 * Deliberately a separate type from `GuestJourneyTerms` even though it carries
 * most of the same fields. They are read at different moments and one of them
 * is frozen; giving them one name would invite somebody to compare a snapshot
 * with itself.
 */
export type GuestConfirmationSnapshot = {
  checkIn: string | null
  checkOut: string | null
  adults: number | null
  children: number | null
  infants: number | null
  totalAgorot: number | null
  currency: string | null
  cancellationTerms: string | null
}

export type GuestConfirmation = {
  confirmedAt: string
  bookingVersion: number
  snapshot: GuestConfirmationSnapshot
}

export type GuestContract = {
  mode: GuestContractMode
  /** The terms on offer. Null once signed — the signature is the contract then. */
  template: { title: string; body: string } | null
  /** The frozen copy. Never a pointer to a template that will change. */
  signature: {
    signedAt: string
    signerName: string
    title: string
    body: string
    bookingVersion: number
  } | null
}

export type GuestDetails = {
  submittedAt: string | null
  fields: Partial<Record<GuestDetailField, string>>
}

/**
 * Arrival information.
 *
 * Every field but `released`, `city` and `checkInTime` is null until the
 * business's release policy allows it — and it is null because the DATABASE
 * did not return it, not because this type says so. See §9 of the migration.
 */
export type GuestArrival = {
  released: boolean
  checkInTime: string | null
  addressNote: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  directions: string | null
  mapUrl: string | null
  parking: string | null
  accessInstructions: string | null
  accessCode: string | null
}

export type GuestStay = {
  inStay: boolean
  wifiNetwork: string | null
  wifiPassword: string | null
  propertyGuide: string | null
  houseRules: string | null
  emergencyContact: string | null
}

export type GuestRequest = {
  id: string
  category: GuestRequestCategory
  body: string | null
  state: GuestRequestState
  createdAt: string
  completedAt: string | null
}

export type GuestCheckout = {
  checkOutTime: string | null
  instructions: string | null
  declaredAt: string | null
  enabled: boolean
}

/** The whole journey, as one round trip. */
export type GuestJourney = {
  settings: GuestJourneySettings
  current: GuestJourneyTerms
  confirmation: GuestConfirmation | null
  contract: GuestContract
  details: GuestDetails
  arrival: GuestArrival
  stay: GuestStay
  requests: GuestRequest[]
  checkout: GuestCheckout
}
