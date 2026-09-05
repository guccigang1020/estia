import { describe, expect, it } from 'vitest'

import { AuthorizationError } from '@/lib/authz/can'
import { InMemoryAuditWriter } from '@/lib/audit/pipeline'
import { BusinessRuleError, ValidationError } from '@/lib/errors'
import type { OperationContext } from '@/lib/service'

import { platformActorFor, platformAuditActor } from './actor'
import {
  definePlatformOperations,
  type CapabilityOverrides,
  type OrganizationSnapshot,
  type PlatformStore,
  type SupportViewRecord,
} from './operations'
import { platformGrants, type PlatformSession } from './staff'

/**
 * The console's writes, and the four things that must be true of every one:
 * it is refused without the grant, it is refused without a reason, it records
 * an event a human can read, and it cannot reach a customer's business data.
 */

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'

class RecordingStore implements PlatformStore {
  organization: OrganizationSnapshot | null = {
    id: ORGANIZATION_ID,
    name: 'וילה כרמל',
    status: 'active',
  }

  readonly statusWrites: { id: string; status: string }[] = []
  readonly capabilityWrites: CapabilityOverrides[] = []
  readonly supportViews: {
    organizationId: string
    reason: string
    expiresAt: Date
  }[] = []
  readonly closed: string[] = []

  async readOrganization(id: string) {
    return this.organization && this.organization.id === id
      ? this.organization
      : null
  }

  async setOrganizationStatus(id: string, status: 'active' | 'suspended') {
    this.statusWrites.push({ id, status })
  }

  async readCapabilities(): Promise<CapabilityOverrides | null> {
    return {
      entitlementGrants: [],
      entitlementRevocations: [],
      limitOverrides: {},
    }
  }

  async setCapabilities(_id: string, overrides: CapabilityOverrides) {
    this.capabilityWrites.push(overrides)
  }

  async openSupportView(input: {
    organizationId: string
    reason: string
    expiresAt: Date
  }): Promise<SupportViewRecord> {
    this.supportViews.push(input)
    return {
      id: 'view-1',
      organizationId: input.organizationId,
      startedAt: new Date('2026-09-05T09:00:00Z').toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    }
  }

