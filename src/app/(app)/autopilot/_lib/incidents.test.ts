/**
 * One laundry van, one incident — and the three cases the naive version
 * gets wrong.
 */

import { describe, expect, it } from 'vitest'

import type { ExceptionView } from '@/components/autopilot/views'

import { groupByRootCause, incidentSize } from './incidents'

function row(id: string, causedBy: string | null = null): ExceptionView {
  return {
    id,
    code: 'laundry.delivery_late',
    domain: 'laundry',
    risk: 'critical',
    state: 'new',
    title: id,
    detail: '',
    resourceType: 'laundry_order',
    resourceId: null,
    propertyId: null,
    propertyName: null,
    evidence: [],
    causedBy,
    dueAt: null,
    warnAt: null,
    criticalAt: null,
    ownerUserId: null,
    ownerName: null,
    firstSeenAt: '2026-09-06T06:00:00Z',
    lastSeenAt: '2026-09-06T06:00:00Z',
    seenCount: 1,
  }
}

describe('groupByRootCause', () => {
  it('hangs a four-link chain from one root', () => {
    const incidents = groupByRootCause([
      row('delay'),
      row('shortage', 'delay'),
      row('preparation', 'shortage'),
      row('arrival', 'preparation'),
    ])

    expect(incidents).toHaveLength(1)
    expect(incidents[0].root.id).toBe('delay')
    expect(incidents[0].consequences.map((c) => c.id)).toEqual([
      'shortage',
      'preparation',
      'arrival',
    ])
    expect(incidentSize(incidents[0])).toBe(4)
  })

  it('keeps a consequence whose root is not in the set', () => {
    // The root was resolved this morning, or belongs to a property outside
    // this reader's scope. The consequence is still open and still shown.
    const incidents = groupByRootCause([row('shortage', 'delay-not-here')])

    expect(incidents).toHaveLength(1)
    expect(incidents[0].root.id).toBe('shortage')
  })

  it('does not lose a row to a cycle', () => {
    const incidents = groupByRootCause([row('a', 'b'), row('b', 'a')])

    const seen = incidents.flatMap((incident) => [
      incident.root.id,
      ...incident.consequences.map((c) => c.id),
    ])
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('never drops a row, whatever the shape', () => {
    const input = [
      row('root'),
      row('child', 'root'),
      row('orphan', 'missing'),
      row('lonely'),
    ]

    const seen = groupByRootCause(input).flatMap((incident) => [
      incident.root.id,
      ...incident.consequences.map((c) => c.id),
    ])

    expect(seen.sort()).toEqual(['child', 'lonely', 'orphan', 'root'])
    expect(seen).toHaveLength(input.length)
  })

  it('preserves the order the query produced', () => {
    // The query ordered by the domain enum, which IS the triage priority. A
    // second sort here would be a second opinion about what matters most.
    const incidents = groupByRootCause([
      row('first'),
      row('second'),
      row('third'),
    ])
    expect(incidents.map((i) => i.root.id)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('places an incident by its root even when a consequence was read first', () => {
    const incidents = groupByRootCause([
      row('consequence', 'root'),
      row('root'),
      row('other'),
    ])

    expect(incidents.map((i) => i.root.id)).toEqual(['root', 'other'])
    expect(incidents[0].consequences.map((c) => c.id)).toEqual(['consequence'])
  })

  it('answers empty for empty', () => {
    expect(groupByRootCause([])).toEqual([])
  })
})
