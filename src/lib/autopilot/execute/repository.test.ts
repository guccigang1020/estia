/**
 * The record of what Autopilot did, held to the constraints the table holds.
 *
 * Two things are being proved here. The first is that the in-memory double
 * implements the unique constraint faithfully, because every other test in this
 * directory rests on it — a double that quietly allowed a duplicate would let
 * the most important test in the module pass for the wrong reason.
 *
 * The second is that a row the database would refuse is refused here first. A
 * `suppressed` with no reason and a `failed` with no code are rejected before
 * the write; if they were rejected after it, the message would already have
 * been sent and the only record of it would be the exception in the log.
 */

import { describe, expect, it } from 'vitest'

import type { PlannedAction } from '../types'

import {
  AutopilotActionInvalidError,
  InMemoryAutopilotActionRepository,
  actionFromRow,
  applyPatch,
  evidenceFromJson,
  plannedFromRow,
  rowFromDraft,
  type AutopilotActionDraft,
} from './repository'

const ORG = 'org-estia'
const NOW = new Date('2026-09-06T06:00:00.000Z')

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    kind: 'laundry.draft_order',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    confidence: 'high',
    reason: 'המכבסה מאחרת',
    triggerEvent: null,
    evidence: [],
    command: 'laundry.draftOrder',
    commandInput: {},
    idempotencyKey: 'evt-1::laundry.draft_order',
    correlationId: 'corr-1',
    exceptionDedupeKey: null,
    scheduledFor: null,
    ...overrides,
  }
}

function draft(
  overrides: Partial<AutopilotActionDraft> = {},
): AutopilotActionDraft {
  return {
    planned: planned(),
    outcome: 'planned',
    createdAt: NOW,
    ...overrides,
  }
}

/* ----------------------------------------------------------- uniqueness -- */

describe('the idempotency constraint', () => {
  it('reports the second insert of one key as not created', async () => {
    const repository = new InMemoryAutopilotActionRepository()

    const first = await repository.insert(draft())
    const second = await repository.insert(draft())

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(repository.rows).toHaveLength(1)
  })

  it('scopes the key to the organization', async () => {
    const repository = new InMemoryAutopilotActionRepository()

    await repository.insert(draft())
    const other = await repository.insert(
      draft({ planned: planned({ organizationId: 'org-somebody-else' }) }),
    )

    expect(other.created).toBe(true)
    expect(repository.rows).toHaveLength(2)
  })
})

/* ----------------------------------------------------------- invariants -- */

describe('the invariants', () => {
  it('refuses a suppression with no reason', () => {
    expect(() => rowFromDraft(draft({ outcome: 'suppressed' }), 'a')).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses a failure with no error code', () => {
    expect(() => rowFromDraft(draft({ outcome: 'failed' }), 'a')).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses an execution with no execution time', () => {
    const row = rowFromDraft(draft(), 'a')
    expect(() => applyPatch(row, { outcome: 'executed' })).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses an approval whose two halves do not move together', () => {
    const row = rowFromDraft(draft({ outcome: 'awaiting_approval' }), 'a')
    expect(() => applyPatch(row, { approvedBy: 'user-1' })).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses an undo whose two halves do not move together', () => {
    const row = rowFromDraft(draft(), 'a')
    expect(() => applyPatch(row, { undoneAt: NOW })).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses a simulated run that claims it executed', () => {
    const row = rowFromDraft(
      draft({
        planned: planned({ runMode: 'simulation' }),
        outcome: 'simulated',
      }),
      'a',
    )

    // The schema's `autopilot_actions_simulation_never_executes`, enforced
    // before the write rather than after the WhatsApp.
    expect(() =>
      applyPatch(row, { outcome: 'executed', executedAt: NOW }),
    ).toThrow(AutopilotActionInvalidError)
  })

  it('refuses a live run filed as a simulation', () => {
    const row = rowFromDraft(draft(), 'a')
    expect(() => applyPatch(row, { outcome: 'simulated' })).toThrow(
      AutopilotActionInvalidError,
    )
  })

  it('refuses a blank reason', () => {
    expect(() =>
      rowFromDraft(draft({ planned: planned({ reason: '   ' }) }), 'a'),
    ).toThrow(AutopilotActionInvalidError)
  })

  it('accepts a suppression that names itself', () => {
    const row = rowFromDraft(draft(), 'a')
    const patched = applyPatch(row, {
      outcome: 'suppressed',
      suppressedReason: 'duplicate',
    })
    expect(patched.suppressedReason).toBe('duplicate')
  })
})

/* -------------------------------------------------------------- mapping -- */

