/**
 * The two axes of the demo, and the rule that keeps them honest.
 *
 * The persona and the plan are chosen by cookie, and a cookie is a value the
 * browser holds. Nothing here may treat one as an authorization input: the
 * persona resolves to a `user_id` and stops, and the plan resolves to an
 * entitlement set and stops. What each of those *means* is decided afterwards
 * by `resolveActor` and `can()`, against rows, exactly as it is in production —
 * which is why the interesting test below is the one asserting that
 * `DemoActorSource` delegates membership, roles and scope untouched.
 */

import { describe, expect, it } from 'vitest'

import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from '../actor'
import { makeEffectivePlan } from '../actor'
import type { Entitlement } from '../plans/entitlements'
import type { EffectivePlan } from '../plans/plan'
import {
  DEFAULT_DEMO_PLAN,
  DemoActorSource,
  demoUser,
  UnknownDemoPersona,
  resolvePersona,
  resolvePlan,
} from './session'
import type { DemoPersona, DemoPlan } from './types'

/* --------------------------------------------------------------- fixture -- */

const OWNER: DemoPersona = {
  id: 'owner',
  label: 'בעלים',
  summary: 'רואה הכול.',
  role: 'organization_owner',
  userId: 'user-owner',
  fullName: 'דנה כהן',
  email: 'dana@estia.test',
}

const CLEANER: DemoPersona = {
  id: 'cleaner',
  label: 'מנקה',
  summary: 'רואה משימות בלבד.',
  role: 'cleaner',
  userId: 'user-cleaner',
  fullName: 'יוסי לוי',
  email: 'yossi@estia.test',
}

const BASIC: DemoPlan = {
  code: 'basic',
  label: 'בסיסי',
  entitlements: ['core'],
}

const PRO: DemoPlan = {
  code: 'pro',
  label: 'מקצועי',
  entitlements: ['core', 'operations', 'team', 'agent_network'],
}

/* --------------------------------------------------------------- personas -- */

describe('resolvePersona', () => {
  it('honours a cookie that names a persona', () => {
    expect(resolvePersona([OWNER, CLEANER], 'cleaner')).toBe(CLEANER)
  })

  it('takes the first persona when no cookie names one', () => {
    // Not a substitution — somebody arriving for the first time has to be
    // somebody, and the first persona is who.
    expect(resolvePersona([OWNER, CLEANER], undefined)).toBe(OWNER)
    expect(resolvePersona([OWNER, CLEANER], '')).toBe(OWNER)
  })

  it('refuses a named persona the dataset does not define', () => {
    // This used to fall through to `personas[0]`, and `personas[0]` is the
    // *owner* — so a mistyped or stale name silently promoted the request to
    // the most privileged identity in the demo.
    //
    // It cost real evidence: a verification sweep swept two ids that are not
    // personas at all and got the owner's screens back under somebody else's
    // label. Eight rows of proof that were secretly the same person.
    //
    // `currentDemoPersona` still keeps the demo working for a visitor whose
    // cookie outlived a dataset change — it catches this and warns. What it no
    // longer does is pretend.
    expect(() => resolvePersona([OWNER, CLEANER], 'nobody')).toThrow(
      UnknownDemoPersona,
    )
    expect(() => resolvePersona([OWNER, CLEANER], 'nobody')).toThrow(
      /owner, cleaner/,
    )
  })

  it('throws when the dataset names nobody at all', () => {
    expect(() => resolvePersona([], undefined)).toThrow(/no personas/)
  })
})

/* ------------------------------------------------------------------ plans -- */

describe('resolvePlan', () => {
  it('honours a cookie that names a plan', () => {
    expect(resolvePlan([BASIC, PRO], 'basic')).toBe(BASIC)
  })

  it('falls back to pro rather than to the first plan', () => {
    // Deliberately not "the first": somebody opening the demo should see the
    // product switched on, because a lock only reads as a lock once you have
    // seen the screen without it.
    expect(resolvePlan([BASIC, PRO], 'nonsense')).toBe(PRO)
    expect(DEFAULT_DEMO_PLAN).toBe('pro')
  })

  it('throws rather than quietly demonstrating a different package', () => {
    expect(() => resolvePlan([BASIC], undefined)).toThrow(/'pro'/)
  })
})

