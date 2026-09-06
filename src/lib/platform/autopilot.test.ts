import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '@/lib/authz/can'
import { InMemoryAuditWriter } from '@/lib/audit/pipeline'
import { BusinessRuleError, ValidationError } from '@/lib/errors'
import type { OperationContext } from '@/lib/service'

import { platformActorFor, platformAuditActor } from './actor'
import {
  AUTOPILOT_ENTITLEMENT,
  autopilotEntitlementActive,
  defineAutopilotOperations,
  effectiveAutopilotCapability,
  fleetMetrics,
  fleetOrganizations,
  nextOverrides,
  shouldHoldEntitlement,
  summariseActivity,
  type AutopilotActionSummary,
  type AutopilotCapabilityDecision,
  type AutopilotCapabilityRecord,
  type AutopilotCapabilityStore,
  type EntitlementOverrides,
} from './autopilot'
import type { OrganizationSnapshot } from './operations'
import type { ConsoleSubscription, OrganizationSummary } from './organizations'
import { platformGrants, type PlatformSession } from './staff'

/**
 * The one property this module exists for: the platform's workflow record and
 * the entitlement the product actually reads never move apart.
 *
 * Everything below is either that property, the trial clock that can break it,
 * or the refusals that stop a half-write from being possible in the first
 * place.
 */

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-06T09:00:00Z')

/* ------------------------------------------------------------- the double -- */

class RecordingStore implements AutopilotCapabilityStore {
  organization: OrganizationSnapshot | null = {
    id: ORGANIZATION_ID,
    name: 'וילה כרמל',
    status: 'active',
  }

  capability: AutopilotCapabilityRecord | null = null

  entitlements: EntitlementOverrides | null = {
    // A grant that has nothing to do with Autopilot, present in every test so
    // that a rewrite of the whole set would be visible rather than plausible.
    entitlementGrants: ['api_access'],
    entitlementRevocations: [],
    limitOverrides: { properties: 12 },
  }

  readonly decisions: AutopilotCapabilityDecision[] = []

  async readOrganization(id: string) {
    return this.organization && this.organization.id === id
      ? this.organization
      : null
  }

  async readCapability() {
    return this.capability
  }

  async readEntitlements() {
    return this.entitlements
  }

  async applyCapabilityDecision(decision: AutopilotCapabilityDecision) {
    this.decisions.push(decision)
  }
}

function session(grants: readonly string[]): PlatformSession {
  return {
    staffId: 'staff-1',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'platform_super_admin',
    roleName: 'מנהל-על ESTIA',
    grants: platformGrants(grants),
    displayName: 'דנה כהן',
  }
}

const SUPER_ADMIN = session([
  'platform.organization.view',
  'platform.organization.manage',
  'platform.feature_flag.manage',
])

const SUPPORT = session(['platform.organization.view'])

function context(
  staff: PlatformSession,
  reason: string | null,
): OperationContext {
  return {
    actor: platformActorFor(staff, ORGANIZATION_ID),
    auditActor: platformAuditActor(staff),
    correlationId: 'corr-1',
    now: NOW,
    reason,
  }
}

function setup() {
  const store = new RecordingStore()
  const audit = new InMemoryAuditWriter()
  return {
    store,
    audit,
    operations: defineAutopilotOperations(store),
    services: { audit },
  }
}

/* ------------------------------------------- the record and the gate move -- */

