/**
 * The Hebrew maps are partial, so these are the assertions that close them.
 *
 * A `Partial<Record<DomainEventName, string>>` cannot be exhaustive at compile
 * time without eighty-six labels nobody will read. What it can be is complete
 * *against the thing that generates the demand*, and that is checkable: every
 * trigger the library actually uses, every grant the action catalogue actually
 * demands, and every trigger the preview cannot reconstruct. Add a template
 * with a new trigger and one of these fails, which is the same guarantee
 * exhaustiveness would have given, aimed at the part that matters.
 *
 * `SIMULATED_TRIGGERS` gets the strongest of them: it is asserted against what
 * `candidateEvents` really produces, from rows built to reach every branch, so
 * a trigger added to the simulation and not to the list is caught rather than
 * quietly rendered as "the preview cannot reconstruct this".
 */

import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_TEMPLATES,
  actionGrant,
  libraryTriggers,
} from '@/lib/automation'
import type { DomainEventName } from '@/lib/contracts/events'

import { candidateEvents, type DryRunRows } from './dry-run'
import {
  ACTION_GRANT_LABEL,
  NOT_SIMULATED_REASON,
  SIMULATED_TRIGGERS,
  TRIGGER_LABEL,
  describeConditionInHebrew,
  factLabel,
  isSimulatedTrigger,
  notSimulatedReason,
  triggerLabel,
} from './labels'

const ORGANIZATION = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-05-20T09:00:00.000Z')

describe('the trigger labels', () => {
  it('covers every trigger the library listens to', () => {
    const missing = libraryTriggers().filter(
      (trigger) => TRIGGER_LABEL[trigger] === undefined,
    )
    expect(missing).toEqual([])
  })

  it('falls back to the catalogue name rather than to a polite placeholder', () => {
    // A label nobody wrote must be findable. "אירוע" would hide which one.
    const unlabelled = 'booking.no_show' satisfies DomainEventName
    expect(TRIGGER_LABEL[unlabelled]).toBeUndefined()
    expect(triggerLabel(unlabelled)).toBe(unlabelled)
  })
})

describe('the action permission labels', () => {
  it('covers every grant the action catalogue can demand', () => {
    const missing = AUTOMATION_ACTION_KINDS.map(actionGrant).filter(
      (grant) => ACTION_GRANT_LABEL[grant] === undefined,
    )
    expect(missing).toEqual([])
  })
})

describe('describeConditionInHebrew', () => {
  it('names the fact in Hebrew and leaves the operator to the domain', () => {
    expect(
      describeConditionInHebrew({
        kind: 'at_least',
        field: 'nights',
        value: 2,
      }),
    ).toBe('מספר הלילות ≥ 2')
  })

  it('handles an operator that carries no right-hand side', () => {
    expect(
      describeConditionInHebrew({ kind: 'is_absent', field: 'status' }),
    ).toBe('סטטוס אינו קיים')
  })

  it('leaves an unlabelled fact as its own key rather than inventing a reading', () => {
    expect(factLabel('agent_user_id')).toBe('agent_user_id')
    expect(
      describeConditionInHebrew({
        kind: 'is_present',
        field: 'agent_user_id',
      }),
    ).toBe('agent_user_id קיים')
  })
})

describe('SIMULATED_TRIGGERS', () => {
  /**
   * Rows that reach every branch of `candidateEvents`.
   *
   * Deliberately not the demo dataset: the demo has no cancelled-and-arriving
   * stay on the same day, and a list derived from whatever the demo happens to
   * contain would drift with somebody else's fixture.
   */
  const rows: DryRunRows = {
    bookings: [
      booking('confirmed', 0, 3),
      booking('deposit_paid', 2, 5),
      booking('checked_out', -6, -2),
      booking('completed', -12, -8),
      booking('cancelled', 4, 6),
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'ניקיון יציאה',
        status: 'assigned',
        dueAt: '2026-05-19T09:00:00.000Z',
        propertyId: 'property-1',
      },
    ],
    payments: [
      {
        id: 'payment-1',
        status: 'failed',
        requiresAttention: false,
        reference: 'BA-1',
        propertyId: 'property-1',
      },
      {
        id: 'payment-2',
        status: 'pending',
        requiresAttention: true,
        reference: 'BA-2',
        propertyId: 'property-1',
      },
    ],
  }

  it('lists exactly the triggers the preview can reconstruct', () => {
    const produced = new Set(
      candidateEvents(ORGANIZATION, rows, NOW).map(
        (candidate) => candidate.event.name,
      ),
    )

    expect([...produced].sort()).toEqual([...SIMULATED_TRIGGERS].sort())
  })

  it('gives every library trigger it cannot reconstruct a reason of its own', () => {
    const unreachable = libraryTriggers().filter(
      (trigger) => !isSimulatedTrigger(trigger),
    )

    expect(unreachable.length).toBeGreaterThan(0)
    for (const trigger of unreachable) {
      expect(NOT_SIMULATED_REASON[trigger]).toBeDefined()
      // The generic fallback exists so the type is total, and no shipped
      // trigger may fall through to it.
      expect(notSimulatedReason(trigger)).toBe(NOT_SIMULATED_REASON[trigger])
    }
  })

  it('does not claim a template exists for every simulated trigger', () => {
    // `booking.cancelled` is derivable and no template listens to it. The list
    // describes the simulation's reach, not the library's, and conflating the
    // two would make one of them wrong the day either changes.
    expect(SIMULATED_TRIGGERS).toContain('booking.cancelled')
    expect(
      AUTOMATION_TEMPLATES.some(
        (template) => template.rule.when === 'booking.cancelled',
      ),
    ).toBe(false)
  })
})

function booking(
  status: string,
  checkInOffset: number,
  checkOutOffset: number,
) {
  return {
    id: `booking-${status}`,
    reference: `BA-${status}`,
    status,
    checkIn: dayFrom(checkInOffset),
    checkOut: dayFrom(checkOutOffset),
    propertyId: 'property-1',
    source: 'direct_website',
  }
}

function dayFrom(offset: number): string {
  return new Date(NOW.getTime() + offset * 86_400_000)
    .toISOString()
    .slice(0, 10)
}
