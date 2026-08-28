/**
 * The agent operations.
 *
 * Seven things a person can actually do to the agent network, each declared
 * with `defineOperation` so none of them can reach a write without having
 * passed authorization, validation, the version check, the domain rule and the
 * audit trail. There is no second path to any of these rows.
 *
 * Three habits, because they are the ones easy to get wrong here:
 *
 * **Nothing is stashed between steps.** The definition object is shared by
 * every concurrent run, so a value computed in `rule` and read in `execute`
 * would be one request's answer used for another's. Pure things — the plan, the
 * arithmetic — are recomputed where needed.
 *
 * **Scope is asserted by hand where there is nothing to load.** The pipeline
 * checks tenant and scope against the *loaded* resource, which a create
 * operation does not have. `agentHold.create` therefore calls `assertCan` again
 * against the unit its own input names, with `family: 'inventory'` so the
 * agent's per-family override applies. Without it an agent scoped to one
 * property could hold dates in another.
 *
 * **The audit sentence is written by the operation.** The pipeline cannot know
 * that the number which changed was a discount cap; only the operation does,
 * and "הבעלים העלה את תקרת ההנחה של דוד מ-5% ל-10%" is the charter's
 * requirement rather than a nicety.
 */

import { assertCan, type Actor, type Resource } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { defineOperation, s } from '../service'
import {
  AGENT_PRESETS,
  AGENT_PRESET_NAMES,
  parseAgentAccess,
  type AgentAccess,
} from './access'
import {
  advanceCommission,
  COMMISSION_STATUS_LABEL,
  type Commission,
} from './commission'
import {
  decideDiscountApproval,
  evaluateAgentDiscount,
  type DiscountApproval,
} from './discounts'
import {
  assertAgentExtensionAllowed,
  effectiveHoldLimits,
  holdsStartedOn,
  planAgentHold,
  recordExtension,
  type AgentHoldLedgerEntry,
} from './holds'
import {
  buildInvitation,
  describeInvitationPlan,
  planAgentInvitation,
} from './identity'
import { changeAgentStatus } from './lifecycle'
import type { AgentRepository } from './repository'
import {
  assertAgentReach,
  inventoryResource,
  type AgentOrganizationSettings,
} from './types'

// ── Shared pieces ─────────────────────────────────────────────────────────

const MEMBERSHIP_STATUSES = [
  'invited',
  'pending',
  'active',
  'suspended',
  'removed',
] as const

/** The settings row as an authorization resource. */
function settingsResource(
  settings: AgentOrganizationSettings,
  family: Resource['family'] = 'team',
): Resource {
  return {
    organizationId: settings.organizationId,
    assignedToUserId: settings.agentUserId,
    family,
  }
}

function shekels(agorot: number): string {
  return `₪${(agorot / 100).toLocaleString('he-IL', {
    maximumFractionDigits: 2,
  })}`
}

// ── The factory ───────────────────────────────────────────────────────────

/**
 * Build the operations against a repository.
 *
 * A factory rather than module-level constants, because the repository is the
 * thing that varies: Supabase in the application and an in-memory double in the
 * tests. The operations themselves are identical in both.
 */
