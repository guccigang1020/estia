/**
 * Suspending, removing, and why neither deletes anything.
 *
 * > **Removing an agent is not deleting history.**
 *
 * A removed agent is owed money on stays that have not happened yet. A hard
 * delete is a deletion of a debt — and of the attribution behind it, which
 * makes every "direct versus OTA versus agent" report lie retroactively about
 * months that are already closed.
 *
 * So both actions do exactly one thing: they change a status. The bookings, the
 * commissions, the audit trail and the attribution are untouched, and this file
 * has no code path that removes any of them.
 *
 * ── Taking effect immediately ─────────────────────────────────────────────
 *
 * Suspension is the button an owner presses **the moment they discover
 * something**. A mechanism that takes effect "within five minutes" or "at their
 * next login" is a mechanism that was not there when it was needed.
 *
 * It takes effect immediately here for a structural reason rather than a
 * hopeful one: an `Actor` is rebuilt from the database on every request, and
 * `authorize()` refuses any membership that is not `active` before it looks at
 * a single grant. There is no permission cache, nothing durable is held in the
 * client, and an open screen is only a picture — its next request is judged
 * against the row as it is now.
 *
 * `agentActorRoleAssignments` below is what makes that true for agents
 * specifically: their grants are computed from the stored ladders on each
 * request rather than resolved from a system role, so an owner who narrows a
 * ladder has narrowed it for the request already in flight behind them.
 */

import type { MembershipStatus, ResourceFamily, Scope } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { BusinessRuleError } from '../errors'
import { agentRoleAssignment, type AgentAccess } from './access'
import { formatIsraeliPhone } from './phone'
import { inventoryScopeToScope, type AgentOrganizationSettings } from './types'

// ── What survives ─────────────────────────────────────────────────────────

/**
 * Everything that outlives an agent's access.
 *
 * Written down as a list rather than left implicit, because it is the
 * specification's rule and because a future change that starts cascading a
 * delete should have to edit this comment to do it.
 */
export const PRESERVED_ON_REMOVAL = [
  'bookings',
  'commissions',
  'audit_events',
  'attribution',
] as const

// ── The transitions ───────────────────────────────────────────────────────

/**
 * The statuses an agent membership moves between.
 *
 * `removed` is terminal in the sense that it grants nothing, but it is not
 * final: the same person can be added again, and `planAgentInvitation` returns
 * `reactivate_membership` when they are — restoring the membership rather than
 * building a second one, so their history stays attached to them.
 */
const ALLOWED: Partial<Record<MembershipStatus, readonly MembershipStatus[]>> =
  {
    invited: ['active', 'removed'],
    pending: ['active', 'removed'],
    active: ['suspended', 'removed'],
    suspended: ['active', 'removed'],
    removed: ['active'],
  }

export function canChangeAgentStatus(
  from: MembershipStatus,
  to: MembershipStatus,
): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export interface AgentStatusChange {
  settings: AgentOrganizationSettings
  /** The human sentence for the audit trail. Never "membership updated". */
  summary: string
  /** What did *not* change. Carried so a caller cannot quietly cascade. */
  preserved: typeof PRESERVED_ON_REMOVAL
}

export interface ChangeAgentStatusInput {
  to: MembershipStatus
  now: Date
  /** The agent's number, for a sentence a person can read. */
  phoneE164?: string | null
  displayName?: string | null
  reason?: string | null
}

/**
 * Change an agent's status, or refuse.
 *
 * Returns the new settings and a Hebrew sentence. It returns no instruction to
 * touch anything else, and that is deliberate: there is no "and also cancel
 * their commissions" step to accidentally wire up later.
 */
export function changeAgentStatus(
  settings: AgentOrganizationSettings,
  input: ChangeAgentStatusInput,
): AgentStatusChange {
  if (!canChangeAgentStatus(settings.status, input.to)) {
    throw new BusinessRuleError({
      code: 'agent.invalid_status_change',
      message: `Agent cannot move from ${settings.status} to ${input.to}`,
      userMessage: `לא ניתן לשנות את מצב הסוכן מ-${STATUS_LABEL[settings.status]} ל-${STATUS_LABEL[input.to]}.`,
      publicDetails: { from: settings.status, to: input.to },
    })
  }

  const who =
    input.displayName ??
    (input.phoneE164 ? formatIsraeliPhone(input.phoneE164) : 'הסוכן')

  return {
    settings: {
      ...settings,
      status: input.to,
      updatedAt: input.now.toISOString(),
      version: settings.version + 1,
    },
    summary: summaryFor(who, settings.status, input.to, input.reason),
    preserved: PRESERVED_ON_REMOVAL,
  }
}