  async closeSupportView(sessionId: string) {
    this.closed.push(sessionId)
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

function context(
  staff: PlatformSession,
  reason: string | null,
): OperationContext {
  return {
    actor: platformActorFor(staff, ORGANIZATION_ID),
    auditActor: platformAuditActor(staff),
    correlationId: 'corr-1',
    now: new Date('2026-09-05T09:00:00Z'),
    reason,
  }
}

const SUPER_ADMIN = session([
  'platform.organization.view',
  'platform.organization.manage',
  'platform.plan.manage',
  'platform.impersonate',
  'platform.feature_flag.manage',
])

const SUPPORT = session(['platform.organization.view'])

function setup() {
  const store = new RecordingStore()
  const audit = new InMemoryAuditWriter()
  return {
    store,
    audit,
    operations: definePlatformOperations(store),
    services: { audit },
  }
}

describe('suspendOrganization', () => {
  it('refuses a support role that does not hold the grant', async () => {
    const { operations, services, store } = setup()

    await expect(
      operations.suspendOrganization.run({
        request: { input: { organizationId: ORGANIZATION_ID } },
        context: context(SUPPORT, 'לקוח ביקש הקפאה'),
        services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    // Refused before anything was read. The pipeline authorizes first, with no
    // resource, precisely so a load cannot be reached by a refused caller.
    expect(store.statusWrites).toEqual([])
  })

  it('refuses without a stated reason, and says so as a field issue', async () => {
    const { operations, services, store } = setup()

    const failure = await operations.suspendOrganization
      .run({
        request: { input: { organizationId: ORGANIZATION_ID } },
        context: context(SUPER_ADMIN, null),
        services,
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ValidationError)
    expect((failure as ValidationError).issues.map((i) => i.field)).toContain(
      'reason',
    )
    expect(store.statusWrites).toEqual([])
  })

  it('suspends, writes exactly one status change, and records a readable event', async () => {
    const { operations, services, store, audit } = setup()

    const outcome = await operations.suspendOrganization.run({
      request: { input: { organizationId: ORGANIZATION_ID } },
      context: context(SUPER_ADMIN, 'אי-תשלום מתמשך, לבקשת הנהלת החשבונות'),
      services,
    })

    expect(outcome.ok).toBe(true)
    expect(store.statusWrites).toEqual([
      { id: ORGANIZATION_ID, status: 'suspended' },
    ])

    const [event] = audit.records
    expect(event.actorType).toBe('platform_staff')
    expect(event.actorLabel).toBe('ESTIA · דנה כהן')
    expect(event.organizationId).toBe(ORGANIZATION_ID)
    // The customer reads this row in their own audit screen, so it names the
    // account and says plainly that nothing was deleted.
    expect(event.summary).toContain('וילה כרמל')
    expect(event.summary).toContain('לא נמחק דבר')
    expect(event.reason).toBe('אי-תשלום מתמשך, לבקשת הנהלת החשבונות')
    expect(event.before).toEqual({ status: 'active' })
    expect(event.after).toEqual({ status: 'suspended' })
    // A platform action is ESTIA's own. Nobody at the customer asked for it,
    // and the insert policy in 0041 refuses the row if this is set.
    expect(event.onBehalfOfUserId).toBeNull()
  })

  it('refuses to suspend an account that is already suspended', async () => {
    const { operations, services, store } = setup()
    store.organization = { ...store.organization!, status: 'suspended' }

    await expect(
      operations.suspendOrganization.run({
        request: { input: { organizationId: ORGANIZATION_ID } },
        context: context(SUPER_ADMIN, 'שוב'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses to touch a closed account', async () => {
    const { operations, services, store } = setup()
    store.organization = { ...store.organization!, status: 'closed' }

    // Closing is the owner's own irreversible decision under an owner-only
    // grant. The database function refuses this too.
    await expect(
      operations.suspendOrganization.run({
        request: { input: { organizationId: ORGANIZATION_ID } },
        context: context(SUPER_ADMIN, 'ניסיון'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('restoreOrganization', () => {
  it('restores a suspended account and records it', async () => {
    const { operations, services, store, audit } = setup()
    store.organization = { ...store.organization!, status: 'suspended' }

    await operations.restoreOrganization.run({
      request: { input: { organizationId: ORGANIZATION_ID } },
      context: context(SUPER_ADMIN, 'התשלום הוסדר'),
      services,
    })

    expect(store.statusWrites).toEqual([
      { id: ORGANIZATION_ID, status: 'active' },
    ])
    expect(audit.records[0].summary).toContain('החזיר')
  })

  it('refuses to "restore" an account that was never suspended', async () => {
    const { operations, services } = setup()

    await expect(
      operations.restoreOrganization.run({
        request: { input: { organizationId: ORGANIZATION_ID } },
        context: context(SUPER_ADMIN, 'סתם'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('setCapabilities', () => {
  const base = {
    organizationId: ORGANIZATION_ID,
    entitlementGrants: [],
    entitlementRevocations: [],
    limitOverrides: {},
  }

  it('refuses to grant and revoke the same feature', async () => {
    const { operations, services, store } = setup()

    // effectiveEntitlements() would resolve this silently — revocation wins —
    // so whoever ticked both boxes would believe the grant took effect.
    await expect(
      operations.setCapabilities.run({
        request: {
          input: {
            ...base,
            entitlementGrants: ['website'],
            entitlementRevocations: ['website'],
          },
        },
        context: context(SUPER_ADMIN, 'ניסוי'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(store.capabilityWrites).toEqual([])
  })

  it('drops a limit key the caller did not mention', async () => {
    const { operations, services, store } = setup()

    await operations.setCapabilities.run({
      request: {
        input: {
          ...base,
          entitlementGrants: ['api_access'],
          limitOverrides: { units: 25 },
        },
      },
      context: context(SUPER_ADMIN, 'עסקה מיוחדת: Pro עם 25 יחידות'),
      services,
    })

    // Only `units`. An absent key must fall through to the plan, not arrive as
    // `undefined` and overwrite a real figure.
    expect(store.capabilityWrites[0].limitOverrides).toEqual({ units: 25 })
  })

  it('keeps an explicit null, because null means unlimited', async () => {
    const { operations, services, store } = setup()

    await operations.setCapabilities.run({
      request: {
        input: { ...base, limitOverrides: { members: null } },
      },
      context: context(SUPER_ADMIN, 'ללא הגבלת משתמשים'),
      services,
    })

    expect(store.capabilityWrites[0].limitOverrides).toEqual({ members: null })
  })

  it('refuses a role without platform.feature_flag.manage', async () => {
    const { operations, services } = setup()

    await expect(
      operations.setCapabilities.run({
        request: { input: base },
        context: context(SUPPORT, 'סיבה'),
        services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

describe('openSupportView', () => {
  it('is time-boxed, carries the stated reason onto the row, and is recorded', async () => {
    const { operations, services, store, audit } = setup()

    await operations.openSupportView.run({
      request: { input: { organizationId: ORGANIZATION_ID, minutes: 60 } },
      context: context(SUPER_ADMIN, 'בדיקת תקלה בדוח הכנסות, קריאה #4182'),
      services,
    })

    const [view] = store.supportViews
    expect(view.reason).toBe('בדיקת תקלה בדוח הכנסות, קריאה #4182')
    expect(view.expiresAt.toISOString()).toBe('2026-09-05T10:00:00.000Z')

    // The customer's own trail says what this is and, just as importantly,
    // what it is not.
    expect(audit.records[0].summary).toContain('קריאה בלבד')
    expect(audit.records[0].summary).toContain('אינה התחזות')
  })

  it('refuses a window longer than four hours', async () => {
    const { operations, services, store } = setup()

    // Bounded here and again by a CHECK constraint on the table: a limit
    // enforced only by the screen asking for it is enforced by the asker.
    await expect(
      operations.openSupportView.run({
        request: { input: { organizationId: ORGANIZATION_ID, minutes: 600 } },
        context: context(SUPER_ADMIN, 'חקירה ארוכה'),
        services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(store.supportViews).toEqual([])
  })

  it('refuses without a reason', async () => {
    const { operations, services } = setup()

    await expect(
      operations.openSupportView.run({
        request: { input: { organizationId: ORGANIZATION_ID, minutes: 30 } },
        context: context(SUPER_ADMIN, null),
        services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('the platform actor cannot reach a customer capability', () => {
  it('holds no customer grant at all', () => {
    const actor = platformActorFor(SUPER_ADMIN, ORGANIZATION_ID)

    for (const grant of [
      'booking.delete',
      'payment.refund',
      'guest.view_email',
      'organization.settings.edit',
      'user.remove',
    ] as const) {
      expect(actor.grants.has(grant)).toBe(false)
    }
  })

  it('is minted against one organization and carries no membership of it', () => {
    const actor = platformActorFor(SUPER_ADMIN, ORGANIZATION_ID)

    expect(actor.organizationId).toBe(ORGANIZATION_ID)
    expect(actor.isPlatformStaff).toBe(true)
    // No plan gates the console, and no entitlement is claimed.
    expect(actor.entitlements.size).toBe(0)
  })
})