describe('mapping', () => {
  it('reads a row back off the wire', () => {
    const row = actionFromRow({
      id: 'action-1',
      organization_id: ORG,
      property_id: 'property-1',
      exception_id: null,
      action_kind: 'laundry.draft_order',
      safety_level: 'safe_internal',
      disposition: 'auto',
      run_mode: 'live',
      outcome: 'executed',
      confidence: 'high',
      reason: 'המכבסה מאחרת',
      trigger_event: null,
      evidence: [
        { key: 'a.b', label: 'ל', value: 3, source: 'laundry' },
        { nonsense: true },
      ],
      command: 'laundry.draftOrder',
      command_input: { propertyId: 'property-1' },
      result: { orderId: 'order-1' },
      suppressed_reason: null,
      error_code: null,
      error_detail: null,
      attempt: 2,
      idempotency_key: 'evt-1',
      correlation_id: 'corr-1',
      requested_by: null,
      approved_by: null,
      approved_at: null,
      scheduled_for: null,
      executed_at: '2026-09-06T06:00:00.000Z',
      undone_at: null,
      undone_by: null,
      created_at: '2026-09-06T05:59:00.000Z',
    })

    expect(row.actionKind).toBe('laundry.draft_order')
    expect(row.attempt).toBe(2)
    expect(row.executedAt).toEqual(new Date('2026-09-06T06:00:00.000Z'))
    // The malformed evidence entry is dropped rather than thrown on: one fewer
    // fact on a screen beats an activity log that will not load.
    expect(row.evidence).toHaveLength(1)
  })

  it('refuses an action kind that is not in the catalogue', () => {
    expect(() =>
      actionFromRow({
        id: 'action-1',
        organization_id: ORG,
        property_id: null,
        exception_id: null,
        action_kind: 'guest.delete_everything',
        safety_level: 'safe_internal',
        disposition: 'auto',
        run_mode: 'live',
        outcome: 'planned',
        confidence: 'high',
        reason: 'x',
        trigger_event: null,
        evidence: [],
        command: null,
        command_input: {},
        result: {},
        suppressed_reason: null,
        error_code: null,
        error_detail: null,
        attempt: 1,
        idempotency_key: 'k',
        correlation_id: null,
        requested_by: null,
        approved_by: null,
        approved_at: null,
        scheduled_for: null,
        executed_at: null,
        undone_at: null,
        undone_by: null,
        created_at: '2026-09-06T05:59:00.000Z',
      }),
    ).toThrow(/not an autopilot action kind/i)
  })

  it('hands a stored row back as the plan it was', () => {
    const row = rowFromDraft(
      draft({
        planned: planned({
          scheduledFor: '2026-09-06T09:00:00.000Z',
          evidence: [
            {
              key: 'stock.projected',
              label: 'מלאי',
              value: 6,
              source: 'inventory',
            },
          ],
        }),
      }),
      'a',
    )

    const back = plannedFromRow(row)

    expect(back.reason).toBe('המכבסה מאחרת')
    expect(back.evidence).toHaveLength(1)
    expect(back.scheduledFor).toBe('2026-09-06T09:00:00.000Z')
    expect(back.idempotencyKey).toBe('evt-1::laundry.draft_order')
  })

  it('keeps only evidence that says where it came from', () => {
    expect(
      evidenceFromJson([
        { key: 'a', source: 'laundry' },
        { key: 'b' },
        { source: 'c' },
        'nonsense',
        null,
      ]),
    ).toEqual([{ key: 'a', label: 'a', value: null, source: 'laundry' }])
  })

  it('treats anything that is not an array as no evidence', () => {
    expect(evidenceFromJson({ key: 'a' })).toEqual([])
    expect(evidenceFromJson(null)).toEqual([])
  })
})

/* -------------------------------------------------------------- reading -- */

describe('reading', () => {
  it('lists what failed, oldest first, and nothing else', async () => {
    const repository = new InMemoryAutopilotActionRepository()

    const failed = await repository.insert(
      draft({
        planned: planned({ idempotencyKey: 'k-failed' }),
        createdAt: new Date('2026-09-06T05:00:00.000Z'),
      }),
    )
    await repository.update(failed.record, {
      outcome: 'failed',
      errorCode: 'boom',
    })

    const done = await repository.insert(
      draft({ planned: planned({ idempotencyKey: 'k-done' }) }),
    )
    await repository.update(done.record, {
      outcome: 'executed',
      executedAt: NOW,
    })

    const rows = await repository.listFailed(ORG)

    expect(rows.map((row) => row.idempotencyKey)).toEqual(['k-failed'])
  })
})
