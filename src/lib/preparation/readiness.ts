/**
 * How ready is the house, component by component.
 *
 * One percentage for the whole booking is the number a manager glances at and
 * the number that hides the problem: ninety percent ready with the beds
 * untouched is not ninety percent ready. So readiness is reported per
 * component and the overall figure is derived from them, never the other way
 * round.
 *
 * Payment and contract sit in the same list as cleaning and towels on purpose.
 * A spotless house with an unsigned contract is not ready for the guest to
 * walk into, and the person who has to notice that is the same person watching
 * this screen.
 *
 * ── The alert that matters ────────────────────────────────────────────────
 *
 * Low readiness at nine in the morning is a normal Friday. Low readiness two
 * hours before arrival is an emergency, and the difference between the two is
 * the only thing this file is really for. Both thresholds are policy the
 * organization sets, because "two hours" is a long time for a studio and no
 * time at all for a wedding.
 */

import { finalCount } from './adjustment'
import type {
  PlanSectionKey,
  ReadinessAlert,
  ReadinessComponent,
  ReadinessLine,
  ReadinessPolicy,
  ReadinessReport,
  WorkPlan,
} from './types'

const PERCENT_SCALE = 100
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

/**
 * Which sections each component is measured from.
 *
 * `sleeping` deliberately spans both bedroom sections: a house with the
 * permanent beds made and fifteen mattresses still folded in a cupboard is
 * half ready to sleep in, and reporting the two separately lets the first
 * number reach a hundred while nobody can go to bed.
 */
const COMPONENT_SECTIONS: Readonly<
  Record<
    Exclude<ReadinessComponent, 'payment' | 'contract'>,
    readonly PlanSectionKey[]
  >
> = {
  cleaning: ['cleaning', 'final_inspection'],
  sleeping: ['bedrooms', 'extra_sleeping'],
  towels: ['towels'],
  kitchen: ['kitchen'],
}

export interface ReadinessInput {
  plan: WorkPlan
  payment: { paid: number; due: number }
  contractSigned: boolean
  policy: ReadinessPolicy
  /** ISO instant the guest arrives. */
  arrivalAt: string
  now: Date
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const { plan, policy } = input

  const lines: ReadinessLine[] = [
    ...(
      Object.keys(COMPONENT_SECTIONS) as (keyof typeof COMPONENT_SECTIONS)[]
    ).map((component) => sectionLine(plan, component)),
    paymentLine(input.payment),
    contractLine(input.contractSigned),
  ]

  const overallPercent =
    lines.length === 0
      ? PERCENT_SCALE
      : Math.round(
          lines.reduce((total, line) => total + line.percent, 0) / lines.length,
        )

  const hoursToArrival = hoursUntil(input.arrivalAt, input.now)
  const alerts: ReadinessAlert[] = []

  for (const line of lines) {
    if (line.percent < policy.warningPercent) {
      alerts.push({
        severity: 'warning',
        component: line.component,
        message: `${line.detail} — ${line.percent}% מוכן.`,
      })
    }
  }

  if (
    overallPercent < policy.criticalPercent &&
    hoursToArrival <= policy.criticalHours
  ) {
    alerts.unshift({
      severity: 'critical',
      component: 'overall',
      message: `הנכס ${overallPercent}% מוכן והאורחים מגיעים בעוד ${hoursToArrival} שעות.`,
    })
  }

  return { lines, overallPercent, hoursToArrival, alerts }
}

/**
 * A component with nothing to do is finished, not unstarted.
 *
 * A property with no pool must not sit permanently at zero percent pool
 * readiness and drag the overall figure down for ever.
 */
function sectionLine(
  plan: WorkPlan,
  component: keyof typeof COMPONENT_SECTIONS,
): ReadinessLine {
  const keys = new Set<PlanSectionKey>(COMPONENT_SECTIONS[component])
  const sections = plan.sections.filter((section) => keys.has(section.key))

  let required = 0
  let completed = 0

  for (const section of sections) {
    for (const item of section.items) {
      required += finalCount(item)
      // A section a supervisor closed counts as done. The override is recorded
      // on the section; pretending the items are still outstanding would leave
      // the house permanently un-ready after a legitimate decision.
      completed +=
        section.status === 'completed' ? finalCount(item) : item.completedCount
    }
  }

  return {
    component,
    percent:
      required === 0
        ? PERCENT_SCALE
        : Math.round((completed * PERCENT_SCALE) / required),
    detail:
      required === 0
        ? 'אין דרישות פתוחות'
        : `הושלמו ${completed} מתוך ${required} פריטים`,
  }
}

function paymentLine(payment: { paid: number; due: number }): ReadinessLine {
  if (payment.due <= 0) {
    return {
      component: 'payment',
      percent: PERCENT_SCALE,
      detail: 'אין יתרה לתשלום',
    }
  }

  const percent = Math.min(
    PERCENT_SCALE,
    Math.round((payment.paid * PERCENT_SCALE) / payment.due),
  )

  return {
    component: 'payment',
    percent,
    detail: 'סטטוס תשלום',
  }
}

function contractLine(signed: boolean): ReadinessLine {
  return {
    component: 'contract',
    percent: signed ? PERCENT_SCALE : 0,
    detail: signed ? 'החוזה נחתם' : 'החוזה טרם נחתם',
  }
}

/** Never negative: a guest who has already arrived is zero hours away. */
export function hoursUntil(arrivalAt: string, now: Date): number {
  const arrival = Date.parse(arrivalAt)
  if (Number.isNaN(arrival)) return 0
  return Math.max(
    0,
    Math.round((arrival - now.getTime()) / MILLISECONDS_PER_HOUR),
  )
}
