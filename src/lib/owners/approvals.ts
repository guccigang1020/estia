/**
 * Owner approvals — the four decisions a managing business is not entitled to
 * take alone.
 *
 * ══ THIS IS NOT A SECOND APPROVAL SYSTEM ═══════════════════════════════════
 *
 * `approvals` already exists as a table (`0011_operations.sql`) and as a domain
 * concept, and the agent network already uses it: a discount above an agent's
 * cap becomes a request rather than a refusal, and `agents/discounts.ts` builds
 * the row that carries it. Everything that mechanism already decided is
 * consumed here rather than restated:
 *
 *   · `APPROVAL_STATUSES` from `contracts/states.ts` — requested, approved,
 *     rejected, expired, withdrawn. Not a fifth vocabulary.
 *   · `approval_type = 'owner_request'`, which the enum already carries and
 *     which exists for precisely this.
 *   · The self-approval rule, which the database enforces by CHECK against the
 *     service role and the table owner as well. It is mirrored in
 *     `decideOwnerApproval` so the refusal reaches the person as a sentence
 *     rather than as a constraint violation, and the CHECK remains the thing
 *     that actually holds.
 *   · The nullable `property_id`, and the `subject_type` / `subject_id` pair
 *     that a generic pointer uses because a foreign key would be a lie.
 *
 * What this file adds is the **owner-shaped reading of that row**: which of the
 * four kinds of ask it is, whether it is still waiting, and the Hebrew a person
 * sees. No table, no status machine, no second queue.
 *
 * ── Who decides, today, and the gap that leaves ───────────────────────────
 *
 * `property_owner` holds four grants — `property.view`, `booking.view`,
 * `owner_statement.view`, `report.financial.view` — and `approval.decide` is
 * not among them. That is not an oversight to route around here: giving the
 * role `approval.decide` would let an owner decide *any* approval in the
 * organization their scope reaches, including an agent's discount, which is
 * nobody's intention. So the operation that records a decision asserts
 * `approval.decide` like every other decision does, and today that means a
 * manager records the owner's answer. The module's report asks for a dedicated
 * `owner_approval.decide` grant gated on `owner_portal`; until it exists this
 * file refuses to pretend the owner can press the button themselves.
 */

import type { Agorot } from '../booking/types'
import type { ApprovalStatus, ApprovalType } from '../contracts/states'
import { BusinessRuleError } from '../errors'

// ── What is being asked ───────────────────────────────────────────────────

export const OWNER_APPROVAL_KINDS = [
  /** A repair whose cost exceeds what the management agreement lets the
   *  business spend without asking. */
  'maintenance_expense',
  /** Spending the owner's money to improve the asset: a new kitchen, a pool
   *  cover. Not a repair, and a different conversation. */
  'upgrade',
  /** Money back to a guest beyond the published policy, which comes out of a
   *  night the owner had already earned. */
  'exceptional_refund',
  /** Work that will take the property off the market. The cost is the ask; the
   *  lost nights are the real one. */
  'planned_repair',
] as const

export type OwnerApprovalKind = (typeof OWNER_APPROVAL_KINDS)[number]

export const OWNER_APPROVAL_KIND_LABEL: Record<OwnerApprovalKind, string> = {
  maintenance_expense: 'הוצאת תחזוקה חריגה',
  upgrade: 'שדרוג בנכס',
  exceptional_refund: 'החזר חריג לאורח',
  planned_repair: 'שיפוץ מתוכנן',
}

/**
 * The `approval_type` every owner request is written as.
 *
 * One constant rather than a mapping from the four kinds, and that is the
 * decision: the type answers *who must decide*, not *what is being decided*. A
 * maintenance approval a supervisor signs off and a maintenance approval the
 * owner must sign off are two different queues, and folding the second into
 * `'maintenance'` would file the owner's decisions into the operations
 * manager's list. The kind lives beside it.
 */
export const OWNER_APPROVAL_TYPE: ApprovalType = 'owner_request'

/**
 * What `approvals.subject_type` carries for these rows.
 *
 * Deliberately not a foreign key — the schema says so and means it — so the
 * string is defined once here rather than typed out at each call site.
 */
export const OWNER_APPROVAL_SUBJECT_TYPE = 'property_owner'

// ── The record ────────────────────────────────────────────────────────────

export interface OwnerApproval {
  id: string
  organizationId: string
  /** The property the ask is about. Owner requests always name one. */
  propertyId: string
  /** Whose decision it is. `approvals.subject_id`. */
  ownerId: string
  kind: OwnerApprovalKind
  status: ApprovalStatus
  /** Why, in the requester's words. Never blank — the schema forbids it too. */
  reason: string
  /** The size of the ask, so a decider sees the exception rather than hearing
   *  that there is one. */
  requestedAgorot: Agorot | null
  /** The ceiling it exceeds. */
  limitAgorot: Agorot | null
  requestedBy: string
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  /** When the request lapses. An unanswered ask must not hold a repair open
   *  forever. */
  expiresAt: string | null
  version: number
}