describe('setAutopilotCapability · the record and the entitlement move together', () => {
  it('grants the entitlement in the same operation that records `enabled`', async () => {
    const { operations, services, store } = setup()

    await operations.setAutopilotCapability.run({
      request: { input: { organizationId: ORGANIZATION_ID, state: 'enabled' } },
      context: context(SUPER_ADMIN, 'הלקוח רכש את התוסף, עסקה #8891'),
      services,
    })

    // ONE decision reached the store, and it carries both halves. There is no
    // second call site that could have written the row alone.
    expect(store.decisions).toHaveLength(1)
    const [decision] = store.decisions

    expect(decision.state).toBe('enabled')
    expect(decision.entitled).toBe(true)
    expect(decision.overrides.entitlementGrants).toContain(
      AUTOPILOT_ENTITLEMENT,
    )
    expect(decision.overrides.entitlementRevocations).not.toContain(
      AUTOPILOT_ENTITLEMENT,
    )
  })

  it('grants it for a trial too — a trial is a customer who is running it', async () => {
    const { operations, services, store } = setup()

    await operations.setAutopilotCapability.run({
      request: {
        input: {
          organizationId: ORGANIZATION_ID,
          state: 'trial',
          trialEndsAt: '2026-09-20T00:00:00Z',
        },
      },
      context: context(SUPER_ADMIN, 'התנסות של שבועיים, סוכם עם ההנהלה'),
      services,
    })

    const [decision] = store.decisions
    expect(decision.entitled).toBe(true)
    expect(decision.overrides.entitlementGrants).toContain(
      AUTOPILOT_ENTITLEMENT,
    )
    expect(decision.trialEndsAt).toBe('2026-09-20T00:00:00.000Z')
  })

  it('removes the grant AND writes a revocation when it suspends', async () => {
    const { operations, services, store } = setup()
    store.entitlements = {
      entitlementGrants: ['api_access', AUTOPILOT_ENTITLEMENT],
      entitlementRevocations: [],
      limitOverrides: {},
    }

    await operations.setAutopilotCapability.run({
      request: {
        input: {
          organizationId: ORGANIZATION_ID,
          state: 'suspended',
          note: 'שלוש פעולות אוטומטיות נכשלו ברצף, קריאה #5120',
        },
      },
      context: context(SUPER_ADMIN, 'אירוע בטיחות'),
      services,
    })

    const [decision] = store.decisions
    expect(decision.entitled).toBe(false)
    expect(decision.overrides.entitlementGrants).not.toContain(
      AUTOPILOT_ENTITLEMENT,
    )
    // A withdrawal, not an absence. A revocation beats a grant and beats a
    // plan, so the suspension holds even if `autopilot` is ever put on a
    // package — which is the whole difference between this and `eligible`.
    expect(decision.overrides.entitlementRevocations).toContain(
      AUTOPILOT_ENTITLEMENT,
    )
  })

  it('leaves every other entitlement and limit override exactly as it found them', async () => {
    const { operations, services, store } = setup()

    await operations.setAutopilotCapability.run({
      request: { input: { organizationId: ORGANIZATION_ID, state: 'enabled' } },
      context: context(SUPER_ADMIN, 'רכישה'),
      services,
    })

    const [decision] = store.decisions
    expect(decision.overrides.entitlementGrants).toContain('api_access')
    expect(decision.overrides.limitOverrides).toEqual({ properties: 12 })
  })

  it('writes neither half when there is no live subscription to hold the gate', async () => {
    const { operations, services, store } = setup()
    store.entitlements = null

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: { organizationId: ORGANIZATION_ID, state: 'enabled' },
        },
        context: context(SUPER_ADMIN, 'ניסיון'),
        services,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BusinessRuleError)
    expect((failure as BusinessRuleError).code).toBe('no_live_subscription')
    // The important assertion. Half a write here is a customer whose platform
    // record says `enabled` and whose product has never heard of it.
    expect(store.decisions).toEqual([])
  })

  it('records one audit event naming both halves, with the real actor', async () => {
    const { operations, services, store, audit } = setup()
    store.entitlements = {
      entitlementGrants: [AUTOPILOT_ENTITLEMENT],
      entitlementRevocations: [],
      limitOverrides: {},
    }

    await operations.setAutopilotCapability.run({
      request: {
        input: {
          organizationId: ORGANIZATION_ID,
          state: 'disabled',
          note: 'הלקוח ביקש להפסיק',
        },
      },
      context: context(SUPER_ADMIN, 'בקשת הלקוח, קריאה #6001'),
      services,
    })

    const [event] = audit.records
    expect(event.actorType).toBe('platform_staff')
    expect(event.actorLabel).toBe('ESTIA · דנה כהן')
    expect(event.organizationId).toBe(ORGANIZATION_ID)
    expect(event.summary).toContain('וילה כרמל')
    expect(event.reason).toBe('בקשת הלקוח, קריאה #6001')
    expect(event.before).toMatchObject({
      entitlementGrants: [AUTOPILOT_ENTITLEMENT],
    })
    expect(event.after).toMatchObject({
      state: 'disabled',
      entitled: false,
      entitlementRevocations: [AUTOPILOT_ENTITLEMENT],
    })
    // A platform action is ESTIA's own; 0041's insert policy refuses the row
    // if a delegation signature is present.
    expect(event.onBehalfOfUserId).toBeNull()
  })
})

