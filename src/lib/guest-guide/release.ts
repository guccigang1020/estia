/**
 * WHEN A GUEST MAY SEE A PIECE OF THE GUIDE. §43.
 *
 * This is the module's centre, and everything in `types.ts` is arranged to
 * make one sentence true:
 *
 *   ══════════════════════════════════════════════════════════════════════
 *   "EVERYTHING THIS GUEST MAY SEE RIGHT NOW" CANNOT RETURN A SECRET
 *   BY ACCIDENT, BECAUSE ITS RETURN TYPE HAS NOWHERE TO PUT ONE.
 *   ══════════════════════════════════════════════════════════════════════
 *
 * `releaseGuide` takes entries and returns entries. `GuideEntry` has no field
 * for a code, a password or a lock-box location, so no bug in this file — a
 * mis-ordered condition, an inverted boolean, a missing filter — can leak one.
 * The worst it can do is show the wrong *paragraph* early, which is a mistake
 * somebody notices and nobody sues over.
 *
 * Reaching a secret takes a second, explicit step. `discloseSecrets` is the
 * only function in the module that accepts `GuideSecret[]`, and it will not
 * look at one without a `GuideDisclosure` produced by `releaseGuide`. There is
 * no overload that takes a booking id and returns codes.
 *
 * ── Why a sensitive entry is withheld whole ───────────────────────────────
 *
 * A sensitive entry does not come back with its body showing and its secret
 * blanked. It does not come back at all. "The code is on the fridge magnet" is
 * as disclosing as the code, and an entry whose body explains where to use a
 * secret is written to be read beside it. So the unit of disclosure is the
 * entry, and `withheld` carries the topic and the reason — enough for the
 * portal to say "you will get the entry code once the deposit is paid", which
 * is the sentence that stops the support call.
 *
 * ── There is one policy, and half of it is already in the database ────────
 *
 * 0034 decides when a guest may see the address and the access code:
 * `guest_journey_settings.arrival_release` chooses a mode and
 * `public.guest_arrival_released` evaluates it. That function is the existing
 * mechanism and this file does not replace it — `GUIDE_RELEASE_MODES` is its
 * enum plus one member, in its order, and the seven shared conditions are
 * evaluated here exactly as they are evaluated there, including both of its
 * unconditional overrides.
 *
 * `release.test.ts` pins the transcription against `JOURNEY_RELEASE_MODES`,
 * and the schema proposal in this module's report requires the seam function
 * to delegate the seven shared modes to `public.guest_arrival_released` rather
 * than re-implement them in SQL. That is what keeps the two from drifting: the
 * part that already exists stays the database's answer, and only
 * `after_check_in` — a condition 0034 implements in a projection without
 * naming — is decided here.
 *
 * ── What this file is not ─────────────────────────────────────────────────
 *
 * It is not the guest portal, and it holds no token. Eligibility arrives as
 * facts: confirmed, signed, deposit settled, paid, checked in, when the stay
 * starts. Resolving a `bookings.guest_token` into those facts is the portal's
 * SECURITY DEFINER path and belongs to another owner; this file would be wrong
 * to have an opinion about it.
 */

import {
  JOURNEY_RELEASE_MODES,
  type GuideEntry,
  type GuideReleaseMode,
  type GuideReleaseRule,
  type GuideSecret,
  type GuideStage,
} from './types'

/* --------------------------------------------------------- eligibility -- */

/**
 * The booking statuses at which the argument is over.
 *
 * Transcribed from `public.guest_arrival_released`, whose comment says it
 * plainly: withholding a door code from somebody the business has already
 * checked in is not a policy, it is a support call at eleven at night. The
 * list is the same one, in the same order, and `release.test.ts` reads it.
 */
export const PAST_ARGUMENT_STATUSES: readonly string[] = [
  'checked_in',
  'in_house',
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
]

/**
 * What is true about this stay, as facts rather than as a decision.
 *
 * Every field is something the journey tables already record. Nothing here is
 * derived and nothing is optional-with-a-default: a caller that does not know
 * whether the deposit settled must say `false`, and `false` withholds. Failing
 * closed is the only direction that is safe when the caller is unsure.
 */
export type GuideEligibility = {
  /** `bookings.status`. Checked against `PAST_ARGUMENT_STATUSES`. */
  bookingStatus: string
  /** A guest confirmed the booking's terms. */
  confirmed: boolean
  /** A contract was signed. */
  contractSigned: boolean
  /** `booking_guest_journey.deposit_settled_at is not null`. */
  depositSettled: boolean
  /** `booking_guest_journey.payment_settled_at is not null`. */
  paidInFull: boolean
  /** The operator's override — `manual_released_at`. Wins on every branch. */
  manuallyReleased: boolean
  /** When the stay begins, as an instant. `null` withholds `hours_before`. */
  checkInAt: Date | null
}