export function defineAgentOperations(repo: AgentRepository) {
  // ── agent.invite ────────────────────────────────────────────────────────

  /**
   * Add an agent by telephone number.
   *
   * The only required field is the number, because an owner does this during
   * the phone call. Which of the three branches it takes is decided by
   * `planAgentInvitation`, and the operation's whole job is to carry that
   * decision into a transaction and describe it in the audit trail.
   */
  const invite = defineOperation({
    name: 'agent.invite',
    permission: 'agent.invite',
    resourceType: 'agent',
    input: s.object({
      phone: s.string({ label: 'טלפון', min: 1, max: 32 }),
      displayName: s.optional(s.string({ max: 120, label: 'שם' })),
      email: s.optional(s.string({ max: 200, label: 'אימייל' })),
      preset: s.optional(s.enumOf(AGENT_PRESET_NAMES, { label: 'ערכה' })),
      invitationId: s.string({ label: 'מזהה הזמנה' }),
      internalNote: s.optional(s.string({ max: 500, label: 'הערה פנימית' })),
    }),

    async execute({ input, context, now, tx }) {
      const { actor } = context
      const access: AgentAccess = AGENT_PRESETS[input.preset ?? 'sales']

      const plan = await planAgentInvitation(repo, {
        organizationId: actor.organizationId,
        phone: input.phone,
        displayName: input.displayName ?? null,
      })

      if (
        plan.branch === 'already_an_agent' ||
        plan.branch === 'invitation_already_pending'
      ) {
        // Not an error. Adding somebody twice is a thing owners do, and
        // refusing it with a red banner teaches them the button is broken.
        return { plan, invitation: null, settings: null }
      }

      if (plan.branch === 'invite_new_user') {
        const invitation = await repo.insertInvitation(
          buildInvitation({
            id: input.invitationId,
            organizationId: actor.organizationId,
            phoneE164: plan.phoneE164,
            displayName: plan.displayName,
            email: input.email ?? null,
            invitedByUserId: actor.userId,
            access,
            inventory: { kind: 'all_properties' },
            now,
          }),
          tx,
        )
        return { plan, invitation, settings: null }
      }

      // The two branches that touch an existing person. Neither creates a user.
      const settings = await repo.attachExistingUser(
        {
          organizationId: actor.organizationId,
          userId: plan.userId,
          settings: {
            organizationId: actor.organizationId,
            agentUserId: plan.userId,
            membershipId:
              plan.branch === 'reactivate_membership' ? plan.membershipId : '',
            status: 'active',
            access,
            inventory: { kind: 'all_properties' },
            discountCap: { maxPercent: 0, maxAgorot: null },
            holdLimits: {
              maxConcurrent: 3,
              maxPerDay: 10,
              maxExtensions: 1,
              defaultMinutes: 30,
              maxMinutes: 120,
            },
            reputationScore: 0,
            agencyId: null,
            internalNote: input.internalNote ?? null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            version: 1,
          },
        },
        tx,
      )
      return { plan, invitation: null, settings }
    },

    audit({ result }) {
      return {
        summary: describeInvitationPlan(result.plan),
        after: { branch: result.plan.branch, phone: result.plan.phoneE164 },
      }
    },

    events({ result, context }) {
      if (
        result.plan.branch === 'already_an_agent' ||
        result.plan.branch === 'invitation_already_pending'
      ) {
        return []
      }
      return [
        {
          name: 'agent.invited' as const,
          payload: {
            phoneE164: result.plan.phoneE164,
            branch: result.plan.branch,
            invitedByUserId: context.actor.userId,
          },
        },
      ]
    },
  })

  // ── agent.access.update ─────────────────────────────────────────────────

  /**
   * Move an agent up or down the ladders.
   *
   * Guarded by `agent.scope.manage` — the permission the catalogue describes as
   * "the blast radius, not an attribute" — which is in `SENSITIVE_ACTIONS` and
   * therefore demands a stated reason. Widening what an outsider may see is the
   * same class of decision as editing permissions, and it is audited with the
   * before and the after so "who widened this" is answerable.
   *
   * The new access arrives as unknown data and goes through `parseAgentAccess`,
   * which rebuilds it through the union rather than casting into it. An
   * incoherent combination is refused at this boundary, which is the one place
   * the compiler cannot reach.
   */
  const updateAccess = defineOperation({
    name: 'agent.access.update',
    permission: 'agent.scope.manage',
    resourceType: 'agent',
    requiresVersion: true,
    input: s.object({
      agentUserId: s.string({ label: 'סוכן' }),
      access: s.object(
        {
          calendar: s.string(),
          price: s.string(),
          guestData: s.string(),
          amendments: s.optional(s.arrayOf(s.string(), { max: 10 })),
          cancellation: s.optional(
            s.object(
              { kind: s.string(), hours: s.optional(s.number({ min: 0 })) },
              { label: 'מדיניות ביטול' },
            ),
          ),
          paymentLink: s.optional(s.boolean()),
        },
        { label: 'הרשאות' },
      ),
    }),

    async loadResource({ input, context }) {
      const settings = await repo.loadSettings(
        context.actor.organizationId,
        input.agentUserId,
      )
      if (!settings) return null
      return {
        resource: settingsResource(settings),
        entity: settings,
        version: settings.version,
      }
    },

    rule({ input }) {
      if (parseAgentAccess(input.access) === null) {
        throw new BusinessRuleError({
          code: 'agent_access.incoherent',
          message: `Incoherent access combination: ${JSON.stringify(input.access)}`,
          userMessage:
            'צירוף ההרשאות אינו אפשרי. לדוגמה: לא ניתן לתת מחיר לסוכן שאינו רואה את היומן.',
        })
      }
    },

    async execute({ input, entity, now, tx }) {
      // Recomputed rather than carried from `rule`: the definition is shared
      // between concurrent runs, and a stashed value is one request's answer
      // used for another's.
      const access = parseAgentAccess(input.access) as AgentAccess
      return repo.saveSettings(
        {
          ...entity,
          access,
          updatedAt: now.toISOString(),
          version: entity.version + 1,
        },
        entity.version,
        tx,
      )
    },

    audit({ entity, result }) {
      return {
        summary:
          `הרשאות הסוכן עודכנו: יומן ${entity.access.calendar} → ${result.access.calendar}, ` +
          `מחיר ${entity.access.price} → ${result.access.price}, ` +
          `נתוני אורח ${entity.access.guestData} → ${result.access.guestData}.`,
        before: {
          calendar: entity.access.calendar,
          price: entity.access.price,
          guestData: entity.access.guestData,
        },
        after: {
          calendar: result.access.calendar,
          price: result.access.price,
          guestData: result.access.guestData,
        },
        resourceId: entity.agentUserId,
      }
    },

    events({ result }) {
      return [
        {
          name: 'agent.permissions_changed' as const,
          payload: { agentUserId: result.agentUserId, access: result.access },
        },
      ]
    },
  })

  // ── agent.suspend ───────────────────────────────────────────────────────

  /**
   * Block an agent's access immediately, keeping everything they produced.
   *
   * The operation writes one status and nothing else. There is no cascade here
   * and there must never be one: a suspended agent is still owed money on stays
   * that have not happened.
   */
  const setStatus = defineOperation({
    name: 'agent.set_status',
    permission: 'agent.manage',
    resourceType: 'agent',
    requiresVersion: true,
    requiresReason: true,
    input: s.object({
      agentUserId: s.string({ label: 'סוכן' }),
      status: s.enumOf(MEMBERSHIP_STATUSES, { label: 'מצב' }),
      phoneE164: s.optional(s.string({ max: 32 })),
      displayName: s.optional(s.string({ max: 120 })),
    }),

    async loadResource({ input, context }) {
      const settings = await repo.loadSettings(
        context.actor.organizationId,
        input.agentUserId,
      )
      if (!settings) return null
      return {
        resource: settingsResource(settings),
        entity: settings,
        version: settings.version,
      }
    },

    async execute({ input, entity, context, now, tx }) {
      const change = changeAgentStatus(entity, {
        to: input.status,
        now,
        phoneE164: input.phoneE164 ?? null,
        displayName: input.displayName ?? null,
        reason: context.reason ?? null,
      })
      const saved = await repo.saveSettings(change.settings, entity.version, tx)
      return { settings: saved, summary: change.summary }
    },

    audit({ entity, result }) {
      return {
        summary: result.summary,
        before: { status: entity.status },
        after: { status: result.settings.status },
        resourceId: entity.agentUserId,
      }
    },

    events({ result }) {
      if (result.settings.status !== 'suspended') return []
      return [
        {
          name: 'agent.suspended' as const,
          payload: { agentUserId: result.settings.agentUserId },
        },
      ]
    },
  })

  // ── agentHold.create ────────────────────────────────────────────────────

  /**
   * Hold dates while an agent closes a deal.
   *
   * Two authorization steps rather than one. The pipeline settles the grant and
   * the plan before anything is read; then this asserts the *unit* against the
   * agent's `inventory` scope, because a create operation has no loaded
   * resource for the pipeline's second check to use.
   *
   * The concurrency count is computed in the domain over everything the store
   * returns, not in SQL. A `WHERE expires_at > now()` in the query and
   * `isHoldLive` here would be two definitions of the same word, and the day
   * they disagreed an agent would be locked out by holds that expired last week.
   */
  const createHold = defineOperation({
    name: 'agent_hold.create',
    permission: 'hold.create',
    resourceType: 'hold',
    input: s.object({
      unitId: s.string({ label: 'יחידה' }),
      propertyId: s.optional(s.string()),
      checkIn: s.string({ label: 'תאריך הגעה' }),
      checkOut: s.string({ label: 'תאריך עזיבה' }),
      minutes: s.optional(s.number({ integer: true, min: 1, max: 1440 })),
      holdId: s.string({ label: 'מזהה החזקה' }),
      liveHoldCount: s.number({ integer: true, min: 0 }),
    }),

    async rule({ input, context, now }) {
      const { actor } = context
      const settings = await requireSettings(actor)

      assertAgentReach(actor, {
        organizationId: actor.organizationId,
        propertyId: input.propertyId ?? null,
        unitId: input.unitId,
      })
      assertCan(
        actor,
        'hold.create',
        inventoryResource({
          organizationId: actor.organizationId,
          propertyId: input.propertyId ?? null,
          unitId: input.unitId,
        }),
      )

      const ledger = await repo.loadHoldLedger(
        actor.organizationId,
        actor.userId,
      )

      // Throws when either ceiling is reached. Nothing is written first.
      planAgentHold({
        organizationId: actor.organizationId,
        unitId: input.unitId,
        range: { checkIn: input.checkIn, checkOut: input.checkOut },
        agentUserId: actor.userId,
        now,
        minutes: input.minutes,
        allowance: {
          limits: effectiveHoldLimits(
            settings.holdLimits,
            settings.reputationScore,
          ),
          liveHoldCount: input.liveHoldCount,
          holdsStartedToday: holdsStartedOn(ledger, actor.userId, now),
        },
      })
    },

    async execute({ input, context, now, tx }) {
      const entry: AgentHoldLedgerEntry = {
        holdId: input.holdId,
        organizationId: context.actor.organizationId,
        agentUserId: context.actor.userId,
        createdAt: now.toISOString(),
        extensionCount: 0,
      }
      return repo.insertLedgerEntry(entry, tx)
    },

    audit({ input, result }) {
      return {
        summary:
          `הסוכן שרין את היחידה ${input.unitId} ` +
          `לתאריכים ${input.checkIn} עד ${input.checkOut}.`,
        resourceId: result.holdId,
        after: { holdId: result.holdId, unitId: input.unitId },
      }
    },

    events({ result, input }) {
      return [
        {
          name: 'hold.created' as const,
          payload: { holdId: result.holdId, unitId: input.unitId },
        },
      ]
    },
  })

  // ── agentHold.extend ────────────────────────────────────────────────────

  const extendHoldOperation = defineOperation({
    name: 'agent_hold.extend',
    permission: 'hold.extend',
    resourceType: 'hold',
    input: s.object({ holdId: s.string({ label: 'החזקה' }) }),

    async rule({ input, context }) {
      const { actor } = context
      const settings = await requireSettings(actor)
      const ledger = await repo.loadHoldLedger(
        actor.organizationId,
        actor.userId,
      )
      const entry = ledger.find((row) => row.holdId === input.holdId)
      if (!entry) {
        throw new BusinessRuleError({
          code: 'agent_hold.unknown',
          message: `No ledger entry for hold ${input.holdId}`,
          userMessage: 'ההחזקה אינה קיימת או שאינה שלך.',
        })
      }
      assertAgentExtensionAllowed(
        entry,
        effectiveHoldLimits(settings.holdLimits, settings.reputationScore),
      )
    },

    async execute({ input, context, tx }) {
      const ledger = await repo.loadHoldLedger(
        context.actor.organizationId,
        context.actor.userId,
      )
      const entry = ledger.find((row) => row.holdId === input.holdId)
      if (!entry) {
        throw new BusinessRuleError({
          code: 'agent_hold.unknown',
          message: `No ledger entry for hold ${input.holdId}`,
          userMessage: 'ההחזקה אינה קיימת או שאינה שלך.',
        })
      }
      return repo.saveLedgerEntry(recordExtension(entry), tx)
    },

    audit({ result }) {
      return {
        summary: `ההחזקה הוארכה (הארכה מספר ${result.extensionCount}).`,
        resourceId: result.holdId,
        after: { extensionCount: result.extensionCount },
      }
    },

    events({ result }) {
      return [
        {
          name: 'hold.extended' as const,
          payload: { holdId: result.holdId },
        },
      ]
    },
  })

  // ── agentDiscount.apply ─────────────────────────────────────────────────

  /**
   * Apply a discount, or raise an approval.
   *
   * Two outcomes and neither is a refusal. Within the cap the discount stands;
   * over it an approval request is written and the owner decides. A refusal
   * here would send the negotiation to WhatsApp, where there is no record, no
   * real price in the system, and no argument anybody can settle later.
   */
  const applyDiscount = defineOperation({
    name: 'agent_discount.apply',
    permission: 'booking.amend_price',
    resourceType: 'booking',
    input: s.object({
      bookingId: s.string({ label: 'הזמנה' }),
      bookingReference: s.string({ max: 40, label: 'מספר הזמנה' }),
      currentTotalAgorot: s.agorot({ label: 'מחיר נוכחי' }),
      discountAgorot: s.agorot({ label: 'הנחה' }),
      commissionBaseAgorot: s.agorot({ label: 'בסיס העמלה' }),
      approvalId: s.string({ label: 'מזהה בקשה' }),
      reason: s.optional(s.string({ max: 500, label: 'סיבה' })),
    }),

    async execute({ input, context, now, tx }) {
      const { actor } = context
      const settings = await requireSettings(actor)

      const decision = evaluateAgentDiscount({
        approvalId: input.approvalId,
        organizationId: actor.organizationId,
        agentUserId: actor.userId,
        bookingId: input.bookingId,
        bookingReference: input.bookingReference,
        currentTotalAgorot: input.currentTotalAgorot,
        discountAgorot: input.discountAgorot,
        cap: settings.discountCap,
        commissionRule: { kind: 'none' },
        commissionBaseAgorot: input.commissionBaseAgorot,
        reason: input.reason ?? '',
        now,
      })

      if (decision.outcome === 'within_cap') return { decision, approval: null }

      const approval = await repo.insertApproval(decision.approval, tx)
      return { decision, approval }
    },

    audit({ input, result }) {
      if (result.decision.outcome === 'within_cap') {
        return {
          summary:
            `הסוכן נתן הנחה של ${shekels(result.decision.discountAgorot)} ` +
            `על הזמנה ${input.bookingReference}, בתוך התקרה שלו.`,
          resourceId: input.bookingId,
        }
      }
      return {
        summary: result.decision.approval.view.summary,
        resourceId: input.bookingId,
        after: { approvalId: result.decision.approval.id },
      }
    },

    events({ result }) {
      if (result.decision.outcome === 'within_cap') return []
      return [
        {
          name: 'approval.requested' as const,
          payload: {
            approvalId: result.decision.approval.id,
            type: 'discount',
          },
        },
      ]
    },
  })

  // ── discount.decide ─────────────────────────────────────────────────────

  const decideDiscount = defineOperation({
    name: 'agent_discount.decide',
    permission: 'approval.decide',
    resourceType: 'approval',
    input: s.object({
      approvalId: s.string({ label: 'בקשה' }),
      approved: s.boolean({ label: 'החלטה' }),
      note: s.optional(s.string({ max: 500, label: 'הערה' })),
    }),

    async loadResource({ input, context }) {
      const approval = await repo.loadApproval(
        context.actor.organizationId,
        input.approvalId,
      )
      if (!approval) return null
      return {
        resource: {
          organizationId: approval.organizationId,
          family: 'booking' as const,
          // The requester owns the request; the decider must not be them, which
          // `decideDiscountApproval` enforces and the database repeats.
          createdByUserId: approval.requestedByUserId,
        },
        entity: approval,
      }
    },

    async execute({ input, entity, context, now, tx }) {
      const decided = decideDiscountApproval(entity as DiscountApproval, {
        approved: input.approved,
        decidedByUserId: context.actor.userId,
        now,
        note: input.note ?? null,
      })
      return repo.saveApproval(decided, tx)
    },

    audit({ result }) {
      return {
        summary:
          result.status === 'approved'
            ? `בקשת ההנחה אושרה: ${result.view.summary}`
            : `בקשת ההנחה נדחתה: ${result.view.summary}`,
        resourceId: result.id,
        before: { status: 'requested' },
        after: { status: result.status },
      }
    },

    events({ result }) {
      return [
        {
          name: 'approval.decided' as const,
          payload: { approvalId: result.id, status: result.status },
        },
      ]
    },
  })

  // ── commission.transition ───────────────────────────────────────────────

  /**
   * Approve a commission.
   *
   * Held by whoever releases money, and deliberately not by whoever wrote the
   * rule — `commission.approve` is in `SENSITIVE_ACTIONS`, so a reason is
   * required, and the approver's id is recorded because the database refuses a
   * row claiming an approval nobody signed.
   */
  const approveCommission = defineOperation({
    name: 'commission.approve',
    permission: 'commission.approve',
    resourceType: 'commission',
    requiresVersion: true,
    input: s.object({ commissionId: s.string({ label: 'עמלה' }) }),

    async loadResource({ input, context }) {
      const commission = await repo.loadCommission(
        context.actor.organizationId,
        input.commissionId,
      )
      if (!commission) return null
      return {
        resource: {
          organizationId: commission.organizationId,
          propertyId: commission.propertyId,
          family: 'finance' as const,
          assignedToUserId: commission.agentUserId,
        },
        entity: commission,
        version: commission.version,
      }
    },

    async execute({ entity, context, now, tx }) {
      const commission = entity as Commission
      const approved = advanceCommission(commission, {
        to: 'approved',
        now,
        approvedByUserId: context.actor.userId,
      })
      return repo.saveCommission(approved, commission.version, tx)
    },

    audit({ entity, result }) {
      return {
        summary:
          `עמלת הסוכן על הזמנה ${result.bookingId} אושרה לתשלום: ` +
          `${shekels(result.amountAgorot)} ` +
          `(${COMMISSION_STATUS_LABEL[entity.status]} → ${COMMISSION_STATUS_LABEL[result.status]}).`,
        before: { status: entity.status },
        after: { status: result.status, amountAgorot: result.amountAgorot },
        resourceId: result.id,
        propertyId: result.propertyId,
      }
    },

    events({ result }) {
      return [
        {
          name: 'commission.approved' as const,
          propertyId: result.propertyId,
          payload: {
            commissionId: result.id,
            agentUserId: result.agentUserId,
            amountAgorot: result.amountAgorot,
          },
        },
      ]
    },
  })

  // ── Shared ──────────────────────────────────────────────────────────────

  /**
   * This agent's settings, or a refusal.
   *
   * A missing row is not treated as "no limits". An agent whose settings cannot
   * be read is an agent nothing can vouch for, and the safe reading of that is
   * to stop rather than to fall back to a permissive default.
   */
  async function requireSettings(
    actor: Actor,
  ): Promise<AgentOrganizationSettings> {
    const settings = await repo.loadSettings(actor.organizationId, actor.userId)
    if (!settings) {
      throw new BusinessRuleError({
        code: 'agent.not_configured',
        message: `No agent settings for ${actor.userId} in ${actor.organizationId}`,
        userMessage:
          'הגדרות הסוכן שלך אינן זמינות. פנה לבעל העסק כדי להשלים את ההרשמה.',
      })
    }
    return settings
  }

  return {
    invite,
    updateAccess,
    setStatus,
    createHold,
    extendHold: extendHoldOperation,
    applyDiscount,
    decideDiscount,
    approveCommission,
  }
}

export type AgentOperations = ReturnType<typeof defineAgentOperations>