/* ------------------------------------------------------------- the refusals */

describe('setAutopilotCapability · refusals', () => {
  it('refuses a support role that does not hold platform.organization.manage', async () => {
    const { operations, services, store } = setup()

    await expect(
      operations.setAutopilotCapability.run({
        request: {
          input: { organizationId: ORGANIZATION_ID, state: 'enabled' },
        },
        context: context(SUPPORT, 'ננסה'),
        services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(store.decisions).toEqual([])
  })

  it('refuses without a stated reason', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: { organizationId: ORGANIZATION_ID, state: 'enabled' },
        },
        context: context(SUPER_ADMIN, null),
        services,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ValidationError)
    expect((failure as ValidationError).issues.map((i) => i.field)).toContain(
      'reason',
    )
    expect(store.decisions).toEqual([])
  })

  it('refuses to suspend without a note, before the database is asked', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: { organizationId: ORGANIZATION_ID, state: 'suspended' },
        },
        context: context(SUPER_ADMIN, 'אירוע בטיחות'),
        services,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BusinessRuleError)
    expect((failure as BusinessRuleError).code).toBe('note_required')
    expect(store.decisions).toEqual([])
  })

  it('refuses to disable without a note, and a blank one does not count', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: {
            organizationId: ORGANIZATION_ID,
            state: 'disabled',
            note: '   ',
          },
        },
        context: context(SUPER_ADMIN, 'סיום התקשרות'),
        services,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BusinessRuleError)
    expect((failure as BusinessRuleError).code).toBe('note_required')
    expect(store.decisions).toEqual([])
  })

  it('refuses a trial with no end date', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: { organizationId: ORGANIZATION_ID, state: 'trial' },
        },
        context: context(SUPER_ADMIN, 'התנסות'),
        services,
      })
      .catch((error: unknown) => error)

    expect((failure as BusinessRuleError).code).toBe('trial_end_required')
    expect(store.decisions).toEqual([])
  })

  it('refuses a trial that ends in the past', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.setAutopilotCapability
      .run({
        request: {
          input: {
            organizationId: ORGANIZATION_ID,
            state: 'trial',
            trialEndsAt: '2026-08-01T00:00:00Z',
          },
        },
        context: context(SUPER_ADMIN, 'התנסות'),
        services,
      })
      .catch((error: unknown) => error)

    // It would have been saved as `trial`, granted the entitlement, and read
    // as expired the same second. The grant would have stayed.
    expect((failure as BusinessRuleError).code).toBe('trial_end_in_past')
    expect(store.decisions).toEqual([])
  })

  it('clears a stale trial end date when the state is no longer a trial', async () => {
    const { operations, services, store } = setup()
    store.capability = {
      organizationId: ORGANIZATION_ID,
      state: 'trial',
      trialEndsAt: '2026-09-20T00:00:00Z',
      actionLimit: null,
      note: null,
      decidedBy: null,
      decidedAt: '2026-09-01T00:00:00Z',
    }

    await operations.setAutopilotCapability.run({
      request: {
        input: {
          organizationId: ORGANIZATION_ID,
          state: 'enabled',
          trialEndsAt: '2026-09-20T00:00:00Z',
        },
      },
      context: context(SUPER_ADMIN, 'ההתנסות הומרה לרכישה'),
      services,
    })

    expect(store.decisions[0].trialEndsAt).toBeNull()
  })
})

