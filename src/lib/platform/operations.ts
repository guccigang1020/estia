/**
 * The console's entire write surface. Four operations, and that is the list.
 *
 * ══ WHAT ESTIA STAFF CAN CHANGE ABOUT A CUSTOMER ══════════════════════════
 *
 *   1. Suspend the account.
 *   2. Restore it.
 *   3. Change what the account's package includes — the per-customer
 *      entitlement grants, revocations and limit overrides.
 *   4. Open and close a read-only support view of it.
 *
 * Nothing else. Not a booking, not a payment, not a guest, not a member's
 * role, not the organization's name. That is enforced in three independent
 * places and this file is the weakest of the three: the actor holds only
 * `platform.*` grants (`actor.ts`), the database functions each write exactly
 * one thing (0041), and every policy is written against
 * `has_platform_permission`, which knows nothing about this module.
 *
 * ── Every one of them demands a reason ────────────────────────────────────
 *
 * `requiresReason: true` on all four, explicitly, rather than left to
 * `SENSITIVE_ACTIONS`. Only `platform.impersonate` is in that set, and the
 * other three are exactly as consequential from the customer's side: somebody
 * they have never met turned their account off. The reason goes into the audit
 * row in their own trail, where they can read it.
 *
 * ── Suspending deletes nothing, and this is where that is true ────────────
 *
 * `platform_set_organization_status` writes one column. There is no delete
 * anywhere in this file, `organizations` has no DELETE policy at all (0004),
 * and `audit_events.organization_id` is `on delete restrict` precisely so that
 * losing an organization could never take its history. A suspended customer
 * keeps every row they had and gets all of it back on restore.
 */

import { defineOperation, s, type Operation } from '@/lib/service'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'
import { BusinessRuleError } from '@/lib/errors'

import type { OrganizationStatus } from './organizations'

/* ------------------------------------------------------------------ port -- */

/** Just enough of an organization to decide and to describe the change. */
export interface OrganizationSnapshot {
  id: string
  name: string
  status: OrganizationStatus
}

export interface CapabilityOverrides {
  entitlementGrants: readonly Entitlement[]
  entitlementRevocations: readonly Entitlement[]
  limitOverrides: Record<string, number | null>
}

export interface SupportViewRecord {
  id: string
  organizationId: string
  startedAt: string
  expiresAt: string
}

/**
 * What the operations need from the database.
 *
 * A port, so the rules above can be tested without a Supabase project — the
 * same reason every other domain in this codebase declares one. The Supabase
 * implementation is `SupabasePlatformStore` in `store.ts`, and it does nothing
 * but call the two definer functions and insert one row.
 */
export interface PlatformStore {
  readOrganization(organizationId: string): Promise<OrganizationSnapshot | null>
  setOrganizationStatus(
    organizationId: string,
    status: 'active' | 'suspended',
  ): Promise<void>
  readCapabilities(organizationId: string): Promise<CapabilityOverrides | null>
  setCapabilities(
    organizationId: string,
    overrides: CapabilityOverrides,
  ): Promise<void>
  openSupportView(input: {
    organizationId: string
    reason: string
    expiresAt: Date
  }): Promise<SupportViewRecord>
  closeSupportView(sessionId: string): Promise<void>
}

/* ---------------------------------------------------------------- schemas -- */

const organizationInput = s.object({
  organizationId: s.uuid({ label: 'ארגון' }),
})

const capabilityInput = s.object({
  organizationId: s.uuid({ label: 'ארגון' }),
  entitlementGrants: s.arrayOf(s.enumOf(ENTITLEMENTS), {
    label: 'יכולות שנוספו',
  }),
  entitlementRevocations: s.arrayOf(s.enumOf(ENTITLEMENTS), {
    label: 'יכולות שנשללו',
  }),
  // The four keys of `PlanLimits`, each a number or an explicit null. `null`
  // is "unlimited" and is a real instruction; an absent key means "leave the
  // package's figure alone", which is why these are optional AND nullable and
  // the two are not the same statement.
  limitOverrides: s.object({
    properties: s.optional(
      s.nullable(s.number({ label: 'נכסים', min: 0, integer: true })),
    ),
    units: s.optional(
      s.nullable(s.number({ label: 'יחידות', min: 0, integer: true })),
    ),
    members: s.optional(
      s.nullable(s.number({ label: 'משתמשים', min: 0, integer: true })),
    ),
    storageGb: s.optional(
      s.nullable(s.number({ label: 'אחסון (GB)', min: 0, integer: true })),
    ),
  }),
})

const supportViewInput = s.object({
  organizationId: s.uuid({ label: 'ארגון' }),
  /**
   * How long the view stays open, in minutes.
   *
   * Bounded here at four hours and again by a CHECK constraint on the table,
   * because a limit enforced only by the screen that asks for it is a limit
   * enforced by whoever is asking.
   */
  minutes: s.number({ label: 'משך', min: 5, max: 240, integer: true }),
})

const closeSupportViewInput = s.object({
  sessionId: s.uuid({ label: 'צפייה' }),
  organizationId: s.uuid({ label: 'ארגון' }),
})