/**
 * Nothing has happened yet.
 *
 * Every condition false and no check-in time, so only `immediate` entries
 * pass. Used by the admin preview — "this is what a guest who has just
 * received the link sees" — and by tests that want to add one true fact at a
 * time. Not a default: an operation that reached for this instead of the real
 * booking would be deciding disclosure against a fiction.
 */
export function noEligibility(bookingStatus = 'pending'): GuideEligibility {
  return {
    bookingStatus,
    confirmed: false,
    contractSigned: false,
    depositSettled: false,
    paidInFull: false,
    manuallyReleased: false,
    checkInAt: null,
  }
}

/* --------------------------------------------------------- the decision -- */

/**
 * Why an entry is not being shown.
 *
 * A code rather than a sentence, so the portal owns the wording and this
 * module owns the reason. `inactive` and `not_eligible` are different answers
 * — one means the operator switched it off, the other means "not yet" — and a
 * portal that could not tell them apart would promise a guest something that
 * is never coming.
 */
export const WITHHOLD_REASONS = [
  'inactive',
  'awaiting_confirmation',
  'awaiting_contract',
  'awaiting_deposit',
  'awaiting_full_payment',
  'awaiting_time',
  'awaiting_check_in',
  'awaiting_manual_release',
] as const
export type WithholdReason = (typeof WITHHOLD_REASONS)[number]

/** One entry the guest is not being shown, and why. */
export type WithheldEntry = {
  entryId: string
  stage: GuideStage
  topic: GuideEntry['topic']
  /** True when a secret is behind this. The portal marks it differently. */
  hasSecret: boolean
  reason: WithholdReason
}

/**
 * The answer to "what may this guest see right now".
 *
 * `visible` is `readonly GuideEntry[]`. Read the module header for why that
 * type, and not a richer one, is the safety property.
 */
export type GuideDisclosure = {
  visible: readonly GuideEntry[]
  withheld: readonly WithheldEntry[]
}

/**
 * Whether one rule's condition has been met.
 *
 * The two unconditional overrides come first and are checked before the mode
 * is even read, exactly as `guest_arrival_released` applies them after its
 * `case` with an `or`. Same effect, and putting them first here makes it
 * impossible to add a mode that forgets them.
 */
export function releaseMet(
  rule: GuideReleaseRule,
  eligibility: GuideEligibility,
  now: Date,
): boolean {
  // The operator said so. Every mode, no exceptions — a business that chose
  // `after_deposit` before it takes deposits could otherwise never show an
  // address, and the workaround would be to change the policy for everybody.
  if (eligibility.manuallyReleased) return true

  // The guest is standing in the doorway. See `PAST_ARGUMENT_STATUSES`.
  if (PAST_ARGUMENT_STATUSES.includes(eligibility.bookingStatus)) return true

  switch (rule.mode) {
    case 'immediate':
      return true
    case 'after_confirmation':
      return eligibility.confirmed
    case 'after_contract':
      return eligibility.contractSigned
    case 'after_deposit':
      return eligibility.depositSettled
    case 'after_full_payment':
      return eligibility.paidInFull
    case 'hours_before': {
      const checkIn = eligibility.checkInAt
      // No check-in time is not "any time". It is "we cannot evaluate this",
      // and the safe answer to that is no.
      if (checkIn === null) return false
      const opensAt = checkIn.getTime() - rule.hours * 3_600_000
      return now.getTime() >= opensAt
    }
    case 'manual':
      // Reached only when `manuallyReleased` is false, which is a no.
      return false
    case 'after_check_in': {
      // "Once the stay has begun" — the condition 0034 applies to the wi-fi
      // password in a projection without naming it.
      //
      // The clock, not the status. A guest whose stay started at 15:00 and
      // whom nobody at the desk has got round to checking in is a guest who
      // has begun their stay, and withholding the wi-fi password from them
      // because of a button nobody pressed is the failure this mode exists to
      // avoid. The status still releases it earlier, through the
      // past-argument override above.
      //
      // In SQL this is `guest_arrival_released` with `arrival_release` set to
      // `hours_before` and `arrival_release_hours` set to 0, which is why the
      // seam function needs no arithmetic of its own for this mode either.
      const checkIn = eligibility.checkInAt
      if (checkIn === null) return false
      return now.getTime() >= checkIn.getTime()
    }
  }
}

