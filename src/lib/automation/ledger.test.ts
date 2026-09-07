import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../persistence/fake-client'

import {
  SupabaseAutomationLedger,
  performedOutcome,
  recordPerformed,
} from './ledger'

const ORG = '11111111-1111-4111-8111-111111111111'
const KEY = 'evt-7::rule-3::0::notify_team'

describe('SupabaseAutomationLedger.claim', () => {
  it('calls the function, and calls only it', async () => {
    // The whole point of the durable ledger is that the decision is one
    // statement in the database. A read before the insert would reopen the
    // race, so the test asserts the shape of the traffic and not only its
    // answer.
    const client = new FakeSupabaseClient({
      responses: { 'rpc:automation_ledger_claim': { data: true } },
    })

    const taken = await new SupabaseAutomationLedger(client.asDb()).claim(
      ORG,
      KEY,
    )

    expect(taken).toBe(true)
    expect(client.queries).toHaveLength(1)
    expect(client.queries[0].table).toBe('rpc:automation_ledger_claim')
    expect(client.queries[0].payload).toEqual({
      p_organization_id: ORG,
      p_key: KEY,
    })
  })

  it('reports false when somebody already holds the key', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'rpc:automation_ledger_claim': { data: false } },
    })

    await expect(
      new SupabaseAutomationLedger(client.asDb()).claim(ORG, KEY),
    ).resolves.toBe(false)
  })

  it('treats a missing answer as not claimed', async () => {
    // Null is not "yes". Performing on an answer the ledger never gave is the
    // double-send the ledger exists to prevent.
    const client = new FakeSupabaseClient({
      responses: { 'rpc:automation_ledger_claim': { data: null } },
    })

    await expect(
      new SupabaseAutomationLedger(client.asDb()).claim(ORG, KEY),
    ).resolves.toBe(false)
  })

  it('throws rather than reporting false when the ledger is unreachable', async () => {
    // The distinction that matters most in this file. `false` tells the engine
    // "it already ran"; a failed round trip has told it nothing at all, and
    // flattening the two would silently and permanently skip an action nobody
    // performed.
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:automation_ledger_claim': {
          error: { code: '08006', message: 'connection failure' },
        },
      },
    })

    await expect(
      new SupabaseAutomationLedger(client.asDb()).claim(ORG, KEY),
    ).rejects.toMatchObject({ code: '08006' })
  })

  it('throws when the caller is refused the organization', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:automation_ledger_claim': {
          error: {
            code: '42501',
            message: 'not a member of this organization',
          },
        },
      },
    })

    await expect(
      new SupabaseAutomationLedger(client.asDb()).claim(ORG, KEY),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('SupabaseAutomationLedger.release', () => {
  it('hands the key back through the function', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'rpc:automation_ledger_release': { data: null } },
    })

    await new SupabaseAutomationLedger(client.asDb()).release(ORG, KEY)

    expect(client.queries[0].table).toBe('rpc:automation_ledger_release')
    expect(client.queries[0].payload).toEqual({
      p_organization_id: ORG,
      p_key: KEY,
    })
  })

  it('throws on failure rather than pretending the key was released', async () => {
    // A release that failed silently leaves a claim nobody holds in code and
    // everybody holds in the database: the retry the engine expects to be
    // possible would report `skipped_duplicate` for ever.
    const client = new FakeSupabaseClient({
      responses: {
        'rpc:automation_ledger_release': {
          error: { code: '08006', message: 'connection failure' },
        },
      },
    })

    await expect(
      new SupabaseAutomationLedger(client.asDb()).release(ORG, KEY),
    ).rejects.toMatchObject({ code: '08006' })
  })
})

describe('recordPerformed', () => {
  it('stamps the decision record through the one door that can', async () => {
    const client = new FakeSupabaseClient({
      responses: { 'rpc:automation_run_performed': { data: null } },
    })

    await recordPerformed(client.asDb(), {
      organizationId: ORG,
      eventKey: 'evt-7',
      templateId: 'review-request-after-stay',
      outcome: 'executed',
    })

    expect(client.queries[0].table).toBe('rpc:automation_run_performed')
    expect(client.queries[0].payload).toEqual({
      p_organization_id: ORG,
      p_event_key: 'evt-7',
      p_template_id: 'review-request-after-stay',
      p_outcome: 'executed',
    })
  })

  it('surfaces the write-once refusal instead of swallowing it', async () => {
    // A second stamp is a bug in the caller, not a state to tolerate: the
    // record of what an automation did to somebody's guest is not corrected in
    // place, and a caller that stamped twice needs to hear about it.
    const failing = new FakeSupabaseClient({
      responses: {
        'rpc:automation_run_performed': {
          error: { code: '23505', message: 'הריצה הזאת כבר סומנה כבוצעה' },
        },
      },
    })

    await expect(
      recordPerformed(failing.asDb(), {
        organizationId: ORG,
        eventKey: 'evt-7',
        templateId: 'review-request-after-stay',
        outcome: 'executed',
      }),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('performedOutcome', () => {
  const ran = (
    ...statuses: readonly string[]
  ): Parameters<typeof performedOutcome>[0] => ({
    status: 'ran',
    actions: statuses.map((status) => ({
      action: { kind: 'create_task' as const, note: '' },
      key: `k-${status}`,
      outcome: { status } as never,
    })),
  })

  it('reports a clean run as executed', () => {
    expect(performedOutcome(ran('executed', 'executed'))).toBe('executed')
  })

  it('lets the worst news win over a success beside it', () => {
    // The record keeps ONE word. "executed" on a rule that opened a task and
    // failed to message the guest stops the manager looking, and the failure
    // is the half they needed.
    expect(performedOutcome(ran('executed', 'failed'))).toBe('failed')
    expect(performedOutcome(ran('executed', 'refused_permission'))).toBe(
      'refused_permission',
    )
    expect(performedOutcome(ran('executed', 'refused_plan'))).toBe(
      'refused_plan',
    )
  })

  it('puts a failure above a refusal', () => {
    expect(performedOutcome(ran('refused_plan', 'failed'))).toBe('failed')
  })

  it('says so when the trail did not record a real execution', () => {
    expect(performedOutcome(ran('executed', 'executed_unaudited'))).toBe(
      'executed_unaudited',
    )
  })

  it('reports skipped_duplicate only when it is the whole story', () => {
    expect(performedOutcome(ran('skipped_duplicate'))).toBe('skipped_duplicate')
    expect(performedOutcome(ran('skipped_duplicate', 'executed'))).toBe(
      'executed',
    )
    expect(performedOutcome(ran('skipped_duplicate', 'failed'))).toBe('failed')
  })

  it('has nothing to record for a rule that never reached its actions', () => {
    // Those already have their answer in `decision`, and the database refuses
    // to stamp anything that did not decide `would_act`.
    expect(performedOutcome({ status: 'skipped_disabled' })).toBeNull()
    expect(performedOutcome({ status: 'skipped_trigger' })).toBeNull()
    expect(
      performedOutcome({ status: 'skipped_conditions', failures: [] }),
    ).toBeNull()
    expect(
      performedOutcome({ status: 'refused_plan', entitlement: 'automation' }),
    ).toBeNull()
  })
})
