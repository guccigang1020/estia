/**
 * The facts detection runs on, and where each of them came from.
 *
 * ── Nothing in this directory fetches anything ────────────────────────────
 *
 * Every function under `signals/` is pure: facts in, `Signal[]` or `Readiness`
 * out. No Supabase client is imported anywhere here and none may be. That is
 * not tidiness — it is what makes "why did ESTIA say the villa is at risk"
 * answerable by reading a test rather than by reproducing a database at 06:00
 * on a Friday.
 *
 * ── A fact is somebody else's answer, carried with its sentence ───────────
 *
 * `Decided` is the shape every fact arrives in, and the important field is
 * `detail`: the Hebrew sentence the OWNING engine already said. The payments
 * resolver has decided whether the deposit is in and has written "טרם נרשמה
 * מקדמה — חסרים ₪2,500 מתוך ₪2,500"; detection quotes that. It does not
 * recompute it, does not paraphrase it, and does not hold a second opinion
 * about whether a deposit was paid.
 *
 * ── `null` means "not a thing here", and it is not the same as unmet ──────
 *
 * A fact that is `null` is one that does not apply to this booking — no
 * contract was ever required, the business asks for no deposit. That becomes
 * `not_applicable` and leaves the denominator, which is the whole reason a
 * business with laundry switched off does not sit permanently at 87%.
 *
 * An unmet fact is a different thing entirely and is stated as `met: false`.
 * The two are separate fields rather than one nullable boolean precisely
 * because collapsing them is how "we never asked" becomes "it failed".
 */

import type { Evidence } from '../types'

import type { EnabledModules } from './modules'

/* ------------------------------------------------------------- one fact -- */

/**
 * One thing an engine has already decided, ready to be quoted.
 *
 * `atRisk` is a third answer to a yes-or-no question and it earns its place: a
 * cleaner who has accepted the job and has not started is neither done nor
 * refusing. It counts as unmet in the arithmetic — a bed half made is not a
 * bed — and it changes the wording and the severity, which is what a person
 * reading the screen needs.
 */
export interface Decided {
  met: boolean
  /** Only meaningful when `met` is false. See above. */
  atRisk?: boolean
  /** Hebrew, and the owning engine's own words. */
  detail: string
  /** Which engine said so — `payments`, `preparation`, `inventory`. */
  source: string
  /** The value the screen shows, when a bare yes/no would lose it. */
  value?: string | number | boolean | null
  /** The row it came from. */
  sourceId?: string
  /** When it was true. Absent means "now", which is rarely honest. */
  observedAt?: string
}

/** Turn a decided fact into the `Evidence` a signal or requirement carries. */
export function evidenceFrom(
  key: string,
  label: string,
  decided: Decided,
): Evidence {
  const evidence: Evidence = {
    key,
    label,
    value: decided.value === undefined ? decided.met : decided.value,
    source: decided.source,
  }
  // Spread-with-undefined would put the keys on the object with an undefined
  // value, which serialises to `"sourceId": null` and reads as "we looked and
  // there was nothing". Absent and null are different claims.
  return {
    ...evidence,
    ...(decided.sourceId === undefined ? {} : { sourceId: decided.sourceId }),
    ...(decided.observedAt === undefined
      ? {}
      : { observedAt: decided.observedAt }),
  }
}

/** A fact detection observed itself, rather than one an engine handed over. */
export function fact(
  key: string,
  label: string,
  value: string | number | boolean | null,
  source: string,
  observedAt?: string,
): Evidence {
  return {
    key,
    label,
    value,
    source,
    ...(observedAt === undefined ? {} : { observedAt }),
  }
}

/* ------------------------------------------------------------- subjects -- */

/**
 * Everything detection knows about one booking.
 *
 * One record shared by readiness, the never-forget sweep and the arrival risk,
 * rather than three shapes that overlap. Three would drift, and the day the
 * sweep's idea of "contract signed" differed from readiness's, the screen
 * would show a booking at 100% with an open exception under it.
 *
 * Every field is required — including the ones that are usually `null` — so
 * that a caller who has not looked cannot quietly omit one and have detection
 * read the absence as "fine".
 */
export interface BookingFacts {
  bookingId: string
  propertyId: string | null
  /** Hebrew, for the sentence. "וילה ים · משפחת כהן". */
  label: string
  /** The instant the guest is expected. `null` when the time is not fixed. */
  arrivalAt: string | null
  /** Property-local calendar date of the arrival, `YYYY-MM-DD`. */
  arrivalDate: string | null
  /** Property-local wall clock of the arrival, `HH:MM`. */
  arrivalTime: string | null

  guestConfirmation: Decided | null
  contract: Decided | null
  /** The whole collection policy in one answer. See `payments/resolver.ts`. */
  paymentRequirement: Decided | null
  guestDetails: Decided | null
  preparation: Decided | null
  cleaning: Decided | null
  /** Whether the person doing the work has taken it on. */
  cleanerAcceptance: Decided | null
  /** Only asked where the business requires a unit to be inspected. */
  inspection: Decided | null
  laundry: Decided | null
  inventory: Decided | null
  maintenance: Decided | null
  access: Decided | null
  arrivalInstructions: Decided | null
}

/**
 * Everything detection knows about one property, with no guest in it.
 *
 * The guest-shaped requirements are simply absent from the type rather than
 * present and always null: a property has no contract and no arrival
 * instructions, and a field that could only ever be null is a field somebody
 * eventually fills in wrongly.
 */
export interface PropertyFacts {
  propertyId: string
  label: string
  preparation: Decided | null
  cleaning: Decided | null
  inspection: Decided | null
  laundry: Decided | null
  inventory: Decided | null
  maintenance: Decided | null
  access: Decided | null
}

/* -------------------------------------------------------------- context -- */

/**
 * The two things every detector needs and neither of which it may look up.
 *
 * `now` is passed rather than read, so a test can stand at 13:42 on a Friday
 * without mocking the clock, and so two detectors in the same pass cannot
 * disagree about what time it is by four milliseconds.
 */
export interface DetectorContext {
  modules: EnabledModules
  now: Date
  /** The property's zone. Deadlines are wall-clock, never UTC. */
  timeZone: string
}
