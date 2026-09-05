/**
 * One window, one reader, one set of insights.
 *
 * Pure: a `DashboardResponse` and the facts behind it go in, an `InsightReport`
 * comes out. No I/O, no clock, no database — the same discipline as
 * `computeDashboard`, and for the same reason. Every decision worth getting
 * wrong here (what a reader may see, what a package includes, what counts as
 * "no data") is testable in milliseconds against no database at all.
 *
 * ── The gate is not re-decided here ───────────────────────────────────────
 *
 * `computeDashboard` already refused every metric this actor may not have, and
 * a refused metric is **absent from `response.metrics`** rather than present
 * with a null. So the availability test in this file is membership of that
 * array and nothing else. `authorize` is consulted for exactly one thing: to
 * say *why* something is missing, because "you may not" and "your package does
 * not include this" are answered by two different people, and a screen that
 * conflated them would send an owner to an administrator who cannot help.
 *
 * That is a copy of the ladder in `tiles.ts`, deliberately, down to the
 * ordering: a plan refusal anywhere in a rule's inputs wins, because a
 * customer who buys the feature gets the insight and a customer who is granted
 * the permission still does not.
 *
 * ── A module that is off contributes nothing, including no zero ───────────
 *
 * `commission_cost` is gated on `commission.view`, which
 * `ENTITLEMENT_FOR_GRANT` ties to `agent_network`. A business with no agent
 * network therefore receives no commission figure from `computeDashboard` at
 * all, `commission_load` lands in `absent` with `reason: 'plan'`, and the
 * screen says the package does not include it. What it does **not** do is
 * render ₪0 — which would be a claim about a business that has never had a
 * commission to pay, made by a system that was never allowed to look.
 */

import { authorize, holdsGrant, type Actor } from '../authz/can'
import type { BookingSource } from '../booking/types'
import {
  METRICS,
  type DashboardResponse,
  type MetricFacts,
  type MetricId,
  type MetricRange,
  type MetricResult,
} from '../metrics'
import type { Entitlement } from '../plans/entitlements'

import { GAPS, INSIGHT_RULES, type RuleInput } from './rules'
import type {
  Insight,
  InsightAbsence,
  InsightDestination,
  InsightReport,
} from './types'

export interface InsightReportArgs {
  actor: Actor
  /** The response `computeDashboard` produced for this actor and window. */
  response: DashboardResponse
  facts: MetricFacts
  baselineFacts: MetricFacts | null
  /** The window in words. Formatted by the screen — this layer has no Intl. */
  periodLabel: string
  baselineLabel: string | null
  sourceLabel: (source: BookingSource) => string
}

/** Why a metric is not in the response, when it is not. */
type Refusal = {
  reason: 'permission' | 'plan'
  entitlement: Entitlement | null
}

function refusalFor(actor: Actor, id: MetricId): Refusal {
  const decision = authorize(actor, METRICS[id].requires)

  if (!decision.allowed && decision.reason === 'plan_does_not_include') {
    return { reason: 'plan', entitlement: decision.entitlement ?? null }
  }

  return { reason: 'permission', entitlement: null }
}

export function buildInsightReport(args: InsightReportArgs): InsightReport {
  const { actor, response, facts, baselineFacts } = args

  const results: ReadonlyMap<MetricId, MetricResult> = new Map(
    response.metrics.map((metric) => [metric.id, metric]),
  )

  const base = {
    range: response.range,
    periodLabel: args.periodLabel,
    gaps: GAPS,
  }

  // Nothing was read, so nothing may be claimed. Not one insight, not one
  // absence blamed on a permission, and above all not a screen of zeroes: an
  // empty source is a statement about the window, and the screen says so once
  // rather than twelve times.
  if (!facts.hasData) {
    return { ...base, insights: [], absent: [], empty: true }
  }

  const input: RuleInput = {
    periodLabel: args.periodLabel,
    baselineLabel: args.baselineLabel,
    results,
    facts,
    baselineFacts,
    canSee: (id) => results.has(id),
    sourceLabel: args.sourceLabel,
  }

  const insights: Insight[] = []
  const absent: InsightAbsence[] = []

  for (const rule of INSIGHT_RULES) {
    const missing = rule.metrics.filter((id) => !results.has(id))

    if (missing.length > 0) {
      const refusals = missing.map((id) => refusalFor(actor, id))
      const planRefusal = refusals.find((refusal) => refusal.reason === 'plan')

      absent.push({
        id: rule.id,
        title: rule.title,
        reason: planRefusal ? 'plan' : 'permission',
        entitlement: planRefusal?.entitlement ?? null,
        // Named, never their grant codes. "report.financial.view" is not a
        // sentence a hotelier can act on; "הכנסות" is.
        metricNames: missing.map((id) => METRICS[id].name),
        explanation: planRefusal
          ? 'החבילה של העסק אינה כוללת את היכולת שמייצרת את הנתון הזה. אין כאן שאלה של הרשאה, ולא מוצג אפס — לא נבדק דבר.'
          : 'הנתון שהתובנה הזאת קוראת אינו בהרשאות שלך, ולכן לא חושב כלל. זה אינו אפס.',
      })
      continue
    }

    const outcome = rule.evaluate(input)

    if (outcome.kind === 'nothing') continue

    if (outcome.kind === 'absent') {
      absent.push({
        id: rule.id,
        title: rule.title,
        reason: outcome.reason,
        entitlement: null,
        metricNames: rule.metrics.map((id) => METRICS[id].name),
        explanation: outcome.explanation,
      })
      continue
    }

    insights.push({
      id: rule.id,
      title: rule.title,
      headline: outcome.headline,
      because: outcome.because,
      tone: outcome.tone,
      evidence: outcome.evidence,
      ...(outcome.caveat === undefined ? {} : { caveat: outcome.caveat }),
      destination: resolveDestination(actor, rule.destination, response.range),
    })
  }

  return { ...base, insights, absent, empty: false }
}

/**
 * The link, attached only when the route behind it would admit this reader.
 *
 * The rule states the destination's own gate grant — the argument to the
 * `requireGrant` call at the top of that route — and this checks it. An
 * insight with no link is an honest card; an insight linking to a redirect is
 * the dead end `tiles.ts` was rewritten to remove.
 */
function resolveDestination(
  actor: Actor,
  destination: ((range: MetricRange) => InsightDestination) | null,
  range: MetricRange,
): InsightDestination | null {
  if (destination === null) return null

  const resolved = destination(range)
  return holdsGrant(actor, resolved.requires) ? resolved : null
}
