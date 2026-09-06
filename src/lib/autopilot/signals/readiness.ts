/**
 * Booking Health and Property Readiness, as one model.
 *
 * ── Why one model and not two ─────────────────────────────────────────────
 *
 * "Is this booking ready" and "is this unit ready" are the same eleven
 * questions asked of two subjects. Written twice they diverge within a month —
 * one of them counts the inspection and the other does not — and the screen
 * then shows a booking at 100% sitting on a property at 80% with no way to
 * tell which is lying. So the requirements are declared once, evaluated once,
 * and a subject with no guest simply reports the guest-shaped requirements as
 * `not_applicable`.
 *
 * ── The denominator is the whole argument ─────────────────────────────────
 *
 * A requirement for a module the organization does not have is
 * `not_applicable` and LEAVES THE DENOMINATOR. A business with laundry
 * switched off must not sit permanently at 87% and conclude the product is
 * broken, and one that has never signed a contract in its life must not be
 * told every Friday that its contracts are outstanding.
 *
 * `percent` is `met / applicable`. Both numbers are on the object, every
 * requirement carries the evidence that decided it, and there is no private
 * denominator anywhere — so a manager who disagrees with 78% can find the line
 * they disagree with instead of learning to ignore the number.
 *
 * When nothing applies, `percent` is `null`. Not 100: a business that has
 * switched everything off is not fully ready, it is unmeasured, and reporting
 * a perfect score for an empty checklist is the most confident kind of lie.
 *
 * ── This file does not know what time it is ───────────────────────────────
 *
 * Readiness is a state, not a deadline. Low readiness at nine in the morning
 * is a normal Friday and low readiness two hours before arrival is an
 * emergency — `preparation/readiness.ts` makes that point first, and the
 * difference is entirely a question about the clock. So `risk` here is derived
 * from the requirements alone and never reaches `critical`; `arrival-risk.ts`
 * is what adds the clock, and it is the only thing that does. Two files
 * grading urgency would be two answers to "how bad is this".
 */

import type { AutopilotRiskState } from '../../contracts/states'
import type { Readiness, ReadinessRequirement } from '../types'

import {
  evidenceFrom,
  type BookingFacts,
  type Decided,
  type PropertyFacts,
} from './facts'
import {
  isModuleEnabled,
  type EnabledModules,
  type SignalModule,
} from './modules'

/**
 * The eleven, in the order a person would walk them.
 *
 * The guest's own obligations first, then the money, then the house, then the
 * two things that happen last and are forgotten most: the code and the
 * instructions. The order is presentation and nothing reads an index off it —
 * `AUTOPILOT_DOMAINS` is where priority lives.
 */
export const READINESS_REQUIREMENTS = [
  'guest_confirmation',
  'contract_signed',
  'payment_requirement',
  'guest_details',
  'preparation_generated',
  'cleaning',
  'laundry',
  'inventory',
  'maintenance',
  'access',
  'arrival_instructions',
] as const

export type ReadinessRequirementKey = (typeof READINESS_REQUIREMENTS)[number]

interface RequirementSpec {
  label: string
  /** `null` for the core product, which every organization has. */
  module: SignalModule | null
  /**
   * Would a guest walking in right now hit this.
   *
   * Not the same as "important". An unsigned contract blocks an arrival
   * because the business is exposed the moment the guest is inside; a
   * preparation plan that was never generated does not, because the plan is
   * how the work is organised and not the work. The distinction is what lets
   * a screen sort by what actually stops somebody at the door.
   */
  blocksArrival: boolean
}

const SPECS: Readonly<Record<ReadinessRequirementKey, RequirementSpec>> = {
  guest_confirmation: {
    label: 'אישור האורח',
    module: 'guest_portal',
    // The guest arrives whether or not they pressed the button.
    blocksArrival: false,
  },
  contract_signed: {
    label: 'חתימה על החוזה',
    module: 'contracts',
    blocksArrival: true,
  },
  payment_requirement: {
    label: 'דרישת התשלום',
    module: 'payments',
    blocksArrival: true,
  },
  guest_details: {
    label: 'פרטי האורח',
    module: null,
    blocksArrival: false,
  },
  preparation_generated: {
    label: 'תוכנית ההכנה',
    module: 'preparation',
    blocksArrival: false,
  },
  cleaning: { label: 'ניקיון', module: 'cleaning', blocksArrival: true },
  laundry: { label: 'כביסה', module: 'laundry', blocksArrival: true },
  inventory: { label: 'מלאי', module: 'inventory', blocksArrival: true },
  maintenance: { label: 'תחזוקה', module: 'maintenance', blocksArrival: true },
  access: { label: 'כניסה לנכס', module: 'access', blocksArrival: true },
  arrival_instructions: {
    label: 'הוראות הגעה',
    module: 'guest_portal',
    // A guest who cannot find the house is stopped at the door as surely as
    // one whose code does not work.
    blocksArrival: true,
  },
}

export const REQUIREMENT_LABEL: Readonly<
  Record<ReadinessRequirementKey, string>
> = Object.fromEntries(
  READINESS_REQUIREMENTS.map((key) => [key, SPECS[key].label]),
) as Readonly<Record<ReadinessRequirementKey, string>>

export interface ReadinessInput<T> {
  facts: T
  modules: EnabledModules
}