export interface OwnerApprovalDraft {
  id: string
  organizationId: string
  propertyId: string
  ownerId: string
  kind: OwnerApprovalKind
  reason: string
  requestedAgorot?: Agorot | null
  limitAgorot?: Agorot | null
  requestedBy: string
  expiresAt?: Date | null
}

/**
 * Build the request. Pure — the clock is injected.
 *
 * The reason is checked here as well as by the CHECK constraint, because a
 * request nobody can evaluate is a request that gets approved out of
 * politeness, and the person who has to be told that is the one typing.
 */
export function draftOwnerApproval(
  draft: OwnerApprovalDraft,
  now: Date,
): OwnerApproval {
  if (draft.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'owner_approval_reason_required',
      userMessage:
        'צריך להסביר בקצרה מה מבקשים ולמה. בקשה בלי הסבר לא ניתנת להכרעה.',
      message: 'An owner approval was drafted with a blank reason',
    })
  }

  return {
    id: draft.id,
    organizationId: draft.organizationId,
    propertyId: draft.propertyId,
    ownerId: draft.ownerId,
    kind: draft.kind,
    status: 'requested',
    reason: draft.reason.trim(),
    requestedAgorot: draft.requestedAgorot ?? null,
    limitAgorot: draft.limitAgorot ?? null,
    requestedBy: draft.requestedBy,
    requestedAt: now.toISOString(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: draft.expiresAt ? draft.expiresAt.toISOString() : null,
    version: 1,
  }
}

// ── Deciding ──────────────────────────────────────────────────────────────

export type OwnerApprovalDecision = 'approved' | 'rejected'

export interface DecideOwnerApprovalInput {
  decision: OwnerApprovalDecision
  decidedBy: string
  note?: string | null
  now: Date
}

/**
 * Record the decision, or refuse.
 *
 * Three refusals, and each is a sentence a person can act on:
 *
 *   · **Already decided.** An approval is not a toggle. Changing an answer
 *     after the repair was booked on the strength of it is a new request.
 *   · **Self-decision.** The rule the whole mechanism rests on. The database
 *     holds it by CHECK; this is what turns the 23514 into Hebrew.
 *   · **Expired.** A lapsed ask is not silently revivable — the circumstances
 *     that produced the number have moved, and the honest act is to ask again.
 */
export function decideOwnerApproval(
  approval: OwnerApproval,
  input: DecideOwnerApprovalInput,
): OwnerApproval {
  if (approval.status !== 'requested') {
    throw new BusinessRuleError({
      code: 'owner_approval_already_settled',
      userMessage:
        'הבקשה הזו כבר הוכרעה ואי אפשר לשנות את ההכרעה. אם המצב השתנה, יש להגיש בקשה חדשה.',
      message:
        `Owner approval ${approval.id} is '${approval.status}' and cannot ` +
        `be decided again`,
    })
  }

  if (input.decidedBy === approval.requestedBy) {
    throw new BusinessRuleError({
      code: 'owner_approval_self_decision',
      userMessage:
        'מי שהגיש את הבקשה אינו יכול לאשר אותה בעצמו. נדרש אישור של אדם אחר.',
      message: `User ${input.decidedBy} attempted to decide their own request`,
    })
  }

  if (hasLapsed(approval, input.now)) {
    throw new BusinessRuleError({
      code: 'owner_approval_expired',
      userMessage:
        'תוקף הבקשה פג ולכן לא ניתן להכריע בה. יש להגיש בקשה מעודכנת.',
      message: `Owner approval ${approval.id} expired at ${approval.expiresAt}`,
    })
  }

  return {
    ...approval,
    status: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: input.now.toISOString(),
    decisionNote: input.note?.trim() ? input.note.trim() : null,
    version: approval.version + 1,
  }
}

function hasLapsed(approval: OwnerApproval, now: Date): boolean {
  if (approval.expiresAt === null) return false
  return Date.parse(approval.expiresAt) <= now.getTime()
}

/**
 * Is this still waiting on the owner?
 *
 * Liveness is decided against the clock rather than read from the status, for
 * the same reason `agents/holds.ts` does it: a missing sweeper must not make a
 * lapsed request look actionable, and a request that lapsed thirty seconds ago
 * is not something to show somebody a button for.
 */
export function isAwaitingOwner(approval: OwnerApproval, now: Date): boolean {
  return approval.status === 'requested' && !hasLapsed(approval, now)
}

/** What the owner dashboard puts at the top: how many, and how much money. */
export interface OwnerApprovalTally {
  waiting: number
  approved: number
  rejected: number
  /** The value of what is still waiting, where an amount was named. */
  waitingAgorot: Agorot
}

export function tallyOwnerApprovals(
  approvals: readonly OwnerApproval[],
  now: Date,
): OwnerApprovalTally {
  let waiting = 0
  let approved = 0
  let rejected = 0
  let waitingAgorot = 0

  for (const approval of approvals) {
    if (isAwaitingOwner(approval, now)) {
      waiting += 1
      waitingAgorot += approval.requestedAgorot ?? 0
      continue
    }
    if (approval.status === 'approved') approved += 1
    if (approval.status === 'rejected') rejected += 1
  }

  return { waiting, approved, rejected, waitingAgorot }
}
