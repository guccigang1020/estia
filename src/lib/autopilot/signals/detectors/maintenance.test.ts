import { describe, expect, it } from 'vitest'

import { PROPERTY_TIME_ZONE } from '../../../booking/dates'
import { AUTOPILOT_DOMAINS } from '../../../contracts/states'
import type { DetectorContext } from '../facts'
import { ALL_MODULES, NO_MODULES, type EnabledModules } from '../modules'

import { detectMaintenance, type MaintenanceFacts } from './maintenance'

const NOW = new Date('2026-09-12T10:00:00.000Z')

function context(modules: EnabledModules = ALL_MODULES): DetectorContext {
  return { modules, now: NOW, timeZone: PROPERTY_TIME_ZONE }
}

function issue(overrides: Partial<MaintenanceFacts> = {}): MaintenanceFacts {
  return {
    issueId: 'issue-1',
    propertyId: 'villa-1',
    label: 'וילה ים',
    title: 'דוד המים אינו מחמם',
    status: 'assigned',
    safetyCritical: false,
    blocksUse: false,
    dueAt: '2026-09-13T09:00:00.000Z',
    nextArrivalAt: '2026-09-12T12:00:00.000Z',
    ...overrides,
  }
}

describe('detectMaintenance', () => {
  it('says nothing for a business with no maintenance module', () => {
    expect(
      detectMaintenance([issue({ safetyCritical: true })], context(NO_MODULES)),
    ).toHaveLength(0)
  })

  it('says nothing about a closed issue', () => {
    for (const status of ['completed', 'verified', 'cancelled'] as const) {
      expect(
        detectMaintenance([issue({ status, safetyCritical: true })], context()),
      ).toHaveLength(0)
    }
  })

  it('says nothing about an ordinary issue still within its date', () => {
    expect(detectMaintenance([issue()], context())).toHaveLength(0)
  })
})

describe('safety', () => {
  it('goes to the domain the whole triage puts first', () => {
    const signal = detectMaintenance(
      [issue({ safetyCritical: true })],
      context(),
    )[0]
    expect(signal?.domain).toBe('safety')
    expect(signal?.risk).toBe('critical')
    expect(AUTOPILOT_DOMAINS.indexOf('safety')).toBe(0)
  })

  it('is one row and not three', () => {
    const signals = detectMaintenance(
      [
        issue({
          safetyCritical: true,
          blocksUse: true,
          dueAt: '2026-09-01T09:00:00.000Z',
        }),
      ],
      context(),
    )
    expect(signals).toHaveLength(1)
    expect(signals[0]?.code).toBe('maintenance.safety_issue_open')
  })

  it('is never softened by a comfortable deadline', () => {
    const signal = detectMaintenance(
      [issue({ safetyCritical: true, dueAt: '2026-12-01T09:00:00.000Z' })],
      context(),
    )[0]
    expect(signal?.risk).toBe('critical')
  })
})

describe('blocking use', () => {
  it('is critical when somebody is due to walk in', () => {
    const signal = detectMaintenance([issue({ blocksUse: true })], context())[0]
    expect(signal?.code).toBe('maintenance.blocks_use')
    expect(signal?.risk).toBe('critical')
  })

  it('is at risk when nobody is', () => {
    const signal = detectMaintenance(
      [issue({ blocksUse: true, nextArrivalAt: null })],
      context(),
    )[0]
    expect(signal?.risk).toBe('at_risk')
  })
})

describe('overdue', () => {
  it('is raised once the date for dealing with it has passed', () => {
    const signal = detectMaintenance(
      [issue({ dueAt: '2026-09-11T09:00:00.000Z' })],
      context(),
    )[0]
    expect(signal?.code).toBe('maintenance.overdue')
  })
})

describe('keys', () => {
  it('are stable and keyed on the fault', () => {
    const facts = issue({ safetyCritical: true })
    const first = detectMaintenance([facts], context())[0]
    const later = detectMaintenance([facts], {
      ...context(),
      now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
    })[0]
    expect(first?.dedupeKey).toBe(later?.dedupeKey)
    expect(first?.dedupeKey).toBe(
      'maintenance.safety_issue_open:maintenance_issue:issue-1',
    )
  })
})