/** The reason a rule that was not met is holding this entry back. */
function reasonFor(mode: GuideReleaseMode): WithholdReason {
  switch (mode) {
    case 'after_confirmation':
      return 'awaiting_confirmation'
    case 'after_contract':
      return 'awaiting_contract'
    case 'after_deposit':
      return 'awaiting_deposit'
    case 'after_full_payment':
      return 'awaiting_full_payment'
    case 'hours_before':
      return 'awaiting_time'
    case 'after_check_in':
      return 'awaiting_check_in'
    case 'manual':
      return 'awaiting_manual_release'
    case 'immediate':
      // Unreachable: `immediate` is always met. Answered rather than thrown,
      // because a disclosure path must not have a branch that can crash.
      return 'awaiting_manual_release'
  }
}

/**
 * EVERYTHING THIS GUEST MAY SEE RIGHT NOW.
 *
 * Sorted by stage in catalogue order, then by the entry's own `sortOrder`, so
 * the portal renders a guide in the order the operator arranged it without
 * having to know the stage vocabulary.
 */
export function releaseGuide(input: {
  entries: readonly GuideEntry[]
  eligibility: GuideEligibility
  now: Date
}): GuideDisclosure {
  const visible: GuideEntry[] = []
  const withheld: WithheldEntry[] = []

  for (const entry of input.entries) {
    if (!entry.isActive) {
      withheld.push({
        entryId: entry.id,
        stage: entry.stage,
        topic: entry.topic,
        hasSecret: entry.hasSecret,
        reason: 'inactive',
      })
      continue
    }

    if (releaseMet(entry.release, input.eligibility, input.now)) {
      visible.push(entry)
    } else {
      withheld.push({
        entryId: entry.id,
        stage: entry.stage,
        topic: entry.topic,
        hasSecret: entry.hasSecret,
        reason: reasonFor(entry.release.mode),
      })
    }
  }

  return { visible: sortEntries(visible), withheld }
}

const STAGE_ORDER: readonly GuideStage[] = [
  'before_arrival',
  'during_stay',
  'after_checkout',
]

function sortEntries(entries: readonly GuideEntry[]): readonly GuideEntry[] {
  return [...entries].sort((a, b) => {
    const stage = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
    if (stage !== 0) return stage
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.id.localeCompare(b.id)
  })
}

/* ---------------------------------------------------------- the secrets -- */

/** A secret that has been released, beside the entry it belongs to. */
export type DisclosedSecret = {
  entryId: string
  value: GuideSecret['value']
}

/**
 * THE ONLY FUNCTION IN THIS MODULE THAT TURNS A `GuideSecret` INTO OUTPUT.
 *
 * It takes a decision, not facts. `disclosure` has to have been produced by
 * `releaseGuide`, which means the eligibility arithmetic has already happened
 * and cannot be skipped by calling this instead — there is no eligibility
 * argument here to get wrong, and no booking id to look one up from.
 *
 * A secret whose entry is not in `visible` is dropped silently rather than
 * reported. `withheld` already carries `hasSecret`, so the portal can say
 * "there is an access code and it is not released yet" from the disclosure
 * alone; adding the secret's id to a refusal would put a handle to a live
 * value in a response that a guest can read.
 */
export function discloseSecrets(input: {
  disclosure: GuideDisclosure
  secrets: readonly GuideSecret[]
}): readonly DisclosedSecret[] {
  const released = new Set(input.disclosure.visible.map((entry) => entry.id))

  return input.secrets
    .filter((secret) => released.has(secret.entryId))
    .map((secret) => ({ entryId: secret.entryId, value: secret.value }))
}

/* ---------------------------------------------------- for the operator -- */

/**
 * What the settings screen shows beside a sensitive entry.
 *
 * The operator's question is not "is it released" — there is no guest in front
 * of them — but "what has to happen first". So this answers in terms of the
 * rule rather than of any particular stay, and the screen renders it next to
 * `Withheld`.
 */
export function releaseCondition(rule: GuideReleaseRule): {
  mode: GuideReleaseMode
  hours: number | null
} {
  return {
    mode: rule.mode,
    hours: rule.mode === 'hours_before' ? rule.hours : null,
  }
}

/**
 * Is this mode one the database already decides?
 *
 * Used by the report and by `release.test.ts` to pin the transcription. The
 * seam function must hand these seven to `public.guest_arrival_released`
 * rather than answer them itself.
 */
export function isJourneyMode(mode: GuideReleaseMode): boolean {
  return (JOURNEY_RELEASE_MODES as readonly string[]).includes(mode)
}