/* ------------------------------------------------------------------- user -- */

describe('demoUser', () => {
  it('carries the persona id that memberships are joined on', () => {
    const user = demoUser(OWNER)
    expect(user.id).toBe('user-owner')
    expect(user.email).toBe('dana@estia.test')
    expect(user.user_metadata.full_name).toBe('דנה כהן')
  })
})

/* ----------------------------------------------------------- actor source -- */

class RecordingSource implements ActorSource {
  readonly calls: string[] = []

  constructor(private readonly plan: EffectivePlan | null) {}

  async loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null> {
    this.calls.push(`membership:${userId}:${organizationId}`)
    return { id: 'm1', userId, organizationId, status: 'active' }
  }

  async loadRoles(membershipId: string): Promise<readonly RoleAssignment[]> {
    this.calls.push(`roles:${membershipId}`)
    return [{ code: 'organization_owner', kind: 'system' }]
  }

  async loadScope(membershipId: string): Promise<MembershipScopeRow | null> {
    this.calls.push(`scope:${membershipId}`)
    return {
      kind: 'all_organization',
      propertyIds: [],
      unitIds: [],
      teamIds: [],
    }
  }

  async loadPlan(organizationId: string): Promise<EffectivePlan | null> {
    this.calls.push(`plan:${organizationId}`)
    return this.plan
  }
}

describe('DemoActorSource', () => {
  it('delegates membership, roles and scope untouched', async () => {
    // The whole point. If the demo answered these itself, a persona would be a
    // claim about what somebody may see rather than a consequence of the rows,
    // and the switcher would demonstrate nothing.
    const delegate = new RecordingSource(makeEffectivePlan())
    const source = new DemoActorSource(delegate, PRO)

    expect(await source.loadMembership('user-owner', 'org-a')).toMatchObject({
      id: 'm1',
      status: 'active',
    })
    expect(await source.loadRoles('m1')).toEqual([
      { code: 'organization_owner', kind: 'system' },
    ])
    expect(await source.loadScope('m1')).toMatchObject({
      kind: 'all_organization',
    })

    expect(delegate.calls).toEqual([
      'membership:user-owner:org-a',
      'roles:m1',
      'scope:m1',
    ])
  })

  it('serves the switcher’s entitlements over the subscription’s', async () => {
    const delegate = new RecordingSource(
      makeEffectivePlan({ entitlements: ['core', 'operations', 'website'] }),
    )

    const { plan } = (await new DemoActorSource(delegate, BASIC).loadPlan(
      'org-a',
    )) as EffectivePlan

    expect(plan.code).toBe('basic')
    expect(plan.name).toBe('בסיסי')
    expect(plan.entitlements).toEqual(['core'])
  })

  it('keeps the subscription’s own facts, which the switcher has no view on', async () => {
    const delegate = new RecordingSource(
      makeEffectivePlan({ status: 'trialing', interval: 'yearly' }),
    )

    const effective = (await new DemoActorSource(delegate, PRO).loadPlan(
      'org-a',
    )) as EffectivePlan

    expect(effective.subscription.status).toBe('trialing')
    expect(effective.subscription.interval).toBe('yearly')
  })

  it('clears per-customer grants so the package matches its own caption', async () => {
    // "Pro, but without the website" is a real arrangement, and leaving one in
    // place while the switcher says `basic` would show a Basic customer a Pro
    // feature — the demo contradicting itself, with no way to tell which half
    // is true.
    const delegate = new RecordingSource(
      makeEffectivePlan({
        entitlementGrants: ['website'] as Entitlement[],
        entitlementRevocations: ['operations'] as Entitlement[],
      }),
    )

    const effective = (await new DemoActorSource(delegate, BASIC).loadPlan(
      'org-a',
    )) as EffectivePlan

    expect(effective.subscription.entitlementGrants).toEqual([])
    expect(effective.subscription.entitlementRevocations).toEqual([])
  })

  it('fails loudly when the dataset has no subscription to switch', async () => {
    const source = new DemoActorSource(new RecordingSource(null), PRO)
    await expect(source.loadPlan('org-a')).rejects.toThrow(
      /no live subscription/,
    )
  })
})
