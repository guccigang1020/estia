/**
 * The join between readiness, simulation and the data — and the one thing it
 * computes that neither of the other two can.
 *
 * `queries.test.ts` proves the whole pipeline over the demo dataset. This file
 * is the unit-level companion for the parts of `rules.ts` that a dataset cannot
 * exercise on demand: a rule whose event never carried the fact its IF clause
 * compares, a role missing exactly one of two grants, and the ordering that
 * decides what somebody sees first.
 */

import { describe, expect, it } from 'vitest'

import { ruleReadiness, type AutomationRule } from '@/lib/automation'
import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'

import type { Candidate, DryRun, RuleSimulation } from './dry-run'
import { blockersFor, headline, missingFacts, ruleViews } from './rules'

const ORGANIZATION = '00000000-0000-4000-8000-000000000001'

function actor(grants: readonly Grant[], entitlements: Entitlement[]): Actor {
  return {
    userId: 'user-1',
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(entitlements),
  }
}

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    name: 'כלל',
    description: 'תיאור',
    when: 'booking.completed',
    conditions: [],
    actions: [{ kind: 'notify_team', note: 'הצוות עודכן' }],
    enabled: true,
    ...overrides,
  }
}

function candidate(
  name: Candidate['event']['name'],
  facts: Candidate['facts'],
): Candidate {
  return {
    event: {
      name,
      organizationId: ORGANIZATION,
      resourceType: 'booking',
      resourceId: 'booking-1',
      propertyId: null,
      actorUserId: null,
      occurredAt: '2026-05-20T09:00:00.000Z',
      correlationId: 'c-1',
      idempotencyKey: 'k-1',
      payload: {},
    },
    facts,
    label: 'BA-1 — שהייה הסתיימה',
  }
}

/* ------------------------------------------------------------ the facts -- */

describe('missingFacts', () => {
  it('names a fact the rule compares that its own trigger never carried', () => {
    const subject = rule({
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
    })

    expect(
      missingFacts(subject, [candidate('booking.completed', { status: 'x' })]),
    ).toEqual(['nights'])
  })

  it('is silent when the fact did arrive', () => {
    const subject = rule({
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
    })

    expect(
      missingFacts(subject, [candidate('booking.completed', { nights: 3 })]),
    ).toEqual([])
  })

  it('asks only about its own trigger', () => {
    const subject = rule({
      when: 'booking.completed',
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
    })

    // `nights` is carried by a different event entirely. Pooling every
    // candidate's keys would report full coverage for a rule whose own trigger
    // carries none of them.
    expect(
      missingFacts(subject, [
        candidate('payment.failed', { nights: 4 }),
        candidate('booking.completed', { status: 'completed' }),
      ]),
    ).toEqual(['nights'])
  })

  it('says nothing when the trigger produced no candidates at all', () => {
    const subject = rule({
      when: 'quote.accepted',
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
    })

    // The silence is already reported as "the preview cannot reconstruct this
    // trigger". Reporting a missing fact from the same silence would be two
    // findings invented out of one absence.
    expect(missingFacts(subject, [])).toEqual([])
  })
})

/* --------------------------------------------------------- the blockers -- */

describe('blockersFor', () => {
  it('says package, never permission, when the module is not bought', () => {
    const subject = rule()
    const readiness = ruleReadiness(
      actor(['automation.view', 'message.send'], ['core']),
      subject,
    )

    const blockers = blockersFor(readiness, [], true)

    expect(readiness.status).toBe('module_locked')
    expect(blockers.map((entry) => entry.kind)).toEqual(['plan'])
    expect(blockers[0].message).toContain('ההרשאות שלך תקינות')
  })

  it('reports one missing grant once, however many actions demand it', () => {
    const subject = rule({
      actions: [
        { kind: 'notify_team', note: 'א' },
        { kind: 'message_guest', note: 'ב' },
        { kind: 'request_review', note: 'ג' },
      ],
    })
    // All three demand `message.send`. Three blockers would read as three
    // different problems needing three different conversations.
    const readiness = ruleReadiness(
      actor(['automation.view'], ['core', 'automation']),
      subject,
    )

    const blockers = blockersFor(readiness, [], true)

    expect(readiness.status).toBe('blocked')
    expect(
      blockers.filter((entry) => entry.kind === 'permission'),
    ).toHaveLength(1)
  })

  it('adds the missing-fact sentence as its own kind', () => {
    const subject = rule({
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
    })
    const readiness = ruleReadiness(
      actor(['automation.view', 'message.send'], ['core', 'automation']),
      subject,
    )

    const blockers = blockersFor(readiness, ['nights'], true)

    expect(readiness.status).toBe('ready')
    // Ready by permission and plan, and it will still never fire. That is the
    // whole reason this third refusal exists.
    expect(blockers.map((entry) => entry.kind)).toEqual(['fact'])
    expect(blockers[0].message).toContain('מספר הלילות')
  })

  it('adds the simulation limit only when the trigger is not reconstructible', () => {
    const subject = rule({ when: 'quote.accepted' })
    const readiness = ruleReadiness(
      actor(['automation.view', 'message.send'], ['core', 'automation']),
      subject,
    )

    expect(blockersFor(readiness, [], true)).toEqual([])
    expect(
      blockersFor(readiness, [], false).map((entry) => entry.kind),
    ).toEqual(['trigger'])
  })
})

/* ------------------------------------------------------------- the view -- */

describe('ruleViews', () => {
  const acting = rule({ id: 'acting', name: 'ב' })
  const triggered = rule({ id: 'triggered', name: 'א' })
  const quiet = rule({ id: 'quiet', name: 'ג', when: 'quote.accepted' })

  const dryRun: DryRun = {
    candidates: 12,
    rules: [
      simulation(quiet, { matched: 0, wouldRun: 0, filtered: 0, refused: 0 }),
      simulation(triggered, {
        matched: 4,
        wouldRun: 0,
        filtered: 4,
        refused: 0,
      }),
      simulation(acting, { matched: 3, wouldRun: 3, filtered: 0, refused: 0 }),
    ],
  }

  it('puts the rules that would act first, then the ones that fired', () => {
    const views = ruleViews(
      actor(['automation.view', 'message.send'], ['core', 'automation']),
      dryRun,
      [],
    )

    expect(views.map((view) => view.rule.id)).toEqual([
      'acting',
      'triggered',
      'quiet',
    ])
  })

  it('totals the four figures without folding refused into would-run', () => {
    const views = ruleViews(
      actor(['automation.view', 'message.send'], ['core', 'automation']),
      dryRun,
      [],
    )
    const totals = headline(views, dryRun)

    expect(totals).toEqual({
      candidates: 12,
      actingRules: 1,
      refusingRules: 0,
      wouldRun: 3,
      refused: 0,
      filtered: 4,
    })
  })
})

function simulation(
  subject: AutomationRule,
  counts: Omit<RuleSimulation, 'rule' | 'examples'>,
): RuleSimulation {
  return { rule: subject, examples: [], ...counts }
}