/** Booking Health: the eleven asked of one booking. */
export function bookingReadiness(
  input: ReadinessInput<BookingFacts>,
): Readiness {
  const { facts } = input
  return assemble(
    { type: 'booking', id: facts.bookingId },
    {
      guest_confirmation: facts.guestConfirmation,
      contract_signed: facts.contract,
      payment_requirement: facts.paymentRequirement,
      guest_details: facts.guestDetails,
      preparation_generated: facts.preparation,
      cleaning: facts.cleaning,
      laundry: facts.laundry,
      inventory: facts.inventory,
      maintenance: facts.maintenance,
      access: facts.access,
      arrival_instructions: facts.arrivalInstructions,
    },
    input.modules,
  )
}

/**
 * Property Readiness: the same eleven asked of a unit with nobody in it.
 *
 * The five guest-shaped requirements are `null` and therefore
 * `not_applicable`, which is not a special case in the arithmetic — it is the
 * same rule that drops laundry for a business that has none.
 */
export function propertyReadiness(
  input: ReadinessInput<PropertyFacts>,
): Readiness {
  const { facts } = input
  return assemble(
    { type: 'property', id: facts.propertyId },
    {
      guest_confirmation: null,
      contract_signed: null,
      payment_requirement: null,
      guest_details: null,
      preparation_generated: facts.preparation,
      cleaning: facts.cleaning,
      laundry: facts.laundry,
      inventory: facts.inventory,
      maintenance: facts.maintenance,
      access: facts.access,
      arrival_instructions: null,
    },
    input.modules,
  )
}

function assemble(
  subject: { type: 'booking' | 'property'; id: string },
  decided: Readonly<Record<ReadinessRequirementKey, Decided | null>>,
  modules: EnabledModules,
): Readiness {
  const requirements = READINESS_REQUIREMENTS.map((key) =>
    evaluate(key, decided[key], modules),
  )

  const applicableRequirements = requirements.filter(
    (requirement) => requirement.status !== 'not_applicable',
  )
  const applicable = applicableRequirements.length
  const met = applicableRequirements.filter(
    (requirement) => requirement.status === 'met',
  ).length

  return {
    subject,
    requirements,
    applicable,
    met,
    percent: applicable === 0 ? null : Math.round((met / applicable) * 100),
    risk: riskFrom(applicableRequirements),
  }
}

/**
 * One requirement, and the two separate ways it can fail to apply.
 *
 * The module being off is the organization's answer; the fact being `null` is
 * this booking's answer. Both produce `not_applicable`, and both say which it
 * was — because "אין מודול כביסה" and "לא נדרשת כביסה להזמנה הזו" send a
 * confused manager to two different screens.
 */
function evaluate(
  key: ReadinessRequirementKey,
  decided: Decided | null,
  modules: EnabledModules,
): ReadinessRequirement {
  const spec = SPECS[key]

  if (spec.module !== null && !isModuleEnabled(modules, spec.module)) {
    return {
      key,
      label: spec.label,
      status: 'not_applicable',
      evidence: [
        {
          key: `${key}.module_off`,
          label: spec.label,
          value: false,
          source: 'modules',
        },
      ],
    }
  }

  if (decided === null) {
    return {
      key,
      label: spec.label,
      status: 'not_applicable',
      evidence: [
        {
          key: `${key}.not_required`,
          label: spec.label,
          value: null,
          source: 'facts',
        },
      ],
    }
  }

  // `at_risk` is not `met`. A cleaner who has accepted and not started has not
  // cleaned the house, and counting a job in progress toward the numerator is
  // how a screen reaches 100% with the beds untouched.
  const status: ReadinessRequirement['status'] = decided.met
    ? 'met'
    : decided.atRisk === true
      ? 'at_risk'
      : 'unmet'

  return {
    key,
    label: spec.label,
    status,
    evidence: [evidenceFrom(key, spec.label, decided)],
    blocksArrival: spec.blocksArrival,
  }
}

/**
 * How this subject is tracking, from the requirements and nothing else.
 *
 * `critical` is deliberately unreachable here. Nothing in a list of statuses
 * can tell you a thing is critical — that word means "there is not enough time
 * left", which is a question about the clock and belongs to `arrival-risk.ts`.
 * A readiness figure that graded itself critical would be a second opinion
 * about urgency, and the screen would have to choose between them.
 *
 * Nothing applicable is reported as `ready` rather than as a risk: a business
 * that has switched every module off has nothing that can go wrong, and
 * alarming it about its own configuration through a risk state is not the
 * place to have that conversation.
 */
function riskFrom(
  applicable: readonly ReadinessRequirement[],
): AutopilotRiskState {
  if (applicable.length === 0) return 'ready'
  if (applicable.every((requirement) => requirement.status === 'met')) {
    return 'ready'
  }
  const troubled = applicable.filter(
    (requirement) => requirement.status !== 'met',
  )
  const blocking = troubled.some(
    (requirement) => requirement.blocksArrival === true,
  )
  const anyAtRisk = troubled.some(
    (requirement) => requirement.status === 'at_risk',
  )
  return blocking || anyAtRisk ? 'at_risk' : 'on_track'
}

/**
 * The requirements a person still has to do something about.
 *
 * Not a filter a caller should write for themselves: "outstanding" must mean
 * the same thing on the arrival screen, in the never-forget sweep and in the
 * daily brief, and `not_applicable` must never appear in any of them.
 */
export function outstandingRequirements(
  readiness: Readiness,
): readonly ReadinessRequirement[] {
  return readiness.requirements.filter(
    (requirement) =>
      requirement.status === 'unmet' || requirement.status === 'at_risk',
  )
}

/** Of those, the ones that would stop a guest at the door. */
export function blockingRequirements(
  readiness: Readiness,
): readonly ReadinessRequirement[] {
  return outstandingRequirements(readiness).filter(
    (requirement) => requirement.blocksArrival === true,
  )
}