/* ------------------------------------------------------------ the clock ---- */

describe('a trial past its end date', () => {
  const expiredTrial: AutopilotCapabilityRecord = {
    organizationId: ORGANIZATION_ID,
    state: 'trial',
    trialEndsAt: '2026-09-01T00:00:00Z',
    actionLimit: null,
    note: null,
    decidedBy: null,
    decidedAt: '2026-08-01T00:00:00Z',
  }

  it('does not read as entitled, with no job having run', () => {
    expect(shouldHoldEntitlement('trial', '2026-09-01T00:00:00Z', NOW)).toBe(
      false,
    )
    expect(shouldHoldEntitlement('trial', '2026-09-20T00:00:00Z', NOW)).toBe(
      true,
    )
    // `enabled` has no clock. It is true until somebody decides otherwise.
    expect(shouldHoldEntitlement('enabled', null, NOW)).toBe(true)
  })

  it('is reported as a divergence while the entitlement is still granted', () => {
    const effective = effectiveAutopilotCapability(expiredTrial, true, NOW)

    expect(effective.recorded).toBe('trial')
    expect(effective.trialExpired).toBe(true)
    expect(effective.shouldBeEntitled).toBe(false)
    // The grant does not expire on its own — nothing in the product reads
    // `trial_ends_at`, deliberately. So this is work for a person, and the
    // console names it rather than resolving it in a direction nobody chose.
    expect(effective.entitled).toBe(true)
    expect(effective.divergence).toBe('entitlement_lingering')
  })

  it('reads a live trial as aligned', () => {
    const effective = effectiveAutopilotCapability(
      { ...expiredTrial, trialEndsAt: '2026-09-20T00:00:00Z' },
      true,
      NOW,
    )

    expect(effective.trialExpired).toBe(false)
    expect(effective.divergence).toBe('aligned')
  })

  it('treats a trial with no end date as over, not as endless', () => {
    const effective = effectiveAutopilotCapability(
      { ...expiredTrial, trialEndsAt: null },
      false,
      NOW,
    )

    expect(effective.trialExpired).toBe(true)
    expect(effective.shouldBeEntitled).toBe(false)
  })

  it('notices the other divergence too — promised, and not actually granted', () => {
    const effective = effectiveAutopilotCapability(
      { ...expiredTrial, state: 'enabled', trialEndsAt: null },
      false,
      NOW,
    )

    expect(effective.divergence).toBe('entitlement_missing')
  })

  it('reads a customer with no row as not_available rather than as broken', () => {
    const effective = effectiveAutopilotCapability(null, false, NOW)

    expect(effective.recorded).toBe('not_available')
    expect(effective.divergence).toBe('aligned')
    expect(effective.note).toBeNull()
  })
})

/* -------------------------------------------------------- override arithmetic */

describe('nextOverrides', () => {
  const current: EntitlementOverrides = {
    entitlementGrants: ['api_access'],
    entitlementRevocations: ['website'],
    limitOverrides: { units: 40 },
  }

  it('clears a revocation when it grants, because a revocation would win', () => {
    const next = nextOverrides(
      {
        ...current,
        entitlementRevocations: ['website', AUTOPILOT_ENTITLEMENT],
      },
      'enabled',
      true,
    )

    expect(next.entitlementGrants).toEqual([
      'api_access',
      AUTOPILOT_ENTITLEMENT,
    ])
    expect(next.entitlementRevocations).toEqual(['website'])
  })

  it('writes no revocation for `eligible` — nothing was withdrawn', () => {
    const next = nextOverrides(current, 'eligible', false)

    expect(next.entitlementGrants).toEqual(['api_access'])
    expect(next.entitlementRevocations).toEqual(['website'])
  })

  it('writes no revocation for `not_available` either', () => {
    const next = nextOverrides(current, 'not_available', false)
    expect(next.entitlementRevocations).toEqual(['website'])
  })
})

