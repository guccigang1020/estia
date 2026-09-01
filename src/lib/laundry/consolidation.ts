/**
 * One van, several houses, and a breakdown that survives the journey.
 *
 * ── The rule, and why it is the whole file ────────────────────────────────
 *
 * A management company running four properties in the Galilee sends one
 * collection on Thursday. Consolidating is obviously right — four vans for
 * four houses is four times the cost — and the specification attaches one
 * condition to it, which is the only interesting thing here:
 *
 *   **the per-property breakdown is preserved, never collapsed into a total.**
 *
 * The reason is the driver. "74 מערכות מצעים" is not a delivery instruction;
 * it is a number somebody has to take apart again at the back of a van, in the
 * dark, at seven in the morning. "30 לאחוזת הגליל, 44 לבית הכרמל" is the
 * delivery. And when 74 come back and 70 are counted, a total cannot tell
 * anybody which house is short.
 *
 * So `ConsolidatedRun.properties` is the record and `totals` is DERIVED from
 * it. Not the other way round, not both stored independently, and not a total
 * with an optional breakdown attached. `consolidation.test.ts` asserts that
 * every total can be reconstructed from the breakdown and that no property
 * disappears from a run it contributed to.
 *
 * ── What may share a run ──────────────────────────────────────────────────
 *
 * Same provider, same route, and required-by dates on the same day. Not
 * "within 24 hours" — a run's `requiredBy` is the TIGHTEST of its members, so
 * grouping two properties whose deadlines are a day apart would hold the
 * earlier one to the later one's collection or send the later one a day early.
 * Grouping by calendar day is the coarsest grouping under which the tightest
 * deadline is still the right deadline for everybody in the group.
 */

import { earliest, isoDay } from './dates'
import type {
  ConsolidatedRun,
  ConsolidatedTotal,
  LaundryRequirement,
  PropertyBreakdown,
} from './types'

/**
 * Group requirements into runs.
 *
 * One run per (provider, route, required-by day). A requirement with no
 * provider still forms a run — that is an internal batch, and it consolidates
 * across properties for exactly the same reason an external one does: one
 * person carrying linen from four houses is one trip.
 */
export function consolidate(
  requirements: readonly LaundryRequirement[],
): readonly ConsolidatedRun[] {
  const groups = new Map<string, LaundryRequirement[]>()

  for (const requirement of requirements) {
    const key = runKey(requirement)
    const existing = groups.get(key)
    if (existing) existing.push(requirement)
    else groups.set(key, [requirement])
  }

  return [...groups.values()]
    .map(buildRun)
    .sort((a, b) => (a.requiredBy < b.requiredBy ? -1 : 1))
}

/** The grouping key. Provider, route, and the calendar day it is needed. */
export function runKey(requirement: LaundryRequirement): string {
  return [
    requirement.providerId ?? '',
    requirement.route,
    isoDay(requirement.requiredBy),
  ].join(' ')
}

function buildRun(members: readonly LaundryRequirement[]): ConsolidatedRun {
  const first = members[0]

  // `consolidate` only ever calls this with a non-empty group, but a run with
  // no members has no provider, no route and no deadline, and inventing them
  // would produce an empty order somebody could send.
  if (!first) {
    return {
      providerId: null,
      route: 'internal',
      requiredBy: '',
      properties: [],
      totals: [],
      totalUnits: 0,
    }
  }

  const byProperty = new Map<string, LaundryRequirement[]>()
  for (const member of members) {
    const existing = byProperty.get(member.propertyId)
    if (existing) existing.push(member)
    else byProperty.set(member.propertyId, [member])
  }

  const properties: PropertyBreakdown[] = [...byProperty.entries()]
    .map(([propertyId, lines]) => ({
      propertyId,
      requiredBy: lines.reduce(
        (tightest, line) => earliest(tightest, line.requiredBy),
        '',
      ),
      lines,
      units: lines.reduce((sum, line) => sum + line.quantity, 0),
    }))
    .sort((a, b) => (a.propertyId < b.propertyId ? -1 : 1))

  return {
    providerId: first.providerId,
    route: first.route,
    // The TIGHTEST deadline in the run. Taking the latest would produce an
    // order that is on time for the run and late for one of its members.
    requiredBy: properties.reduce(
      (tightest, property) => earliest(tightest, property.requiredBy),
      '',
    ),
    properties,
    totals: totalsFrom(properties),
    totalUnits: properties.reduce((sum, property) => sum + property.units, 0),
  }
}

/**
 * The per-item totals, computed from the breakdown.
 *
 * Exported so a test can assert the relationship rather than trust it, and so
 * a screen that has a breakdown never has to sum one itself and risk summing
 * it differently.
 */
export function totalsFrom(
  properties: readonly PropertyBreakdown[],
): readonly ConsolidatedTotal[] {
  const byItem = new Map<string, ConsolidatedTotal>()

  for (const property of properties) {
    for (const line of property.lines) {
      const existing = byItem.get(line.itemId)

      if (!existing) {
        byItem.set(line.itemId, {
          itemId: line.itemId,
          label: line.label,
          unit: line.unit,
          quantity: line.quantity,
          byProperty: [
            { propertyId: property.propertyId, quantity: line.quantity },
          ],
          explanation: [...line.explanation],
        })
        continue
      }

      byItem.set(line.itemId, {
        ...existing,
        quantity: existing.quantity + line.quantity,
        byProperty: [
          ...existing.byProperty,
          { propertyId: property.propertyId, quantity: line.quantity },
        ],
      })
    }
  }

  // The aggregate step is added last, once every property has contributed, so
  // the sentence names the real breakdown rather than a partial one.
  return [...byItem.values()].map((total) => ({
    ...total,
    explanation: [
      ...total.explanation,
      {
        kind: 'aggregate' as const,
        text: `${total.quantity} ${total.label} בסך הכול: ${total.byProperty
          .map((part) => `${part.quantity} לנכס ${part.propertyId}`)
          .join(', ')}.`,
        value: total.quantity,
      },
    ],
  }))
}

/**
 * Does this run reach a provider's minimum.
 *
 * Reported rather than enforced. A provider who will not send a van for six
 * towels is an operational fact, and the right response is usually to wait a
 * day or add a property — decisions a person makes. Refusing to build the
 * order would leave somebody with a shortage and no record of why.
 */
export function meetsMinimum(
  run: ConsolidatedRun,
  minimumOrderUnits: number,
): boolean {
  return run.totalUnits >= minimumOrderUnits
}
