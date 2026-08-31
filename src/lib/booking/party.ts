/**
 * Who is coming, how they sleep, and what they asked for.
 *
 * The preparation engine in `src/lib/preparation` is thorough and it is fed by
 * nothing. `PreparationFacts` wants adults, children, nights, an event type and
 * the extra beds; the booking form collected a single `guestCount` defaulting
 * to `'2'`, and `bookings` already had `adults`, `children` and `infants` as
 * separate columns. The database was ahead of the form and the engine was ahead
 * of both. This module is the vocabulary that closes the first gap.
 *
 * ── Three numbers, not one, and why the third is not pedantry ──────────────
 *
 * An infant is the reason the split has to exist. A baby is a guest — they eat,
 * they generate laundry, they are on the fire count — and they need **no
 * sleeping place**, because they sleep in a cot that somebody has to fetch and
 * set up. Counting them into the party that `allocateSleeping` lays out over
 * beds buys a bed nobody sleeps in; leaving them out of the booking entirely
 * loses the cot. So `totalGuests` and `sleepingGuests` are two different
 * questions with two different answers, both derived here and never guessed at
 * a call site.
 *
 * ── One vocabulary, borrowed rather than restated ─────────────────────────
 *
 * `EventType` is imported from `src/lib/preparation/types.ts`. It is not
 * re-declared, not widened, and not re-exported from the booking barrel — a
 * second door to one list is how two lists begin. `EVENT_TYPE_LABEL` below is a
 * *rendering* of that frozen list and not a second copy of it: it is a total
 * `Record<EventType, string>`, so adding a type to `EVENT_TYPES` without naming
 * it in Hebrew fails the build rather than showing `day_event` to a villa
 * owner.
 *
 * ── What this module is deliberately not ──────────────────────────────────
 *
 * It does not allocate beds. `couples` is recorded here because the person
 * taking the booking knows it and nobody else ever will; deciding that two
 * couples means two double beds rather than four singles is
 * `src/lib/preparation/sleeping.ts`'s job, and it is worth saying plainly that
 * `SleepingAllocationInput` cannot take this number today. See the note on
 * `SleepingRequest`.
 */

import { ValidationError, type FieldIssue } from '../errors'
import type { EventType } from '../preparation/types'

// ── The party ─────────────────────────────────────────────────────────────

/**
 * The three columns `public.bookings` has held since 0009.
 *
 * `adults` is at least one — a booking with nobody in it is not a booking, and
 * `bookings_adults_positive` says the same thing in the schema.
 */
export interface BookingParty {
  adults: number
  children: number
  infants: number
}

/**
 * The sleeping shape the person at the desk knows and the engine cannot infer.
 *
 * `couples` decides double beds against single ones. It is captured here and,
 * today, consumed by nothing: `SleepingAllocationInput` in
 * `src/lib/preparation/sleeping.ts` takes `{ guests, configuration, bedTypes }`
 * and allocates largest-bed-first, so four adults are laid out identically
 * whether they are two couples or four colleagues. That is a real gap in the
 * engine's input and it is not this module's to close — widening
 * `SleepingAllocationInput` belongs to whoever owns `src/lib/preparation`.
 * Recording the fact at intake is the half that has to happen first: a number
 * nobody wrote down cannot be used later, and a number written down can.
 *
 * `extraBedsRequested` and `cotsRequested` are what the guest asked for **by
 * name**, which is a different fact from `SleepingAllocation.extraBeds` — that
 * one is an *output*, the beds the house turned out to be short of. A booking
 * can want a cot in a house with a spare bedroom, and the two numbers are
 * allowed to disagree.
 */
export interface SleepingRequest {
  /** Pairs of adults sharing one bed. Never more than half the adults. */
  couples: number
  /** Beds the guest asked for beyond what is made up. */
  extraBedsRequested: number
  /** Cots. The infant case, and the reason infants are counted separately. */
  cotsRequested: number
}

/** Everything the booking screen collects for the preparation engine. */
export interface BookingIntake {
  party: BookingParty
  sleeping: SleepingRequest
  eventType: EventType
  /** Free text, in Hebrew, as the guest said it. Null when they said nothing. */
  specialRequests: string | null
}

/**
 * The plain stay.
 *
 * A default rather than a guess. Most bookings in a צימר are somebody coming to
 * sleep, and the event types that change the preparation plan — a wedding, a
 * Shabbat — are the ones a person types on purpose. `EVENT_TYPES`'s own header
 * says inference gets this wrong on exactly the bookings that matter most,
 * which is an argument against inferring it and not against having a default.
 */
export const DEFAULT_EVENT_TYPE: EventType = 'accommodation'

/**
 * Hebrew for the frozen list, total by construction.
 *
 * Lives beside the booking intake because that is the only screen that asks the
 * question today. If `src/lib/preparation` ever needs the same map — a
 * cleaner's plan header would — it should move there and this should import it,
 * rather than a second one appearing.
 */
export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  accommodation: 'לינה',
  day_event: 'אירוע יום — בלי לינה',
  overnight_event: 'אירוע עם לינה',
  wedding: 'חתונה',
  birthday: 'יום הולדת',
  retreat: 'ריטריט',
  corporate: 'אירוע חברה',
  shabbat: 'שבת',
  family_event: 'אירוע משפחתי',
  custom: 'אחר',
}

/** The longest a special request may be. Long enough for a paragraph. */
export const SPECIAL_REQUESTS_MAX = 1000

// ── Derived counts ────────────────────────────────────────────────────────

/**
 * Every head. What the unit's capacity and the price are measured against.
 *
 * Infants are included on purpose: this is the number that was typed into the
 * old single `guestCount` field, and changing what a stay costs is not
 * something a refactor of the intake gets to do on its way past. Whether a baby
 * should attract an extra-guest supplement is a pricing decision for the
 * business, and it is made by the price the seller agrees, not here.
 */