/* ---------------------------------------------------------- the gate reader */

describe('autopilotEntitlementActive', () => {
  function subscription(
    overrides: Partial<ConsoleSubscription> = {},
  ): ConsoleSubscription {
    return {
      id: 'sub-1',
      planCode: 'growth',
      planName: 'צמיחה',
      status: 'active',
      interval: 'monthly',
      agreedMonthlyAgorot: 49900,
      agreedYearlyAgorot: 499000,
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelledAt: null,
      planEntitlements: ['core'],
      entitlementGrants: [],
      entitlementRevocations: [],
      planLimits: {},
      limitOverrides: {},
      ...overrides,
    }
  }

  it('is false with no subscription at all', () => {
    expect(autopilotEntitlementActive(null)).toBe(false)
  })

  it('is true on a grant', () => {
    expect(
      autopilotEntitlementActive(
        subscription({ entitlementGrants: [AUTOPILOT_ENTITLEMENT] }),
      ),
    ).toBe(true)
  })

  it('is false when a revocation stands beside the grant', () => {
    expect(
      autopilotEntitlementActive(
        subscription({
          entitlementGrants: [AUTOPILOT_ENTITLEMENT],
          entitlementRevocations: [AUTOPILOT_ENTITLEMENT],
        }),
      ),
    ).toBe(false)
  })

  it('is false once the subscription is cancelled, whatever the grant says', () => {
    expect(
      autopilotEntitlementActive(
        subscription({
          status: 'cancelled',
          entitlementGrants: [AUTOPILOT_ENTITLEMENT],
        }),
      ),
    ).toBe(false)
  })
})

/* -------------------------------------------------------------- the fleet -- */

function action(
  overrides: Partial<AutopilotActionSummary> = {},
): AutopilotActionSummary {
  return {
    id: 'act-1',
    organizationId: ORGANIZATION_ID,
    actionKind: 'task.open',
    safetyLevel: 'safe_internal',
    disposition: 'auto',
    runMode: 'live',
    outcome: 'executed',
    suppressedReason: null,
    errorCode: null,
    attempt: 1,
    createdAt: '2026-09-05T10:00:00Z',
    executedAt: '2026-09-05T10:00:01Z',
    ...overrides,
  }
}

describe('summariseActivity', () => {
  it('counts an empty read as empty rather than as an error', () => {
    const activity = summariseActivity([])

    expect(activity.visibleRows).toBe(0)
    expect(activity.truncated).toBe(false)
    expect(activity.byOrganization.size).toBe(0)
  })

  it('computes the automatic success rate over automatic live actions only', () => {
    const activity = summariseActivity([
      action({ id: 'a', outcome: 'executed' }),
      action({ id: 'b', outcome: 'executed' }),
      action({ id: 'c', outcome: 'failed', errorCode: 'transport_failed' }),
      // Approved by a person: not evidence about unattended safety.
      action({ id: 'd', disposition: 'ask_approval', outcome: 'failed' }),
      // A simulation did not happen at all.
      action({ id: 'e', runMode: 'simulation', outcome: 'simulated' }),
    ])

    const entry = activity.byOrganization.get(ORGANIZATION_ID)
    expect(entry?.total).toBe(5)
    expect(entry?.automaticAttempts).toBe(3)
    expect(entry?.automaticSuccessRate).toBeCloseTo(2 / 3)
    expect(entry?.simulated).toBe(1)
    // The approved failure still counts as a failure to look at.
    expect(entry?.failures).toBe(2)
  })

  it('reports no rate at all when Autopilot never acted unattended', () => {
    const activity = summariseActivity([
      action({ disposition: 'suggest', outcome: 'suppressed' }),
    ])

    const entry = activity.byOrganization.get(ORGANIZATION_ID)
    // Not 100%, and not 0%. An empty denominator has no answer.
    expect(entry?.automaticSuccessRate).toBeNull()
    expect(entry?.suppressed).toBe(1)
  })

  it('says so when the row cap was reached, so a count is read as a floor', () => {
    const activity = summariseActivity([action(), action()], 2)
    expect(activity.truncated).toBe(true)
  })
})