const STATUS_LABEL: Record<MembershipStatus, string> = {
  invited: 'הוזמן',
  pending: 'ממתין',
  active: 'פעיל',
  suspended: 'מושעה',
  removed: 'הוסר',
}

function summaryFor(
  who: string,
  from: MembershipStatus,
  to: MembershipStatus,
  reason: string | null | undefined,
): string {
  const tail = reason ? ` סיבה: ${reason}.` : ''
  switch (to) {
    case 'suspended':
      return (
        `${who} הושעה. הגישה והשריונים נחסמו מיד; ` +
        `ההזמנות, העמלות והייחוס נשמרו.${tail}`
      )
    case 'removed':
      return (
        `${who} הוסר מרשת הסוכנים. ` +
        `ההזמנות, העמלות, הייחוס וה-Audit נשמרו במלואם.${tail}`
      )
    case 'active':
      return from === 'suspended'
        ? `${who} הוחזר לפעילות.${tail}`
        : `${who} הופעל כסוכן.${tail}`
    default:
      return `מצב הסוכן ${who} שונה מ-${STATUS_LABEL[from]} ל-${STATUS_LABEL[to]}.${tail}`
  }
}

/** Convenience wrappers, so a call site reads as the thing it is doing. */
export function suspendAgent(
  settings: AgentOrganizationSettings,
  input: Omit<ChangeAgentStatusInput, 'to'>,
): AgentStatusChange {
  return changeAgentStatus(settings, { ...input, to: 'suspended' })
}

export function removeAgent(
  settings: AgentOrganizationSettings,
  input: Omit<ChangeAgentStatusInput, 'to'>,
): AgentStatusChange {
  return changeAgentStatus(settings, { ...input, to: 'removed' })
}

export function reinstateAgent(
  settings: AgentOrganizationSettings,
  input: Omit<ChangeAgentStatusInput, 'to'>,
): AgentStatusChange {
  return changeAgentStatus(settings, { ...input, to: 'active' })
}

// ── Building the actor ────────────────────────────────────────────────────

/**
 * The role assignments an agent's membership resolves through.
 *
 * A **custom** assignment carrying the grants the stored ladders produce — not
 * one of the four system role codes. A system role would be re-resolved from
 * the catalogue on every request and would therefore silently overwrite every
 * edit an owner made, and "the preset stays editable after it is chosen" is the
 * specification's central promise about this screen.
 *
 * This is also the mechanism behind "a permission change takes effect
 * immediately". Nothing is cached: the ladders are read and flattened on each
 * request, so narrowing one narrows it for the very next call.
 */
export function agentActorRoleAssignments(access: AgentAccess): readonly [
  {
    code: string
    kind: 'custom'
    grants: readonly Grant[]
  },
] {
  return [agentRoleAssignment(access)]
}

/**
 * The two scopes an agent membership carries.
 *
 * `own_records` by default — so bookings, leads, commissions and statements are
 * confined to theirs by the engine, with no agent-specific filtering anywhere —
 * and an `inventory` override for the properties they may sell.
 *
 * Only `inventory` is overridden. Every other family falls through to the
 * default, which means a family added to the model next year confines an agent
 * to their own records rather than exposing whatever it holds. The fallback
 * direction is the safe one.
 */
export function agentScopes(settings: AgentOrganizationSettings): {
  scope: Scope
  scopeOverrides: Partial<Record<ResourceFamily, Scope>>
} {
  return {
    scope: { kind: 'own_records' },
    scopeOverrides: { inventory: inventoryScopeToScope(settings.inventory) },
  }
}

/**
 * Is this agent allowed to act at all, right now?
 *
 * A cheap pre-check for call sites that have the settings in hand. It is not a
 * substitute for `authorize()`, which asks the same question against the actor
 * and is the one that counts — this exists so a screen can explain *why*
 * somebody is locked out rather than showing them an empty page.
 */
export function agentAccessBlockedReason(
  settings: AgentOrganizationSettings,
): string | null {
  switch (settings.status) {
    case 'active':
      return null
    case 'suspended':
      return 'החשבון שלך מושעה על ידי בעל העסק. פנה אליו כדי להחזיר את הגישה.'
    case 'removed':
      return 'אינך רשום עוד כסוכן בעסק הזה.'
    case 'invited':
    case 'pending':
      return 'ההזמנה שלך טרם הושלמה. אמת את מספר הטלפון כדי להתחיל.'
    default:
      return 'הגישה אינה זמינה.'
  }
}
