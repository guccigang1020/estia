/**
 * The guest register — a configurable record of who stayed, when.
 *
 * ══ WHAT THIS MODULE DOES NOT CLAIM ════════════════════════════════════════
 *
 * It does not claim that keeping this register satisfies any requirement
 * placed on any business by anyone. It does not name a statute, a regulator or
 * an authority, and nothing in it — code, comment or screen text — asserts
 * that a business which fills it in is thereby in the clear.
 *
 * That silence is deliberate and it is the honest position. The exact fields a
 * particular hospitality business must record have not been externally
 * verified for this product, and a module that guessed would be guessing about
 * something with legal consequences for its users. A field definition that
 * asserted an address must be collected because a statute says so would turn
 * an engineer's assumption into a sentence a guesthouse owner reads as advice.
 *
 * So every field requirement here is **configuration**, not law. The capability
 * is off until an operator turns it on, the default required set is the
 * smallest one under which a register is still a register, and the screen says
 * plainly that confirming what this particular business must record is the
 * operator's own responsibility. When somebody with the standing to say so has
 * checked the requirements, they change a configuration row — not this file.
 *
 * ══ WHY THE ENTRY IS NOT A VIEW OVER `bookings` ════════════════════════════
 *
 * Because a booking changes and a register does not. A guest's name is
 * corrected, a stay is extended, a booking is cancelled and its row is soft
 * deleted — and a register that rendered live booking rows would rewrite last
 * year's history every time somebody fixed a typo. The entry is written from
 * booking facts at the moments `generation.ts` names, and it keeps what it was
 * told.
 */

// ── The fields ────────────────────────────────────────────────────────────

/**
 * Everything the register can hold, as a closed vocabulary.
 *
 * Closed because `GuestBookConfig.requiredFields` is a subset of it and a
 * free-text field name would make "is this configuration valid" unanswerable.
 * The order is the order the screen renders them in, and it is load-bearing in
 * the same sense every other tuple in this codebase is: an enum's ordinal is
 * what a database `order by` sorts on.
 */
export const GUEST_BOOK_FIELDS = [
  'booking_reference',
  'property',
  'primary_guest_name',
  'guest_address',
  'arrival',
  'departure',
  'guest_count',
  'financial_document',
  'notes',
] as const

export type GuestBookField = (typeof GUEST_BOOK_FIELDS)[number]

/**
 * Where the entry stands in the stay it records.
 *
 * `cancelled` keeps the row rather than deleting it: a register whose entries
 * vanish is not a register, and "this booking was cancelled before arrival" is
 * itself a fact about the period.
 */
export const GUEST_BOOK_ENTRY_STATUSES = [
  'expected',
  'arrived',
  'departed',
  'cancelled',
] as const

export type GuestBookEntryStatus = (typeof GUEST_BOOK_ENTRY_STATUSES)[number]

/**
 * A postal address, as parts rather than one line.
 *
 * Parts because an operator who has been told which of them their business
 * must record can then require exactly those, and because a single free-text
 * line cannot be checked for completeness at all. `country` is nullable: for a
 * domestic guest at a domestic property it is noise, and a form that demands
 * it collects "ישראל" nine hundred times.
 */
export interface GuestAddress {
  line: string
  city: string
  postalCode: string | null
  country: string | null
}

// ── The record ────────────────────────────────────────────────────────────

/**
 * One stay, as the register holds it.
 *
 * Times are separate from dates because a register entry is a fact about a
 * property-local day and hour, and a `timestamptz` would silently re-file a
 * 00:30 arrival under the previous day for anyone reading it in another zone —
 * the same conversion the action centre argues about at length.
 */
export interface GuestBookEntry {
  id: string
  organizationId: string
  propertyId: string
  bookingId: string
  /** The booking's human reference, snapshotted. Not a live join. */
  bookingReference: string

  /** `null` while the booking has no named guest yet. */
  primaryGuestName: string | null
  guestAddress: GuestAddress | null

  /** `YYYY-MM-DD`, property-local. */
  arrivalDate: string
  /** `HH:MM`, property-local. `null` until the guest actually arrives. */
  arrivalTime: string | null
  departureDate: string | null
  departureTime: string | null

  guestCount: number

  /**
   * What is printed on the financial document, and the id beside it.
   *
   * The printed reference is snapshotted rather than joined, for the reason
   * the whole record is: a document's display number is what somebody will
   * look for in a folder years later, and it must survive the invoice row
   * being archived. The id is kept so the entry can still link to it while
   * both exist.
   */
  financialDocumentRef: string | null
  financialDocumentId: string | null

  notes: string | null

  status: GuestBookEntryStatus

  createdAt: Date
  updatedAt: Date
  version: number
}
