/**
 * The header strip, and the difference between zero and unknown.
 *
 * The claim that matters: `null` is not `0`. "כל האורחים שילמו" and "אינך רשאי
 * לראות חובות" are different sentences, and a header that printed ₪0 for the
 * second would tell a manager their guests have paid when in fact nobody asked
 * on their behalf. `listOpenBalances` returns `null` for exactly this and the
 * strip carries it through untouched.
 */

import { describe, expect, it } from 'vitest'

import type {
  DayStay,
  OpenBalance,
} from '@/app/(app)/action-center/_lib/queries'
import type { ExceptionView } from '@/components/autopilot/views'
import type { AutopilotRiskState } from '@/lib/contracts/states'

import { headerStrip } from './queries'
import { PROPERTY_A, PROPERTY_B } from './fixtures'

function stay(id: string, role: DayStay['role']): DayStay {
  return {
    id,
    reference: id,
    role,
    status: 'confirmed',
    propertyId: PROPERTY_A,
    unitId: 'unit-1',
    unitName: null,
    checkIn: '2026-09-06',
    checkOut: '2026-09-08',
    arrivalTime: null,
    guestCount: 2,
    guestNotes: null,
  }
}

function balance(outstanding: number): OpenBalance {
  return {
    bookingId: 'b',
    reference: 'b',
    propertyId: PROPERTY_A,
    role: 'arriving',
    guestName: null,
    billedAgorot: outstanding,
    settledAgorot: 0,
    outstandingAgorot: outstanding,
    unknownAgorot: 0,
  }
}

function exception(
  id: string,
  risk: AutopilotRiskState,
  propertyId: string | null,
): ExceptionView {
  return {
    id,
    code: 'a.b',
    domain: 'preparation',
    risk,
    state: 'new',
    title: id,
    detail: '',
    resourceType: 'booking',
    resourceId: null,
    propertyId,
    propertyName: null,
    evidence: [],
    causedBy: null,
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

describe('headerStrip', () => {
  it('counts arrivals and departures by role', () => {
    const strip = headerStrip(
      [
        stay('a', 'arriving'),
        stay('b', 'arriving'),
        stay('c', 'departing'),
        stay('d', 'in_house'),
      ],
      [],
      [],
    )
    expect(strip.arrivals).toBe(2)
    expect(strip.departures).toBe(1)
  })

  it('counts distinct properties, not exceptions', () => {
    const strip = headerStrip(
      [],
      [],
      [
        exception('1', 'critical', PROPERTY_A),
        exception('2', 'at_risk', PROPERTY_A),
        exception('3', 'critical', PROPERTY_B),
      ],
    )
    expect(strip.propertiesAtRisk).toBe(2)
  })

  it('does not count an organization-wide exception as a property', () => {
    const strip = headerStrip([], [], [exception('1', 'critical', null)])
    expect(strip.propertiesAtRisk).toBe(0)
  })

  it('ignores exceptions the detector did not mark as going wrong', () => {
    const strip = headerStrip(
      [],
      [],
      [
        exception('1', 'ready', PROPERTY_A),
        exception('2', 'on_track', PROPERTY_B),
      ],
    )
    expect(strip.propertiesAtRisk).toBe(0)
  })

  it('reports null, never zero, when the reader may not see money', () => {
    expect(headerStrip([], null, []).outstandingAgorot).toBeNull()
  })

  it('reports zero when there genuinely is nothing owed', () => {
    expect(headerStrip([], [], []).outstandingAgorot).toBe(0)
  })

  it('sums what is owed through the domain’s own addition', () => {
    expect(
      headerStrip([], [balance(12_500), balance(7_500)], []).outstandingAgorot,
    ).toBe(20_000)
  })
})