export function totalGuests(party: BookingParty): number {
  return party.adults + party.children + party.infants
}

/**
 * The people who need a bed.
 *
 * This is the number `allocateSleeping` should be given. Six people over five
 * double beds is three beds made up; seven — the same party with the baby
 * counted — is four, and the fourth is a bed nobody sleeps in.
 */
export function sleepingGuests(party: BookingParty): number {
  return party.adults + party.children
}

/**
 * A first guess at the couples, for the form's default only.
 *
 * Two adults are a couple far more often than not, and a person who disagrees
 * changes one number they can see. This is never applied server-side: the
 * operation takes what it was given, because a default invented in the domain
 * would be the engine guessing at the sleeping arrangement, which is the thing
 * the event-type comment warns against.
 */
export function suggestedCouples(party: BookingParty): number {
  return Math.floor(party.adults / 2)
}

/**
 * What a booking that only ever knew one number means.
 *
 * The same split `SupabaseBookingRepository` has written since it was created —
 * the whole party as adults — named here so that a caller that predates the
 * split gets a documented answer rather than an accident.
 */
export function legacyParty(guestCount: number): BookingParty {
  return { adults: guestCount, children: 0, infants: 0 }
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Every problem with the party at once, as field issues.
 *
 * Returned rather than thrown so the form can render all of them beside their
 * own controls, and so the operation can throw a single `ValidationError`
 * carrying the lot. One list of rules, checked twice, which is the only way the
 * screen and the server can be guaranteed to agree about what is wrong.
 */
export function partyIssues(
  party: BookingParty,
  sleeping: SleepingRequest,
  options: { maxGuests?: number } = {},
): readonly FieldIssue[] {
  const issues: FieldIssue[] = []

  if (!Number.isInteger(party.adults) || party.adults < 1) {
    issues.push({
      field: 'adults',
      code: 'too_small',
      message: 'חייב להיות לפחות מבוגר אחד בהזמנה.',
      label: 'מבוגרים',
    })
  }
  if (!Number.isInteger(party.children) || party.children < 0) {
    issues.push({
      field: 'children',
      code: 'invalid',
      message: 'מספר הילדים חייב להיות מספר שלם, אפס ומעלה.',
      label: 'ילדים',
    })
  }
  if (!Number.isInteger(party.infants) || party.infants < 0) {
    issues.push({
      field: 'infants',
      code: 'invalid',
      message: 'מספר התינוקות חייב להיות מספר שלם, אפס ומעלה.',
      label: 'תינוקות',
    })
  }

  if (issues.length === 0 && options.maxGuests !== undefined) {
    const total = totalGuests(party)
    if (total > options.maxGuests) {
      issues.push({
        field: 'adults',
        code: 'too_large',
        message: `היחידה מכילה עד ${options.maxGuests} אורחים, וההזמנה מונה ${total}.`,
        label: 'אורחים',
      })
    }
  }

  if (!Number.isInteger(sleeping.couples) || sleeping.couples < 0) {
    issues.push({
      field: 'couples',
      code: 'invalid',
      message: 'מספר הזוגות חייב להיות מספר שלם, אפס ומעלה.',
      label: 'זוגות',
    })
  } else if (
    Number.isInteger(party.adults) &&
    sleeping.couples * 2 > party.adults
  ) {
    // A pair is two adults. Three couples among four adults is not a sleeping
    // arrangement, it is a typing mistake, and the plan it would produce puts
    // more people into double beds than the booking has.
    issues.push({
      field: 'couples',
      code: 'too_large',
      message: `אי אפשר ${sleeping.couples} זוגות מתוך ${party.adults} מבוגרים.`,
      label: 'זוגות',
    })
  }

  if (
    !Number.isInteger(sleeping.extraBedsRequested) ||
    sleeping.extraBedsRequested < 0
  ) {
    issues.push({
      field: 'extraBedsRequested',
      code: 'invalid',
      message: 'מספר המיטות הנוספות חייב להיות מספר שלם, אפס ומעלה.',
      label: 'מיטות נוספות',
    })
  }
  if (!Number.isInteger(sleeping.cotsRequested) || sleeping.cotsRequested < 0) {
    issues.push({
      field: 'cotsRequested',
      code: 'invalid',
      message: 'מספר מיטות התינוק חייב להיות מספר שלם, אפס ומעלה.',
      label: 'מיטות תינוק',
    })
  }

  return issues
}

/** `partyIssues`, as the refusal an operation raises. */
export function assertParty(
  party: BookingParty,
  sleeping: SleepingRequest,
  options: { maxGuests?: number } = {},
): void {
  const issues = partyIssues(party, sleeping, options)
  if (issues.length > 0) throw new ValidationError([...issues])
}

// ── Rendering ─────────────────────────────────────────────────────────────

/**
 * The party as a sentence, for the audit summary.
 *
 * Zero counts are dropped, so an ordinary couple reads "2 מבוגרים" and not
 * "2 מבוגרים, 0 ילדים, 0 תינוקות". The whole point of the audit line is that
 * somebody reads it three months later.
 */
export function describeParty(party: BookingParty): string {
  const parts: string[] = [
    party.adults === 1 ? 'מבוגר אחד' : `${party.adults} מבוגרים`,
  ]
  if (party.children > 0) {
    parts.push(party.children === 1 ? 'ילד אחד' : `${party.children} ילדים`)
  }
  if (party.infants > 0) {
    parts.push(party.infants === 1 ? 'תינוק אחד' : `${party.infants} תינוקות`)
  }
  return parts.join(', ')
}
