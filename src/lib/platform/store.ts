/**
 * EXECUTION CONTEXT — SERVER ONLY. The console's writes, against Postgres.
 *
 * Mapping and nothing else. The rules are in `operations.ts` and are tested
 * without a database; what is here is which function to call and how to read
 * what comes back.
 *
 * ── Two of the three writes are RPCs, and that is the point ───────────────
 *
 * `setOrganizationStatus` and `setCapabilities` call SECURITY DEFINER
 * functions rather than issuing an UPDATE. Row level security decides whether
 * a row may be written; it has no opinion about WHICH COLUMNS an update
 * touched. An UPDATE policy on `organizations` for platform staff would have
 * let this adapter — or a future one, or a crafted request — rename a
 * customer, change their billing country and rewrite their brand colours,
 * while the policy's only opinion was that the caller is staff.
 *
 * So the column list is inside the database. `platform_set_organization_status`
 * writes `status`. `platform_set_organization_capabilities` writes the three
 * override columns. Neither can be made to write anything else from here, and
 * both re-check `has_platform_permission` on their own account — this adapter
 * is not trusted to have checked.
 *
 * The third, opening a support view, is an ordinary insert: the row is the
 * whole record, so there is nothing to narrow.
 */

import type { Db, Row } from '@/lib/persistence'
import {
  asEnum,
  asJsonRecord,
  asString,
  asStringArray,
  asTimestamp,
  toRows,
} from '@/lib/persistence'
import { ENTITLEMENTS, type Entitlement } from '@/lib/plans/entitlements'

import { ORGANIZATION_STATUSES } from './organizations'
import type {
  CapabilityOverrides,
  OrganizationSnapshot,
  PlatformStore,
  SupportViewRecord,
} from './operations'

export class SupabasePlatformStore implements PlatformStore {
  constructor(
    private readonly db: Db,
    /** The signed-in staff member. The insert policy checks it independently. */
    private readonly staffUserId: string,
  ) {}

  async readOrganization(
    organizationId: string,
  ): Promise<OrganizationSnapshot | null> {
    const { data, error } = await this.db
      .from('organizations')
      .select('id, name, status')
      .eq('id', organizationId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return null

    const row = data as Row
    return {
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      status: asEnum(row, 'status', ORGANIZATION_STATUSES),
    }
  }

  async setOrganizationStatus(
    organizationId: string,
    status: 'active' | 'suspended',
  ): Promise<void> {
    const { error } = await this.db.rpc('platform_set_organization_status', {
      target_organization_id: organizationId,
      next_status: status,
    })

    if (error) throw new Error(error.message)
  }

  async readCapabilities(
    organizationId: string,
  ): Promise<CapabilityOverrides | null> {
    const { data, error } = await this.db
      .from('organization_subscriptions')
      .select('entitlement_grants, entitlement_revocations, limit_overrides')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return null

    const row = data as Row
    return {
      entitlementGrants: knownEntitlements(row, 'entitlement_grants'),
      entitlementRevocations: knownEntitlements(row, 'entitlement_revocations'),
      limitOverrides: numericLimits(asJsonRecord(row, 'limit_overrides')),
    }
  }

  async setCapabilities(
    organizationId: string,
    overrides: CapabilityOverrides,
  ): Promise<void> {
    const { error } = await this.db.rpc(
      'platform_set_organization_capabilities',
      {
        target_organization_id: organizationId,
        grants: [...overrides.entitlementGrants],
        revocations: [...overrides.entitlementRevocations],
        limits: overrides.limitOverrides,
      },
    )

    if (error) throw new Error(error.message)
  }

  async openSupportView(input: {
    organizationId: string
    reason: string
    expiresAt: Date
  }): Promise<SupportViewRecord> {
    const { data, error } = await this.db
      .from('platform_support_sessions')
      .insert({
        staff_user_id: this.staffUserId,
        organization_id: input.organizationId,
        reason: input.reason,
        expires_at: input.expiresAt.toISOString(),
      })
      .select('id, organization_id, started_at, expires_at')
      .single()

    if (error) throw new Error(error.message)

    const row = data as Row
    return {
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      startedAt: asTimestamp(row, 'started_at'),
      expiresAt: asTimestamp(row, 'expires_at'),
    }
  }

  /**
   * End a view early.
   *
   * Filtered by `staff_user_id` as well as by id, so a mistyped id closes
   * nothing rather than closing a colleague's session. The policy says the
   * same thing; this is the client-side half of the same statement, and it
   * turns a silent no-op into a filter that matched no rows.
   */
  async closeSupportView(sessionId: string): Promise<void> {
    const { error } = await this.db
      .from('platform_support_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('staff_user_id', this.staffUserId)
      .is('ended_at', null)

    if (error) throw new Error(error.message)
  }
}

/* -------------------------------------------------------------- the reads -- */

export interface SupportViewSummary {
  id: string
  organizationId: string
  organizationName: string
  staffUserId: string
  reason: string
  startedAt: string
  expiresAt: string
  endedAt: string | null
  /** Computed against the clock, not stored. */
  open: boolean
}

/**
 * Support views for one organization, newest first.
 *
 * Every one of them, not only the open ones. "Who at ESTIA looked at my
 * account" is a question about the past, and a list filtered to what is
 * currently open answers it with silence.
 */
export async function listSupportViews(
  db: Db,
  organizationId: string,
  now: Date = new Date(),
): Promise<readonly SupportViewSummary[]> {
  const { data, error } = await db
    .from('platform_support_sessions')
    .select(
      'id, organization_id, staff_user_id, reason, started_at, expires_at, ended_at',
    )
    .eq('organization_id', organizationId)
    .order('started_at', { ascending: false })
    .limit(50)

  if (error) throw new Error(error.message)

  return toRows(data).map((row) => {
    const expiresAt = asTimestamp(row, 'expires_at')
    const endedAt = row['ended_at']

    return {
      id: asString(row, 'id'),
      organizationId: asString(row, 'organization_id'),
      organizationName: '',
      staffUserId: asString(row, 'staff_user_id'),
      reason: asString(row, 'reason'),
      startedAt: asTimestamp(row, 'started_at'),
      expiresAt,
      endedAt: typeof endedAt === 'string' ? endedAt : null,
      open: endedAt === null && new Date(expiresAt) > now,
    }
  })
}

/* ------------------------------------------------------------- internals -- */

function knownEntitlements(row: Row, column: string): readonly Entitlement[] {
  const known = ENTITLEMENTS as readonly string[]
  return asStringArray(row, column).filter((value): value is Entitlement =>
    known.includes(value),
  )
}

/**
 * The stored override object, as numbers and nulls.
 *
 * `null` is kept because it means "unlimited" — a real instruction that must
 * not be flattened into "no override". Anything that is neither a number nor
 * null is dropped: the CHECK constraint in 0003 should make that impossible,
 * and a value the console cannot read is not a value it should re-save.
 */
function numericLimits(
  stored: Record<string, unknown>,
): Record<string, number | null> {
  const result: Record<string, number | null> = {}

  for (const [key, value] of Object.entries(stored)) {
    if (value === null) result[key] = null
    else if (typeof value === 'number') result[key] = value
  }

  return result
}
