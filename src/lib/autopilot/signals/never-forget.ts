/**
 * The standing sweep: what should have happened by now, and has not.
 *
 * ── Why a sweep exists at all when there are already events ───────────────
 *
 * Every other part of Autopilot reacts. Something happens, a detector looks at
 * it, a signal comes out. That catches everything except the one class of
 * failure that actually loses money: the thing that never happened. No event
 * fires when a contract is not signed. Nothing is emitted when nobody
 * generates the access code. The booking sits there looking completely normal
 * until the guest is standing outside a locked door at 15:00 on a Friday.
 *
 * So this walks bookings against the clock and asks the negative question. It
 * is the only part of detection that is not triggered by something happening.
 *
 * ── Every check is somebody else's fact, graded by the deadline engine ────
 *
 * The sweep decides nothing about whether the deposit is in — `payments` said
 * so and the fact was handed over. What it adds is "and it should have been in
 * by Tuesday", which is `deadlines.ts` and a policy the organization set. Two
 * modules, neither doing the other's job.
 *
 * ── The schedule is policy, and there is no default ───────────────────────
 *
 * How many hours before an arrival a contract should be signed is a decision
 * about a business, not a fact about software. A default here would be the
 * number every customer silently ran on, and the first complaint would be
 * about a threshold nobody chose. `NeverForgetPolicy` is required, and
 * `NEVER_FORGET_CHECKS` gives a settings screen the vocabulary to build one.
 */

import type { AutopilotDomain } from '../../contracts/states'
import type { Evidence, Signal } from '../types'

import { gradeRelativeExpectation } from './deadlines'
import {
  evidenceFrom,
  type BookingFacts,
  type DetectorContext,
  type Decided,
} from './facts'
import { signalKey } from './keys'
import { isModuleEnabled, type SignalModule } from './modules'

export const NEVER_FORGET_CHECKS = [
  'contract_unsigned',
  'deposit_unrecorded',
  'cleaner_not_accepted',
  'laundry_unconfirmed',
  'access_code_missing',
  'arrival_info_unreleased',
  'inspection_missing',
  'guest_details_incomplete',
] as const

export type NeverForgetCheck = (typeof NEVER_FORGET_CHECKS)[number]

interface CheckSpec {
  code: string
  domain: AutopilotDomain
  /** `null` for the core product. */
  module: SignalModule | null
  label: string
  /** What the sentence says when it is outstanding. */
  detail: string
}

/**
 * What each check is, in the vocabulary the rest of Autopilot already speaks.
 *
 * The domains are chosen from the frozen tuple and two of them are worth
 * saying out loud:
 *
 *   · The contract sits in `payment_risk`, not in a domain of its own. It is a
 *     confirmation requirement in the same policy the deposit belongs to —
 *     `payments/resolver.ts` owns both — and inventing an `AUTOPILOT_DOMAINS`
 *     member is a contract change that belongs to the coordinator, not to a
 *     detector that found it convenient.
 *   · An unaccepted cleaning job is `staff`. Nobody is holding the work. That
 *     is a different conversation from the work going slowly, which is
 *     `preparation`, and sending both to the same place would send a
 *     supervisor to the wrong screen.
 */
const SPECS: Readonly<Record<NeverForgetCheck, CheckSpec>> = {
  contract_unsigned: {
    code: 'contract.unsigned',
    domain: 'payment_risk',
    module: 'contracts',
    label: 'החוזה טרם נחתם',
    detail: 'החוזה נשלח ולא נחתם.',
  },
  deposit_unrecorded: {
    code: 'payment.requirement_unmet',
    domain: 'payment_risk',
    module: 'payments',
    label: 'דרישת התשלום טרם מולאה',
    detail: 'דרישת התשלום להזמנה טרם מולאה.',
  },
  cleaner_not_accepted: {
    code: 'cleaning.not_accepted',
    domain: 'staff',
    module: 'cleaning',
    label: 'המנקה טרם אישר את העבודה',
    detail: 'העבודה שובצה ואיש לא אישר אותה.',
  },
  laundry_unconfirmed: {
    code: 'laundry.unconfirmed',
    domain: 'laundry',
    module: 'laundry',
    label: 'הכביסה טרם אושרה',
    detail: 'אין אישור שהכביסה תהיה מוכנה בזמן.',
  },
  access_code_missing: {
    code: 'access.code_missing',
    domain: 'guest_access',
    module: 'access',
    label: 'לא הופק קוד כניסה',
    detail: 'טרם הופק קוד כניסה לנכס.',
  },
  arrival_info_unreleased: {
    code: 'access.instructions_unreleased',
    domain: 'guest_access',
    module: 'guest_portal',
    label: 'הוראות ההגעה טרם שוחררו',
    detail: 'האורח עדיין אינו רואה כתובת והוראות הגעה.',
  },
  inspection_missing: {
    code: 'cleaning.inspection_missing',
    domain: 'preparation',
    module: 'inspection',
    label: 'בדיקת המוכנות טרם בוצעה',
    detail: 'הנכס לא נבדק לאחר הניקיון.',
  },
  guest_details_incomplete: {
    code: 'guest.details_incomplete',
    domain: 'guest_access',
    module: null,
    label: 'פרטי האורח חסרים',
    detail: 'חסרים פרטים שהעסק דורש מהאורח.',
  },
}

