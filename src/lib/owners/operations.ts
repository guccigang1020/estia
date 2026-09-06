/**
 * The owner portal's operations.
 *
 * Five things a person can do that create an outside party's claim on money,
 * each declared with `defineOperation` so none of them can reach a write
 * without having passed authorization, validation, the version check, the
 * two-phase idempotency key and the audit trail. There is no second path to an
 * `owner_statements` row.
 *
 * ── An issued statement is frozen ─────────────────────────────────────────
 *
 * The same argument `invoice.issue` makes, and it is stronger here rather than
 * weaker. An invoice is a document the business sends a guest; a statement is
 * the document an **outside party with their own accountant** is paid on. If it
 * can be edited after it was sent, then "your March statement said ₪18,420" is
 * a claim neither side can substantiate, and the disagreement is settled by
 * whoever kept a PDF.
 *
 * So there is no update operation, and — see `repository.ts` — no `update`
 * method on the port for one to call. Correcting a statement is issuing a new
 * one for the same period, which the second-issue rule permits *only* once the
 * screen has said out loud that this is a correction: the rule below refuses a
 * duplicate that does not declare itself.
 *
 * ── Where the money figures come from ─────────────────────────────────────
 *
 * `OwnerFinanceSource` is a port with one method, and its whole purpose is that
 * this file cannot compute revenue. The operation asks finance for the
 * property's P&L for the period and hands it to `buildOwnerStatement`. There is
 * no parameter through which price lines, bookings or expense rules could
 * arrive, so "an owner statement reconciles to the finance module's own
 * numbers" is guaranteed by the shape of the code rather than by review.
 *
 * ── Two grants that are not quite right, stated rather than worked around ─
 *
 * `owner_payout.record` asserts `owner_statement.issue`. Releasing money to an
 * owner is not the same act as issuing the document, and it deserves its own
 * grant — but `owner.manage` is owner-and-administrator only, so asserting that
 * would put every payout beyond the finance manager whose job it is. The
 * module's report asks for `owner.payout`, gated on `owner_portal` and listed
 * in `SENSITIVE_ACTIONS`; until it exists this is the honest approximation, and
 * `requiresReason` is set explicitly so a payout still cannot be made on the
 * strength of a permission alone.
 *
 * `owner_approval.decide` asserts `approval.decide`, which the `property_owner`
 * role does not hold and must not be given — it would let an owner decide an
 * agent's discount. Today a manager records the owner's answer. See
 * `approvals.ts`.
 */

import { assertCan, type Resource } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'
import { defineOperation, s } from '../service'
import type { PropertyPnl } from '../finance/pnl'
import { decideOwnerApproval, type OwnerApproval } from './approvals'
import type { OwnerRepository } from './repository'
import { buildOwnerStatement, issueOwnerStatement } from './statement'
import {
  FULL_SHARE_BPS,
  OWNER_PAYOUT_DIRECTIONS,
  OWNER_PAYOUT_METHODS,
  OWNER_STATUSES,
  type OwnerPayout,
  type OwnerStatement,
  type PropertyOwner,
  type PropertyOwnership,
} from './types'

/**
 * The one seam through which money enters this module.
 *
 * Injected rather than imported so the domain tests can state a P&L directly
 * and so this file cannot grow a second way to compute one. The implementation
 * is `finance/pnl.ts` composed over the finance repository; see the module
 * report for the wiring the screens use.
 */
export interface OwnerFinanceSource {
  propertyPnl(args: {
    organizationId: string
    propertyId: string
    /** Property-local ISO dates, inclusive. */
    periodStart: string
    periodEnd: string
  }): Promise<PropertyPnl>
}

function ownerResource(
  organizationId: string,
  propertyId: string | null,
): Resource {
  return propertyId === null
    ? { organizationId, family: 'finance' }
    : { organizationId, propertyId, family: 'finance' }
}