/* ------------------------------------------------------------- operations -- */

export interface PlatformOperations {
  suspendOrganization: Operation<
    { organizationId: string },
    OrganizationSnapshot,
    OrganizationSnapshot
  >
  restoreOrganization: Operation<
    { organizationId: string },
    OrganizationSnapshot,
    OrganizationSnapshot
  >
  setCapabilities: Operation<
    {
      organizationId: string
      entitlementGrants: Entitlement[]
      entitlementRevocations: Entitlement[]
      limitOverrides: {
        properties?: number | null
        units?: number | null
        members?: number | null
        storageGb?: number | null
      }
    },
    OrganizationSnapshot,
    CapabilityOverrides
  >
  openSupportView: Operation<
    { organizationId: string; minutes: number },
    OrganizationSnapshot,
    SupportViewRecord
  >
  closeSupportView: Operation<
    { sessionId: string; organizationId: string },
    OrganizationSnapshot,
    { sessionId: string }
  >
}

export function definePlatformOperations(
  store: PlatformStore,
): PlatformOperations {
  /**
   * The target, loaded so the pipeline can re-authorize against a real
   * resource and so the audit row can name the customer rather than their id.
   *
   * `family` is deliberately absent. Scope families narrow a member inside
   * their organization, and this actor has no scope to narrow —
   * `isWithinScope()` short-circuits on `isPlatformStaff` before a family is
   * ever consulted.
   */
  const loadOrganization = async ({
    input,
  }: {
    input: { organizationId: string }
  }) => {
    const organization = await store.readOrganization(input.organizationId)
    if (!organization) return null

    return {
      resource: { organizationId: organization.id },
      entity: organization,
    }
  }

  const suspendOrganization = defineOperation<
    { organizationId: string },
    OrganizationSnapshot,
    OrganizationSnapshot
  >({
    name: 'platform.organization.suspend',
    permission: 'platform.organization.manage',
    resourceType: 'organization',
    input: organizationInput,
    requiresReason: true,
    loadResource: loadOrganization,

    rule: ({ entity }) => {
      if (entity.status === 'suspended') {
        throw new BusinessRuleError({
          code: 'already_suspended',
          message: `Organization ${entity.id} is already suspended`,
          userMessage: 'הארגון כבר מושהה. לא בוצע שינוי.',
        })
      }
      // A closed account is the customer's own irreversible decision under an
      // owner-only grant. Suspending one would be ESTIA overwriting a state it
      // did not set; the database function refuses it too.
      if (entity.status === 'closed') {
        throw new BusinessRuleError({
          code: 'organization_closed',
          message: `Organization ${entity.id} is closed`,
          userMessage:
            'הארגון סגור. סגירה היא החלטה של בעל הארגון, וקונסולת הפלטפורמה אינה משנה אותה.',
        })
      }
    },

    execute: async ({ entity }) => {
      await store.setOrganizationStatus(entity.id, 'suspended')
      return { ...entity, status: 'suspended' as const }
    },

    audit: ({ entity, result }) => ({
      resourceId: entity.id,
      summary: `צוות ESTIA השהה את החשבון "${entity.name}". הנתונים נשמרו במלואם ולא נמחק דבר.`,
      before: { status: entity.status },
      after: { status: result.status },
    }),
  })

  const restoreOrganization = defineOperation<
    { organizationId: string },
    OrganizationSnapshot,
    OrganizationSnapshot
  >({
    name: 'platform.organization.restore',
    permission: 'platform.organization.manage',
    resourceType: 'organization',
    input: organizationInput,
    requiresReason: true,
    loadResource: loadOrganization,

    rule: ({ entity }) => {
      if (entity.status !== 'suspended') {
        throw new BusinessRuleError({
          code: 'not_suspended',
          message: `Organization ${entity.id} is ${entity.status}, not suspended`,
          userMessage:
            'אפשר להחזיר לפעילות רק ארגון מושהה. החשבון הזה אינו מושהה.',
        })
      }
    },

    execute: async ({ entity }) => {
      await store.setOrganizationStatus(entity.id, 'active')
      return { ...entity, status: 'active' as const }
    },

    audit: ({ entity, result }) => ({
      resourceId: entity.id,
      summary: `צוות ESTIA החזיר את החשבון "${entity.name}" לפעילות.`,
      before: { status: entity.status },
      after: { status: result.status },
    }),
  })

  const setCapabilities = defineOperation<
    {
      organizationId: string
      entitlementGrants: Entitlement[]
      entitlementRevocations: Entitlement[]
      limitOverrides: {
        properties?: number | null
        units?: number | null
        members?: number | null
        storageGb?: number | null
      }
    },
    OrganizationSnapshot,
    CapabilityOverrides
  >({
    name: 'platform.organization.capabilities',
    permission: 'platform.feature_flag.manage',
    resourceType: 'organization_subscription',
    input: capabilityInput,
    requiresReason: true,
    loadResource: loadOrganization,

    rule: ({ input }) => {
      // A feature both granted and revoked is not a preference, it is a
      // mistake. `effectiveEntitlements()` would resolve it — revocation wins
      // — and resolve it silently, so whoever ticked both boxes would believe
      // the grant took effect. Refused here rather than resolved.
      const revoked = new Set(input.entitlementRevocations)
      const both = input.entitlementGrants.filter((entitlement) =>
        revoked.has(entitlement),
      )

      if (both.length > 0) {
        throw new BusinessRuleError({
          code: 'granted_and_revoked',
          message: `Entitlements granted and revoked at once: ${both.join(', ')}`,
          userMessage: `אי אפשר גם להוסיף וגם לשלול את אותה יכולת (${both.join(', ')}). שלילה גוברת על הוספה, ולכן הבחירה הזו הייתה נקראת כשלילה בלבד.`,
        })
      }
    },

    execute: async ({ input, entity }) => {
      const overrides: CapabilityOverrides = {
        entitlementGrants: input.entitlementGrants,
        entitlementRevocations: input.entitlementRevocations,
        limitOverrides: definedLimits(input.limitOverrides),
      }
      await store.setCapabilities(entity.id, overrides)
      return overrides
    },

    audit: ({ entity, result }) => ({
      resourceId: entity.id,
      summary:
        `צוות ESTIA עדכן את היכולות של "${entity.name}": ` +
        `${describe('נוספו', result.entitlementGrants)}, ` +
        `${describe('נשללו', result.entitlementRevocations)}, ` +
        `${describeLimits(result.limitOverrides)}.`,
      after: {
        entitlementGrants: [...result.entitlementGrants],
        entitlementRevocations: [...result.entitlementRevocations],
        limitOverrides: result.limitOverrides,
      },
    }),
  })

  const openSupportView = defineOperation<
    { organizationId: string; minutes: number },
    OrganizationSnapshot,
    SupportViewRecord
  >({
    name: 'platform.support_view.open',
    permission: 'platform.impersonate',
    resourceType: 'organization',
    input: supportViewInput,
    // Already implied by SENSITIVE_ACTIONS, and written out because this is
    // the one operation where the reason is the whole justification.
    requiresReason: true,
    loadResource: loadOrganization,

    execute: async ({ input, entity, now, context }) => {
      // The reason is validated by the pipeline before `execute` runs, so it
      // is present and not blank. It is recorded on the row as well as in the
      // audit event, because the row is what expires and the sentence is what
      // a person reads afterwards. `platform_support_sessions_reason_not_blank`
      // refuses the insert if this ever arrives empty.
      const reason = (context.reason ?? '').trim()

      return store.openSupportView({
        organizationId: entity.id,
        reason,
        expiresAt: new Date(now.getTime() + input.minutes * 60 * 1000),
      })
    },

    audit: ({ entity, result, context }) => ({
      resourceId: entity.id,
      summary:
        `צוות ESTIA פתח צפייה בקריאה בלבד בחשבון "${entity.name}", ` +
        `בתוקף עד ${new Date(result.expiresAt).toLocaleString('he-IL')}. ` +
        `זו אינה התחזות: לא נוצר חיבור בשם משתמש שלכם ולא בוצעה שום כתיבה.`,
      after: {
        supportViewId: result.id,
        expiresAt: result.expiresAt,
        reason: context.reason ?? null,
      },
    }),
  })

  const closeSupportView = defineOperation<
    { sessionId: string; organizationId: string },
    OrganizationSnapshot,
    { sessionId: string }
  >({
    name: 'platform.support_view.close',
    permission: 'platform.impersonate',
    resourceType: 'organization',
    input: closeSupportViewInput,
    requiresReason: false,
    loadResource: loadOrganization,

    execute: async ({ input }) => {
      await store.closeSupportView(input.sessionId)
      return { sessionId: input.sessionId }
    },

    audit: ({ entity, result }) => ({
      resourceId: entity.id,
      summary: `צוות ESTIA סגר את הצפייה בחשבון "${entity.name}".`,
      after: { supportViewId: result.sessionId },
    }),
  })

  return {
    suspendOrganization,
    restoreOrganization,
    setCapabilities,
    openSupportView,
    closeSupportView,
  }
}

/* -------------------------------------------------------------- sentences -- */

/**
 * Drop the keys the caller did not mention.
 *
 * An absent key means "leave the package's figure alone" and must not reach
 * the database as `undefined`: `effectiveLimits()` learned this the hard way —
 * an override carrying `undefined` copied over a real figure, `checkQuota`
 * then compared against nothing, and the customer was locked out of inviting
 * staff by a key that was never meant to say anything.
 */
function definedLimits(
  overrides: Record<string, number | null | undefined>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function describe(verb: string, entitlements: readonly string[]): string {
  return entitlements.length === 0
    ? `לא ${verb} יכולות`
    : `${verb} ${entitlements.join(', ')}`
}

function describeLimits(limits: Record<string, number | null>): string {
  const entries = Object.entries(limits)
  if (entries.length === 0) return 'ללא חריגות מכסה'

  return `מכסות: ${entries
    .map(([key, value]) => `${key}=${value === null ? 'ללא הגבלה' : value}`)
    .join(', ')}`
}