describe('fleetMetrics', () => {
  function organization(
    id: string,
    grants: readonly ('autopilot' | 'api_access')[],
  ): OrganizationSummary {
    return {
      id,
      name: `ארגון ${id}`,
      slug: `org-${id}`,
      status: 'active',
      businessType: 'vacation_rental',
      createdAt: '2026-01-01T00:00:00Z',
      subscription: {
        id: `sub-${id}`,
        planCode: 'growth',
        planName: 'צמיחה',
        status: 'active',
        interval: 'monthly',
        agreedMonthlyAgorot: 49900,
        agreedYearlyAgorot: 499000,
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelledAt: null,
        planEntitlements: ['core'],
        entitlementGrants: [...grants],
        entitlementRevocations: [],
        planLimits: {},
        limitOverrides: {},
      },
    }
  }

  it('reports an empty fleet as empty, and adoption as unknown when nothing was readable', () => {
    const metrics = fleetMetrics(
      fleetOrganizations({
        organizations: [],
        capabilities: new Map(),
        activity: null,
        now: NOW,
      }),
      null,
      NOW,
    )

    expect(metrics.organizations).toBe(0)
    expect(metrics.enabled).toBe(0)
    // `null`, not 0. Nobody measured it, and "0% adoption" is a claim.
    expect(metrics.adopted).toBeNull()
    expect(metrics.actionsSeen).toBeNull()
    expect(metrics.automaticSuccessRate).toBeNull()
  })

  it('separates a live trial, an expired one and a suspension', () => {
    const capabilities = new Map<string, AutopilotCapabilityRecord>([
      [
        'a',
        {
          organizationId: 'a',
          state: 'trial',
          trialEndsAt: '2026-09-10T00:00:00Z',
          actionLimit: null,
          note: null,
          decidedBy: null,
          decidedAt: '2026-09-01T00:00:00Z',
        },
      ],
      [
        'b',
        {
          organizationId: 'b',
          state: 'trial',
          trialEndsAt: '2026-09-01T00:00:00Z',
          actionLimit: null,
          note: null,
          decidedBy: null,
          decidedAt: '2026-08-01T00:00:00Z',
        },
      ],
      [
        'c',
        {
          organizationId: 'c',
          state: 'suspended',
          trialEndsAt: null,
          actionLimit: null,
          note: 'שלוש פעולות נכשלו ברצף',
          decidedBy: null,
          decidedAt: '2026-09-04T00:00:00Z',
        },
      ],
    ])

    const rows = fleetOrganizations({
      organizations: [
        organization('a', ['autopilot']),
        organization('b', ['autopilot']),
        organization('c', ['autopilot']),
        organization('d', ['api_access']),
      ],
      capabilities,
      activity: summariseActivity([]),
      now: NOW,
    })

    const metrics = fleetMetrics(rows, summariseActivity([]), NOW)

    expect(metrics.organizations).toBe(4)
    expect(metrics.onTrial).toBe(1)
    expect(metrics.trialsExpiringSoon.map((r) => r.organization.id)).toEqual([
      'a',
    ])
    expect(metrics.trialsExpired.map((r) => r.organization.id)).toEqual(['b'])
    expect(metrics.suspended.map((r) => r.organization.id)).toEqual(['c'])
    // `b` is past its trial and still granted; `c` is suspended and still
    // granted. Both are the same failure and both are listed.
    expect(metrics.diverged.map((r) => r.organization.id)).toEqual(['b', 'c'])
    expect(metrics.entitled).toBe(3)
    expect(metrics.adopted).toBe(0)
  })
})