export const NEVER_FORGET_LABEL: Readonly<Record<NeverForgetCheck, string>> =
  Object.fromEntries(
    NEVER_FORGET_CHECKS.map((check) => [check, SPECS[check].label]),
  ) as Readonly<Record<NeverForgetCheck, string>>

/** When each check should have been satisfied, relative to the arrival. */
export interface NeverForgetSchedule {
  hoursBeforeArrival: number
  warnMinutesBefore: number
  criticalMinutesBefore: number
}

/**
 * The organization's schedule.
 *
 * `Partial` on purpose: a check with no schedule is not swept. A business that
 * has never decided when a contract should be signed should be asked, not
 * given a threshold and an alert about it at 06:00.
 */
export type NeverForgetPolicy = Readonly<
  Partial<Record<NeverForgetCheck, NeverForgetSchedule>>
>

export interface NeverForgetInput {
  facts: BookingFacts
  policy: NeverForgetPolicy
  context: DetectorContext
}

/** Which fact answers which check. One fact, never a second copy of it. */
function factFor(facts: BookingFacts, check: NeverForgetCheck): Decided | null {
  switch (check) {
    case 'contract_unsigned':
      return facts.contract
    case 'deposit_unrecorded':
      return facts.paymentRequirement
    case 'cleaner_not_accepted':
      return facts.cleanerAcceptance
    case 'laundry_unconfirmed':
      return facts.laundry
    case 'access_code_missing':
      return facts.access
    case 'arrival_info_unreleased':
      return facts.arrivalInstructions
    case 'inspection_missing':
      return facts.inspection
    case 'guest_details_incomplete':
      return facts.guestDetails
  }
}

/**
 * The sweep over one booking.
 *
 * Nothing is emitted for a check whose module is off, whose fact does not
 * apply, whose schedule the organization has not set, or which is simply done.
 * Nothing is emitted before the deadline is near either: a contract that is
 * unsigned nine days out is not a problem, it is a Tuesday.
 */
export function sweepBooking(input: NeverForgetInput): Signal[] {
  const { facts, policy, context } = input
  if (facts.arrivalAt === null) {
    // With no arrival there is nothing to count back from. Reported as silence
    // rather than as a signal about missing data: the booking screen already
    // shows an arrival date that is not set, and a second voice saying so in
    // the exception list is noise.
    return []
  }

  const signals: Signal[] = []

  for (const check of NEVER_FORGET_CHECKS) {
    const spec = SPECS[check]
    if (
      spec.module !== null &&
      !isModuleEnabled(context.modules, spec.module)
    ) {
      continue
    }

    const schedule = policy[check]
    if (schedule === undefined) continue

    const decided = factFor(facts, check)
    if (decided === null || decided.met) continue

    const verdict = gradeRelativeExpectation(
      { key: check, label: spec.label, satisfiedAt: null },
      {
        anchorAt: facts.arrivalAt,
        hoursBefore: schedule.hoursBeforeArrival,
        warnMinutesBefore: schedule.warnMinutesBefore,
        criticalMinutesBefore: schedule.criticalMinutesBefore,
      },
      context.now,
      context.timeZone,
    )

    // Still comfortably ahead of the deadline. Sweeping is not the same as
    // nagging, and a list that includes everything not yet done is a list
    // identical to the booking form.
    if (verdict.state === 'on_track' || verdict.state === 'ready') continue

    const evidence: Evidence[] = [
      evidenceFrom(check, spec.label, decided),
      ...verdict.evidence,
    ]

    signals.push({
      code: spec.code,
      domain: spec.domain,
      risk: verdict.state,
      resourceType: 'booking',
      resourceId: facts.bookingId,
      propertyId: facts.propertyId,
      title: `${facts.label} — ${spec.label}`,
      detail: decided.detail.length > 0 ? decided.detail : spec.detail,
      evidence,
      // The check, not the severity and not the moment. The same unsigned
      // contract escalating from at_risk to critical is one problem all
      // afternoon; a key carrying the risk state would open a second row for
      // it at the worst possible moment.
      dedupeKey: signalKey({
        code: spec.code,
        resourceType: 'booking',
        resourceId: facts.bookingId,
        aspect: check,
      }),
      dueAt: verdict.deadline.targetAt,
      warnAt: verdict.deadline.warnAt,
      criticalAt: verdict.deadline.criticalAt,
    })
  }

  return signals
}

/** The sweep over a day's bookings. */
export function sweep(
  bookings: readonly BookingFacts[],
  policy: NeverForgetPolicy,
  context: DetectorContext,
): Signal[] {
  return bookings.flatMap((facts) => sweepBooking({ facts, policy, context }))
}
