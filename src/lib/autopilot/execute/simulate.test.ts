/**
 * The simulation recorder, held to the one property that makes it worth
 * running: it tells the truth about what would have happened, including the
 * parts a business would rather not read.
 */

import { describe, expect, it } from 'vitest'

import type { PlannedAction } from '../types'

import { createCommandRegistry } from './registry'
import { simulateAction, simulationResult } from './simulate'

const ORG = 'org-estia'

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'simulation',
    confidence: 'high',
    reason: 'נותרו שש מגבות והאספקה מאחרת בשעתיים',
    triggerEvent: null,
    evidence: [
      {
        key: 'stock.projected',
        label: 'מלאי צפוי',
        value: 6,
        source: 'inventory',
        observedAt: '2026-09-06T05:40:00.000Z',
      },
    ],
    command: 'laundry.draftOrder',
    commandInput: {},
    idempotencyKey: 'evt-1::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

const wired = createCommandRegistry({
  'laundry.draftOrder': async () => ({ ok: true }),
})

describe('simulateAction', () => {
  it('carries the same reason and evidence a live run would have carried', () => {
    const action = planned()
    const simulated = simulateAction(action, wired)

    expect(simulated.reason).toBe(action.reason)
    expect(simulated.evidence).toEqual(action.evidence)
    expect(simulated.wouldHaveRun).toBe(true)
    expect(simulated.wouldHave).toContain('היה מבצע אוטומטית')
    expect(simulated.wouldHave).toContain('הכנת הזמנת כביסה')
  })

  it('says which of the three things would have happened', () => {
    expect(
      simulateAction(planned({ disposition: 'ask_approval' }), wired).wouldHave,
    ).toContain('היה מכין לאישור')

    expect(
      simulateAction(planned({ disposition: 'suggest' }), wired).wouldHave,
    ).toContain('היה מציע')
  })

  it('admits that an unimplemented command would have failed', () => {
    const simulated = simulateAction(
      planned({
        kind: 'guest.send_reminder',
        safetyLevel: 'external_communication',
        command: 'messaging.sendGuestMessage',
      }),
      wired,
    )

    // A review screen showing fourteen tidy successes for actions that would
    // all have hit `command_not_implemented` sells an automation that does not
    // work, and the business finds out in production.
    expect(simulated.wouldHaveRun).toBe(false)
    expect(simulated.wouldHave).toContain('אינה ממומשת')
  })

  it('does not call a command-less action a failure', () => {
    const simulated = simulateAction(
      planned({
        kind: 'exception.raise',
        safetyLevel: 'information',
        command: null,
      }),
      wired,
    )

    expect(simulated.wouldHaveRun).toBe(true)
    expect(simulated.command).toBeNull()
  })
})

describe('simulationResult', () => {
  it('is a plain record, so what is written is what is read back', () => {
    const result = simulationResult(simulateAction(planned(), wired))

    expect(result.simulated).toBe(true)
    expect(result.command).toBe('laundry.draftOrder')
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})