export function defineOwnerOperations(
  repo: OwnerRepository,
  finance: OwnerFinanceSource,
) {
  // ── owner.create ────────────────────────────────────────────────────────

  /**
   * Record an outside owner.
   *
   * `userId` is optional and usually absent. Most owners of a managed villa are
   * paid by bank transfer and never open a screen, and requiring an account
   * before the business can record who it owes money to would make the register
   * describe ESTIA's users rather than the business's obligations.
   */
  const createOwner = defineOperation({
    name: 'owner.create',
    permission: 'owner.manage',
    resourceType: 'property_owner',
    input: s.object({
      ownerId: s.uuid({ label: 'מזהה בעלים' }),
      displayName: s.string({ min: 2, max: 200, label: 'שם הבעלים' }),
      userId: s.optional(s.nullable(s.uuid())),
      email: s.optional(s.nullable(s.string({ max: 200 }))),
      phone: s.optional(s.nullable(s.string({ max: 40 }))),
      status: s.optional(s.enumOf(OWNER_STATUSES, { label: 'סטטוס' })),
      notes: s.optional(s.nullable(s.string({ max: 2000 }))),
    }),

    async rule({ context }) {
      // Nothing to load, so the pipeline's second check has no resource. Asked
      // by hand against the organization rather than skipped.
      assertCan(
        context.actor,
        'owner.manage',
        ownerResource(context.actor.organizationId, null),
      )
    },

    async execute({ input, context, now, tx }): Promise<PropertyOwner> {
      return repo.insertOwner(
        {
          id: input.ownerId,
          organizationId: context.actor.organizationId,
          displayName: input.displayName,
          userId: input.userId ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          status: input.status ?? 'active',
          notes: input.notes ?? null,
          createdAt: now.toISOString(),
          version: 1,
        },
        tx,
      )
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        summary: `${context.auditActor.label} הוסיף את ${result.displayName} כבעלים חיצוני.`,
        after: { displayName: result.displayName, status: result.status },
      }
    },
  })

  // ── owner.link_property ─────────────────────────────────────────────────

  /**
   * Give an owner a share of a property.
   *
   * The share is basis points and the operation refuses a link that would take
   * the property's live shares past 100%. That check is here rather than only
   * in the statement builder because the failure is much cheaper to explain at
   * the moment somebody types 60% into a villa that is already fully owned than
   * three weeks later when the statement will not build.
   */
  const linkProperty = defineOperation({
    name: 'owner.link_property',
    permission: 'owner.manage',
    resourceType: 'property_ownership',
    input: s.object({
      ownershipId: s.uuid({ label: 'מזהה בעלות' }),
      ownerId: s.uuid({ label: 'בעלים' }),
      propertyId: s.uuid({ label: 'נכס' }),
      shareBps: s.number({
        integer: true,
        min: 1,
        max: FULL_SHARE_BPS,
        label: 'חלק בבעלות',
      }),
      effectiveFrom: s.string({ min: 10, max: 10, label: 'בתוקף מתאריך' }),
      effectiveTo: s.optional(s.nullable(s.string({ min: 10, max: 10 }))),
    }),

    async loadResource({ input, context }) {
      const owner = await repo.loadOwner(
        context.actor.organizationId,
        input.ownerId,
      )
      if (!owner) return null
      return {
        resource: ownerResource(owner.organizationId, input.propertyId),
        entity: owner,
      }
    },

    async rule({ input, context }) {
      const existing = await repo.listOwnerships(context.actor.organizationId, {
        propertyId: input.propertyId,
      })

      const live = existing.filter(
        (ownership) => ownership.effectiveTo === null,
      )
      const held = live.reduce((sum, ownership) => sum + ownership.shareBps, 0)

      if (held + input.shareBps > FULL_SHARE_BPS) {
        throw new BusinessRuleError({
          code: 'owner_share_exceeds_property',
          userMessage:
            'החלק המבוקש חורג מ-100% בעלות בנכס. יש לעדכן את החלקים הקיימים לפני הוספת בעלים נוסף.',
          message:
            `Property ${input.propertyId} already holds ${held} bps and the ` +
            `request adds ${input.shareBps}`,
          publicDetails: { heldBps: held, requestedBps: input.shareBps },
        })
      }
    },

    async execute({ input, context, now, tx }): Promise<PropertyOwnership> {
      return repo.insertOwnership(
        {
          id: input.ownershipId,
          organizationId: context.actor.organizationId,
          ownerId: input.ownerId,
          propertyId: input.propertyId,
          shareBps: input.shareBps,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          createdAt: now.toISOString(),
          version: 1,
        },
        tx,
      )
    },

    audit({ result, entity, context }) {
      const percent = (result.shareBps / 100).toLocaleString('he-IL')
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} קישר את ${entity.displayName} לנכס ` +
          `בחלק של ${percent}% החל מ-${result.effectiveFrom}.`,
        after: { shareBps: result.shareBps, propertyId: result.propertyId },
      }
    },
  })

  // ── owner_statement.issue ───────────────────────────────────────────────

  /**
   * Produce the period document.
   *
   * Everything numeric comes from `finance.propertyPnl` and from rows already
   * written — the previous statement's closing balance, the payouts recorded in
   * the period. Nothing is computed twice and nothing is computed here.
   *
   * The result is issued in the same act as it is built. A draft that could sit
   * in the table and be re-derived later would be a second version of the same
   * period with no way to tell which one the owner was shown.
   */
  const issueStatement = defineOperation({
    name: 'owner_statement.issue',
    permission: 'owner_statement.issue',
    resourceType: 'owner_statement',
    input: s.object({
      statementId: s.uuid({ label: 'מזהה דוח' }),
      ownerId: s.uuid({ label: 'בעלים' }),
      propertyId: s.uuid({ label: 'נכס' }),
      periodStart: s.string({ min: 10, max: 10, label: 'תחילת התקופה' }),
      periodEnd: s.string({ min: 10, max: 10, label: 'סוף התקופה' }),
      /**
       * Set when this replaces a statement already issued for the period.
       *
       * A correction is legitimate and a duplicate is a mistake, and the two
       * arrive as identical requests. Making the caller say which is what turns
       * "an issued statement never changes" into a rule with a door rather than
       * a wall people climb over by deleting rows.
       */
      correction: s.optional(s.boolean({ label: 'תיקון לדוח קיים' })),
    }),

    async loadResource({ input, context }) {
      const owner = await repo.loadOwner(
        context.actor.organizationId,
        input.ownerId,
      )
      if (!owner) return null
      return {
        resource: ownerResource(owner.organizationId, input.propertyId),
        entity: owner,
      }
    },

    async rule({ input, context }) {
      if (input.periodEnd < input.periodStart) {
        throw new BusinessRuleError({
          code: 'owner_statement_period_inverted',
          userMessage: 'תאריך הסיום של התקופה מוקדם מתאריך ההתחלה.',
          message: `Period ${input.periodStart}..${input.periodEnd} is inverted`,
        })
      }

      if (input.correction === true) return

      const existing = await repo.listStatements(context.actor.organizationId, {
        ownerId: input.ownerId,
        propertyId: input.propertyId,
      })

      const clash = existing.find(
        (statement) =>
          statement.status === 'issued' &&
          statement.periodStart === input.periodStart &&
          statement.periodEnd === input.periodEnd,
      )

      if (clash) {
        throw new BusinessRuleError({
          code: 'owner_statement_already_issued_for_period',
          userMessage:
            'כבר הופק דוח לבעלים הזה לתקופה הזו. דוח שהופק אינו ניתן לשינוי — אם צריך לתקן, יש להפיק דוח מתקן.',
          message:
            `Owner ${input.ownerId} already holds issued statement ` +
            `${clash.id} for ${input.periodStart}..${input.periodEnd}`,
          publicDetails: { existingStatementId: clash.id },
        })
      }
    },

    async execute({ input, context, now, tx }): Promise<OwnerStatement> {
      const organizationId = context.actor.organizationId

      const [pnl, ownerships, payouts, previous] = await Promise.all([
        finance.propertyPnl({
          organizationId,
          propertyId: input.propertyId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        }),
        repo.listOwnerships(organizationId, {
          propertyId: input.propertyId,
        }),
        repo.listPayouts(organizationId, {
          ownerId: input.ownerId,
          propertyId: input.propertyId,
        }),
        repo.listStatements(organizationId, {
          ownerId: input.ownerId,
          propertyId: input.propertyId,
        }),
      ])

      // The closing balance of the newest statement that ended before this
      // period began. Read rather than recomputed: the opening balance of March
      // is what February's document said, whatever has happened since.
      const opening = previous
        .filter(
          (statement) =>
            statement.status === 'issued' &&
            statement.periodEnd < input.periodStart,
        )
        .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0]

      const inPeriod = payouts.filter(
        (payout) =>
          payout.paidOn >= input.periodStart &&
          payout.paidOn <= input.periodEnd,
      )

      const draft = buildOwnerStatement({
        id: input.statementId,
        organizationId,
        ownerId: input.ownerId,
        propertyId: input.propertyId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        pnl,
        ownerships: ownerships.filter(
          (ownership) => ownership.effectiveFrom <= input.periodEnd,
        ),
        openingBalanceAgorot: opening?.closingBalanceAgorot ?? 0,
        payouts: inPeriod,
      })

      return repo.insertStatement(
        issueOwnerStatement(draft, context.actor.userId, now),
        tx,
      )
    },

    audit({ result, entity, context }) {
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} הפיק דוח בעלים ל${entity.displayName} ` +
          `לתקופה ${result.periodStart}–${result.periodEnd} על סך ` +
          `${formatAgorot(result.ownerShareAgorot)}.`,
        after: {
          periodStart: result.periodStart,
          periodEnd: result.periodEnd,
          ownerShareAgorot: result.ownerShareAgorot,
          closingBalanceAgorot: result.closingBalanceAgorot,
        },
      }
    },

    events({ result }) {
      return [
        {
          name: 'owner_statement.issued' as const,
          propertyId: result.propertyId,
          payload: {
            statementId: result.id,
            ownerId: result.ownerId,
            propertyId: result.propertyId,
            periodStart: result.periodStart,
            periodEnd: result.periodEnd,
            ownerShareAgorot: result.ownerShareAgorot,
            closingBalanceAgorot: result.closingBalanceAgorot,
          },
        },
      ]
    },
  })

  // ── owner_payout.record ─────────────────────────────────────────────────

  /**
   * Write down that money moved between the business and an owner.
   *
   * ESTIA does not move it. The transfer happens in the business's bank and
   * this records that it happened, which is why there is no provider, no
   * account number and no capture step — and why `reference` is free text the
   * bookkeeper recognises rather than a payment instrument.
   *
   * `requiresReason` is set rather than inherited. `owner_statement.issue` is
   * not in `SENSITIVE_ACTIONS`, so the pipeline would not have demanded a
   * justification — and money leaving the business to a third party is exactly
   * the class of act that must not happen on the strength of a permission
   * alone.
   */
  const recordPayout = defineOperation({
    name: 'owner_payout.record',
    permission: 'owner_statement.issue',
    resourceType: 'owner_payout',
    requiresReason: true,
    input: s.object({
      payoutId: s.uuid({ label: 'מזהה תשלום' }),
      ownerId: s.uuid({ label: 'בעלים' }),
      propertyId: s.optional(s.nullable(s.uuid())),
      statementId: s.optional(s.nullable(s.uuid())),
      direction: s.enumOf(OWNER_PAYOUT_DIRECTIONS, { label: 'כיוון התנועה' }),
      amountAgorot: s.agorot({ label: 'סכום' }),
      method: s.enumOf(OWNER_PAYOUT_METHODS, { label: 'אמצעי' }),
      paidOn: s.string({ min: 10, max: 10, label: 'תאריך' }),
      reference: s.optional(s.nullable(s.string({ max: 120 }))),
      note: s.optional(s.nullable(s.string({ max: 1000 }))),
    }),

    async loadResource({ input, context }) {
      const owner = await repo.loadOwner(
        context.actor.organizationId,
        input.ownerId,
      )
      if (!owner) return null
      return {
        resource: ownerResource(owner.organizationId, input.propertyId ?? null),
        entity: owner,
      }
    },

    async rule({ input }) {
      if (input.amountAgorot <= 0) {
        throw new BusinessRuleError({
          code: 'owner_payout_not_positive',
          userMessage:
            'סכום התנועה חייב להיות גדול מאפס. כיוון התנועה נקבע בשדה נפרד ולא בסימן הסכום.',
          message: `A payout of ${input.amountAgorot} agorot was attempted`,
        })
      }
    },

    async execute({ input, context, now, tx }): Promise<OwnerPayout> {
      return repo.insertPayout(
        {
          id: input.payoutId,
          organizationId: context.actor.organizationId,
          ownerId: input.ownerId,
          propertyId: input.propertyId ?? null,
          statementId: input.statementId ?? null,
          direction: input.direction,
          amountAgorot: input.amountAgorot,
          method: input.method,
          paidOn: input.paidOn,
          reference: input.reference ?? null,
          note: input.note ?? null,
          recordedBy: context.actor.userId,
          createdAt: now.toISOString(),
        },
        tx,
      )
    },

    audit({ result, entity, context }) {
      const verb =
        result.direction === 'to_owner' ? 'רשם תשלום של' : 'רשם תקבול של'
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary:
          `${context.auditActor.label} ${verb} ` +
          `${formatAgorot(result.amountAgorot)} מול ${entity.displayName} ` +
          `בתאריך ${result.paidOn}.`,
        after: {
          direction: result.direction,
          amountAgorot: result.amountAgorot,
          method: result.method,
        },
      }
    },

    events({ result }) {
      // `owner_payout.paid` is the catalogue's name and it covers both
      // directions. A `owner_payout.received` does not exist and this module
      // may not add one — the gap is named in the report rather than papered
      // over with an invented event nothing subscribes to.
      return [
        {
          name: 'owner_payout.paid' as const,
          propertyId: result.propertyId,
          payload: {
            payoutId: result.id,
            ownerId: result.ownerId,
            direction: result.direction,
            amountAgorot: result.amountAgorot,
            statementId: result.statementId,
          },
        },
      ]
    },
  })

  // ── owner_approval.decide ───────────────────────────────────────────────

  /**
   * Record the owner's answer on a request that needed it.
   *
   * The transition, the self-approval refusal and the expiry check are
   * `approvals.ts`'s, so the rule that a requester cannot approve their own
   * request is stated once in the domain, held again by the database's CHECK,
   * and merely invoked here.
   */
  const decideApproval = defineOperation({
    name: 'owner_approval.decide',
    permission: 'approval.decide',
    resourceType: 'approval',
    requiresVersion: true,
    input: s.object({
      decision: s.enumOf(['approved', 'rejected'] as const, {
        label: 'החלטה',
      }),
      note: s.optional(s.nullable(s.string({ max: 1000 }))),
    }),

    async loadResource({ request, context }) {
      const approval = await repo.loadOwnerApproval(
        context.actor.organizationId,
        request.resourceId ?? '',
      )
      if (!approval) return null
      return {
        resource: ownerResource(approval.organizationId, approval.propertyId),
        entity: approval,
        version: approval.version,
      }
    },

    async execute({ input, entity, now, context, tx }): Promise<OwnerApproval> {
      const decided = decideOwnerApproval(entity, {
        decision: input.decision,
        decidedBy: context.actor.userId,
        note: input.note ?? null,
        now,
      })
      return repo.saveOwnerApproval(decided, entity.version, tx)
    },

    audit({ result, entity, context }) {
      const verdict = result.status === 'approved' ? 'אישר' : 'דחה'
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        summary: `${context.auditActor.label} ${verdict} בקשת בעלים: ${entity.reason}`,
        before: { status: entity.status },
        after: { status: result.status, decisionNote: result.decisionNote },
      }
    },

    events({ result }) {
      return [
        {
          name: 'approval.decided' as const,
          propertyId: result.propertyId,
          payload: {
            approvalId: result.id,
            approvalType: 'owner_request',
            ownerApprovalKind: result.kind,
            status: result.status,
            ownerId: result.ownerId,
          },
        },
      ]
    },
  })

  return {
    createOwner,
    linkProperty,
    issueStatement,
    recordPayout,
    decideApproval,
  }
}

export type OwnerOperations = ReturnType<typeof defineOwnerOperations>
