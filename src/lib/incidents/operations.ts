/**
 * EXECUTION CONTEXT — SERVER ONLY. The five things a person may do to a case.
 *
 * Open one. Attach evidence. Move it along. Decide who pays. Close it.
 *
 * Every one of them is a `defineOperation`, which means every one of them
 * runs authorize → validate → business rule → transaction → audit event →
 * domain event in that order and cannot skip a step, because the caller never
 * gets to write the sequence. A `db.from('incident_cases').insert(...)` in a
 * server action would look identical on screen and would skip all six.
 *
 * ── What each operation emits ─────────────────────────────────────────────
 *
 *   · opening a case emits `incident.opened`, which is also in `ALERT_EVENTS`;
 *   · attaching evidence emits `incident.evidence_added`;
 *   · reaching `awaiting_approval` emits `approval.requested`;
 *   · reaching `resolved` emits `incident.resolved`;
 *   · recording a liability decision emits `approval.decided`, which is what
 *     it is: a named person deciding a thing that was awaiting decision;
 *   · closing a case emits `incident.closed`.
 *
 * The last two names did not exist when this module was written, and it
 * refused to borrow `incident.opened` or re-emit `incident.resolved` in their
 * place — either would have put a false sentence in the event log and woken
 * every subscriber that keys off it. They were requested and added to the
 * frozen catalogue instead, so the refusal cost two release cycles of silence
 * rather than a permanent wrong answer.
 *
 * `incident.evidence_added` is routed as `info` and does not escalate: a
 * damage case collects photos over days, and a manager paged for each one
 * stops reading the ones that matter. `incident.closed` is deliberately
 * distinct from `incident.resolved` — resolved means the damage is dealt
 * with, closed means the file is shut, and a deposit dispute months later
 * turns on which of the two happened when.
 *
 * ── Why the liability operation is the strict one ─────────────────────────
 *
 * `requiresReason: true` on `incident_case.decide_liability`, set explicitly
 * rather than inherited from `SENSITIVE_ACTIONS`. The stated reason IS the
 * decision's rationale — it is passed straight into `evaluateLiability` and
 * stored on the decision row — so a decision cannot be recorded by somebody
 * who could not be bothered to say why. And `context.auditActor.type` is
 * handed to the domain, which refuses anything that is not a person. See
 * `liability.ts`.
 */

import type { Resource } from '../authz/can'
import type { DomainEventName } from '../contracts/events'
import { BusinessRuleError, ValidationError } from '../errors'
import type { Db } from '../persistence/client'
import { defineOperation, s, type Operation } from '../service'

import {
  EVIDENCE_KINDS,
  EVIDENCE_PROBLEM_MESSAGE,
  EVIDENCE_SOURCES,
  checkEvidence,
  type CaseEvidence,
} from './evidence'
import {
  LIABILITY_BASES,
  LIABILITY_OUTCOMES,
  LIABILITY_PROBLEM_MESSAGE,
  assessedTotal,
  evaluateLiability,
  sumLines,
  type LiabilityDecision,
} from './liability'
import {
  SupabaseIncidentRepository,
  type CaseFile,
  type IncidentRepository,
} from './repository'
import {
  INCIDENT_CASE_STATUSES,
  INCIDENT_CASE_TYPES,
  INCIDENT_ORIGINS,
  type IncidentCase,
  type IncidentCaseStatus,
} from './types'
import { checkTransition, type CaseFacts } from './workflow'

/* --------------------------------------------------------------- wiring -- */

/**
 * How an operation in this module reaches the database.
 *
 * `db` is the request-scoped client, so every write runs as the signed-in
 * person under row level security — the floor beneath `assertCan`, which
 * refuses regardless of what happens above it. `cases` is here for a caller
 * that already holds a port; the tests pass a double and nothing else does.
 */
export interface IncidentOperationOptions {
  db: Db
  cases?: IncidentRepository
}

function repositoryFor(options: IncidentOperationOptions): IncidentRepository {
  return options.cases ?? new SupabaseIncidentRepository(options.db)
}

/**
 * An event draft, narrowed to the frozen catalogue.
 *
 * The pipeline's own draft type accepts any `something.something` string,
 * which is right for a generic pipeline and wrong here: an event name this
 * module invents is an event nothing subscribes to, and the failure is silent.
 */
interface CaseEventDraft {
  name: DomainEventName
  propertyId?: string | null
  payload: unknown
}

/** What the second `assertCan` reads: the tenant, and where the case sits. */
function resourceFor(incident: IncidentCase): Resource {
  return {
    organizationId: incident.organizationId,
    propertyId: incident.propertyId,
    ...(incident.unitId === null ? {} : { unitId: incident.unitId }),
    family: 'operations',
  }
}

/** The four numbers the workflow reads, derived from the file. */
function factsFor(file: CaseFile): CaseFacts {
  return {
    status: file.incident.status,
    questions: file.questions,
    hasLiabilityDecision: file.decisions.length > 0,
    recordedCostAgorot: sumLines(file.costLines),
  }
}

function refuseTransition(facts: CaseFacts, to: IncidentCaseStatus): void {
  const check = checkTransition(facts, to)
  if (check.ok) return

  throw new BusinessRuleError({
    code: `incident_case_${check.refusal}`,
    message: `Case in ${facts.status} may not move to ${to}: ${check.refusal}`,
    userMessage: check.message,
  })
}

/* ---------------------------------------------------------- opening one -- */

const OPEN_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  unitId: s.nullable(s.uuid({ label: 'יחידה' })),
  bookingId: s.nullable(s.uuid({ label: 'הזמנה' })),
  taskId: s.nullable(s.uuid({ label: 'דיווח תקלה' })),
  caseType: s.enumOf(INCIDENT_CASE_TYPES, { label: 'סוג' }),
  origin: s.enumOf(INCIDENT_ORIGINS, { label: 'מקור' }),
  title: s.string({ label: 'כותרת', min: 2, max: 200, trim: true }),
  description: s.nullable(s.string({ label: 'תיאור', max: 4000, trim: true })),
  occurredAt: s.nullable(s.isoDateTime({ label: 'מועד האירוע' })),
})

export type OpenCaseInput = {
  propertyId: string
  unitId: string | null
  bookingId: string | null
  taskId: string | null
  caseType: (typeof INCIDENT_CASE_TYPES)[number]
  origin: (typeof INCIDENT_ORIGINS)[number]
  title: string
  description: string | null
  occurredAt: Date | null
}

export type OpenCaseOperation = Operation<OpenCaseInput, null, IncidentCase>

/**
 * Open a damage case.
 *
 * `incident.create` and not `incident.update`, deliberately. The person who
 * finds the damage is usually the cleaner, and she holds `incident.create` and
 * nothing else — the whole asymmetry `incidents/_lib/guard.ts` is built around.
 * She can open the case; she cannot read the register of them, cannot price it
 * and cannot decide it.
 */
export function defineOpenCase(
  options: IncidentOperationOptions,
): OpenCaseOperation {
  const cases = repositoryFor(options)

  return defineOperation<OpenCaseInput, null, IncidentCase>({
    name: 'incident_case.open',
    permission: 'incident.create',
    resourceType: 'incident_case',
    input: OPEN_INPUT,

    rule({ input, now }) {
      // Damage that happened after it was reported is a typo or a clock
      // problem, and either way the date is the field the person has to fix.
      if (
        input.occurredAt !== null &&
        input.occurredAt.getTime() > now.getTime()
      ) {
        throw new ValidationError([
          {
            field: 'occurredAt',
            code: 'future_date',
            message: 'מועד האירוע אינו יכול להיות בעתיד.',
            label: 'מועד האירוע',
          },
        ])
      }
    },

    async execute({ input, context, now, tx }) {
      return cases.insertCase(
        {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
          unitId: input.unitId,
          bookingId: input.bookingId,
          taskId: input.taskId,
          caseType: input.caseType,
          origin: input.origin,
          title: input.title,
          description: input.description,
          occurredAt: input.occurredAt,
          openedByUserId: context.actor.userId,
        },
        now,
        tx,
      )
    },

    audit({ input, result }) {
      return {
        summary: `נפתח תיק נזק: ${input.title}`,
        resourceId: result.id,
        propertyId: result.propertyId,
        after: {
          caseType: result.caseType,
          origin: result.origin,
          bookingId: result.bookingId,
          taskId: result.taskId,
        },
      }
    },

    /**
     * `incident.opened` is in `ALERT_EVENTS` — the list of things a person is
     * meant to be told about rather than merely logged. A damage case that
     * reaches nobody until somebody opens a screen is a deposit released by
     * default.
     */
    events({ result }): readonly CaseEventDraft[] {
      return [
        {
          name: 'incident.opened',
          propertyId: result.propertyId,
          payload: {
            caseId: result.id,
            caseType: result.caseType,
            origin: result.origin,
            bookingId: result.bookingId,
            unitId: result.unitId,
            title: result.title,
          },
        },
      ]
    },
  })
}

/* -------------------------------------------------------- adding evidence -- */

const EVIDENCE_INPUT = s.object({
  caseId: s.uuid({ label: 'תיק' }),
  kind: s.enumOf(EVIDENCE_KINDS, { label: 'סוג ראיה' }),
  mediaRef: s.nullable(
    s.string({ label: 'הפניה לקובץ', max: 500, trim: true }),
  ),
  contentType: s.nullable(
    s.string({ label: 'סוג קובץ', max: 120, trim: true }),
  ),
  byteSize: s.nullable(s.number({ label: 'גודל', integer: true, min: 0 })),
  statement: s.nullable(s.string({ label: 'הצהרה', max: 4000, trim: true })),
  capturedAt: s.nullable(s.isoDateTime({ label: 'מועד הצילום' })),
  source: s.enumOf(EVIDENCE_SOURCES, { label: 'מקור' }),
  note: s.nullable(s.string({ label: 'הערה', max: 500, trim: true })),
})

export type AddEvidenceInput = {
  caseId: string
  kind: (typeof EVIDENCE_KINDS)[number]
  mediaRef: string | null
  contentType: string | null
  byteSize: number | null
  statement: string | null
  capturedAt: Date | null
  source: (typeof EVIDENCE_SOURCES)[number]
  note: string | null
}

export type AddEvidenceOperation = Operation<
  AddEvidenceInput,
  CaseFile,
  CaseEvidence
>

/**
 * Attach a reference to a file, or somebody's words. Never the file.
 *
 * The domain check runs as the business rule rather than in the schema,
 * because "this is a data URI and not a storage key" is a fact about the value
 * and not about its shape — the same argument `tasks/operations.ts` makes for
 * checking `dueOn` outside the schema.
 */
export function defineAddEvidence(
  options: IncidentOperationOptions,
): AddEvidenceOperation {
  const cases = repositoryFor(options)

  return defineOperation<AddEvidenceInput, CaseFile, CaseEvidence>({
    name: 'incident_case.add_evidence',
    permission: 'incident.update',
    resourceType: 'incident_case',
    input: EVIDENCE_INPUT,

    async loadResource({ input, context }) {
      const file = await cases.loadCase(
        context.actor.organizationId,
        input.caseId,
      )
      if (!file) return null
      return {
        resource: resourceFor(file.incident),
        entity: file,
        version: file.incident.version,
      }
    },

    rule({ input, entity, context }) {
      if (entity.incident.status === 'closed') {
        throw new BusinessRuleError({
          code: 'incident_case_closed',
          message: `Case ${entity.incident.id} is closed`,
          userMessage:
            'התיק סגור. כדי לצרף ראיה חדשה יש לפתוח תיק חדש שמפנה אליו.',
        })
      }

      const check = checkEvidence({
        organizationId: context.actor.organizationId,
        caseId: input.caseId,
        kind: input.kind,
        mediaRef: input.mediaRef,
        contentType: input.contentType,
        byteSize: input.byteSize,
        statement: input.statement,
        capturedAt: input.capturedAt,
        source: input.source,
        recordedByUserId: context.actor.userId,
        note: input.note,
      })

      if (!check.ok) {
        throw new ValidationError(
          check.problems.map((problem) => ({
            field:
              problem === 'statement_kind_without_text'
                ? 'statement'
                : 'mediaRef',
            code: problem,
            message: EVIDENCE_PROBLEM_MESSAGE[problem],
            label: 'ראיה',
          })),
        )
      }
    },

    async execute({ input, context, now, tx }) {
      return cases.insertEvidence(
        {
          organizationId: context.actor.organizationId,
          caseId: input.caseId,
          kind: input.kind,
          mediaRef: input.mediaRef,
          contentType: input.contentType,
          byteSize: input.byteSize,
          statement: input.statement,
          capturedAt: input.capturedAt,
          source: input.source,
          recordedByUserId: context.actor.userId,
          note: input.note,
        },
        now,
        tx,
      )
    },

    audit({ entity, result }) {
      return {
        summary: `צורפה ראיה לתיק ״${entity.incident.title}״: ${result.kind}`,
        resourceId: entity.incident.id,
        propertyId: entity.incident.propertyId,
        after: {
          evidenceId: result.id,
          kind: result.kind,
          source: result.source,
          // The reference, never the content. There is no content here to
          // record — see `evidence.ts`.
          mediaRef: result.mediaRef,
        },
      }
    },

    events({ entity, result }): readonly CaseEventDraft[] {
      return [
        {
          name: 'incident.evidence_added',
          propertyId: entity.incident.propertyId,
          payload: {
            caseId: entity.incident.id,
            evidenceId: result.id,
            kind: result.kind,
            source: result.source,
            // The reference, never the content — as in the audit record
            // above and for the same reason.
            mediaRef: result.mediaRef,
          },
        },
      ]
    },
  })
}

/* ------------------------------------------------------------ advancing -- */

const ADVANCE_INPUT = s.object({
  caseId: s.uuid({ label: 'תיק' }),
  status: s.enumOf(INCIDENT_CASE_STATUSES, { label: 'מצב' }),
})

export type AdvanceCaseInput = {
  caseId: string
  status: IncidentCaseStatus
}

export type AdvanceCaseOperation = Operation<
  AdvanceCaseInput,
  CaseFile,
  IncidentCase
>

/**
 * Move a case along the workflow.
 *
 * The rule is `checkTransition` and nothing else: one state machine, read by
 * the screen to decide which buttons exist and by this operation to decide
 * whether one may run. A crafted POST asking a case awaiting a vendor to
 * resolve itself is refused here with the same sentence the screen would have
 * shown beside the disabled control.
 *
 * Closing is deliberately not reachable through this operation — see
 * `defineCloseCase` — because closing is the act with the money on it.
 */
export function defineAdvanceCase(
  options: IncidentOperationOptions,
): AdvanceCaseOperation {
  const cases = repositoryFor(options)

  return defineOperation<AdvanceCaseInput, CaseFile, IncidentCase>({
    name: 'incident_case.advance',
    permission: 'incident.update',
    resourceType: 'incident_case',
    input: ADVANCE_INPUT,

    async loadResource({ input, context }) {
      const file = await cases.loadCase(
        context.actor.organizationId,
        input.caseId,
      )
      if (!file) return null
      return {
        resource: resourceFor(file.incident),
        entity: file,
        version: file.incident.version,
      }
    },

    rule({ input, entity }) {
      if (input.status === 'closed') {
        throw new BusinessRuleError({
          code: 'incident_case_close_needs_resolution',
          message: 'Closing goes through incident_case.close',
          userMessage: 'סגירת תיק היא פעולה נפרדת, והיא דורשת הרשאת הכרעה.',
        })
      }
      refuseTransition(factsFor(entity), input.status)
    },

    async execute({ input, context, now, tx }) {
      return cases.setStatus(
        context.actor.organizationId,
        input.caseId,
        input.status,
        context.actor.userId,
        now,
        tx,
      )
    },

    audit({ entity, result }) {
      return {
        summary:
          `תיק ״${entity.incident.title}״ עבר מ״${entity.incident.status}״ ` +
          `ל״${result.status}״`,
        resourceId: result.id,
        propertyId: result.propertyId,
        before: { status: entity.incident.status },
        after: { status: result.status },
      }
    },

    /**
     * Two of the six targets have a name in the frozen catalogue and the rest
     * do not. Emitting nothing for `investigating` is correct rather than
     * incomplete: nobody outside the case is waiting to hear that somebody
     * started looking at it.
     */
    events({ result }): readonly CaseEventDraft[] {
      if (result.status === 'awaiting_approval') {
        return [
          {
            name: 'approval.requested',
            propertyId: result.propertyId,
            payload: {
              caseId: result.id,
              subject: 'incident_case',
              title: result.title,
            },
          },
        ]
      }

      if (result.status === 'resolved') {
        return [
          {
            name: 'incident.resolved',
            propertyId: result.propertyId,
            payload: {
              caseId: result.id,
              caseType: result.caseType,
              bookingId: result.bookingId,
            },
          },
        ]
      }

      return []
    },
  })
}

/* ------------------------------------------------- deciding who pays ----- */

const LIABILITY_INPUT = s.object({
  caseId: s.uuid({ label: 'תיק' }),
  outcome: s.enumOf(LIABILITY_OUTCOMES, { label: 'הכרעה' }),
  basis: s.enumOf(LIABILITY_BASES, { label: 'על סמך' }),
  assessedTotalAgorot: s.agorot({ label: 'סכום שנבחן' }),
  guestChargeAgorot: s.agorot({ label: 'חיוב האורח' }),
  ownerChargeAgorot: s.agorot({ label: 'חיוב הבעלים' }),
  businessAbsorbedAgorot: s.agorot({ label: 'נספג על ידי העסק' }),
  supportingEvidenceIds: s.arrayOf(s.uuid({ label: 'ראיה' }), {
    label: 'ראיות',
    max: 50,
  }),
  supersedesDecisionId: s.nullable(s.uuid({ label: 'הכרעה קודמת' })),
})

export type DecideLiabilityInput = {
  caseId: string
  outcome: (typeof LIABILITY_OUTCOMES)[number]
  basis: (typeof LIABILITY_BASES)[number]
  assessedTotalAgorot: number
  guestChargeAgorot: number
  ownerChargeAgorot: number
  businessAbsorbedAgorot: number
  supportingEvidenceIds: string[]
  supersedesDecisionId: string | null
}

export type DecideLiabilityOperation = Operation<
  DecideLiabilityInput,
  CaseFile,
  LiabilityDecision
>

/**
 * Record who pays.
 *
 * The single most consequential write in this module, and the one the whole
 * design exists to constrain. Three things have to be true and all three are
 * checked by `evaluateLiability` rather than here, so the same refusals hold
 * for any other caller that ever appears:
 *
 *   · a named person decided — `context.actor.userId`;
 *   · that person is a person — `context.auditActor.type`, which is `system`
 *     for a scheduled job and `ai_agent` for an agent, and both are refused;
 *   · they said why — `context.reason`, which `requiresReason` already made
 *     mandatory and which is stored as the decision's rationale.
 *
 * **It moves no money.** A decision that the guest owes ₪1,410 produces a row
 * saying so and nothing else. Applying it to a deposit is
 * `money_access_cancellation` and goes through `src/lib/payments`.
 */
export function defineDecideLiability(
  options: IncidentOperationOptions,
): DecideLiabilityOperation {
  const cases = repositoryFor(options)

  return defineOperation<DecideLiabilityInput, CaseFile, LiabilityDecision>({
    name: 'incident_case.decide_liability',
    permission: 'incident.resolve',
    resourceType: 'incident_case',
    input: LIABILITY_INPUT,
    // The stated reason is the rationale. Explicit rather than inherited from
    // `SENSITIVE_ACTIONS`, so removing `incident.resolve` from that set — or
    // never adding it — cannot quietly make this operation reasonless.
    requiresReason: true,

    async loadResource({ input, context }) {
      const file = await cases.loadCase(
        context.actor.organizationId,
        input.caseId,
      )
      if (!file) return null
      return {
        resource: resourceFor(file.incident),
        entity: file,
        version: file.incident.version,
      }
    },

    rule({ input, entity, context, now }) {
      if (entity.incident.status === 'closed') {
        throw new BusinessRuleError({
          code: 'incident_case_closed',
          message: `Case ${entity.incident.id} is closed`,
          userMessage: 'התיק סגור, ולכן לא ניתן לרשום בו הכרעה חדשה.',
        })
      }

      const check = evaluateLiability({
        organizationId: context.actor.organizationId,
        caseId: input.caseId,
        outcome: input.outcome,
        decidedByUserId: context.actor.userId,
        deciderType: context.auditActor.type,
        decidedAt: now,
        basis: input.basis,
        rationale: context.reason ?? null,
        assessedTotalAgorot: input.assessedTotalAgorot,
        guestChargeAgorot: input.guestChargeAgorot,
        ownerChargeAgorot: input.ownerChargeAgorot,
        businessAbsorbedAgorot: input.businessAbsorbedAgorot,
        supportingEvidenceIds: input.supportingEvidenceIds,
        supersedesDecisionId: input.supersedesDecisionId,
      })

      if (!check.ok) {
        // `not_a_person` is a business rule and not a field error: there is no
        // input a scheduled job could have sent that would have been accepted.
        if (check.problems.includes('not_a_person')) {
          throw new BusinessRuleError({
            code: 'liability_requires_a_person',
            message: `Decider type ${context.auditActor.type} may not decide liability`,
            userMessage: LIABILITY_PROBLEM_MESSAGE.not_a_person,
          })
        }

        throw new ValidationError(
          check.problems.map((problem) => ({
            field: fieldForProblem(problem),
            code: problem,
            message: LIABILITY_PROBLEM_MESSAGE[problem],
            label: 'הכרעה',
          })),
        )
      }
    },

    async execute({ input, entity, context, now, tx }) {
      const check = evaluateLiability({
        organizationId: context.actor.organizationId,
        caseId: input.caseId,
        outcome: input.outcome,
        decidedByUserId: context.actor.userId,
        deciderType: context.auditActor.type,
        decidedAt: now,
        basis: input.basis,
        rationale: context.reason ?? null,
        assessedTotalAgorot: input.assessedTotalAgorot,
        guestChargeAgorot: input.guestChargeAgorot,
        ownerChargeAgorot: input.ownerChargeAgorot,
        businessAbsorbedAgorot: input.businessAbsorbedAgorot,
        supportingEvidenceIds: input.supportingEvidenceIds,
        supersedesDecisionId: input.supersedesDecisionId,
      })

      // The rule ran first and refused every failing case, so this cannot be
      // reached with a bad draft. It is re-derived rather than smuggled from
      // the rule through a closure, because a rule that returns state is a
      // rule somebody later runs conditionally.
      if (!check.ok) {
        throw new BusinessRuleError({
          code: 'liability_not_decidable',
          message: `Liability draft rejected: ${check.problems.join(', ')}`,
          userMessage:
            LIABILITY_PROBLEM_MESSAGE[check.problems[0] ?? 'no_basis'],
        })
      }

      void entity
      return cases.insertLiabilityDecision(check.decision, tx)
    },

    audit({ entity, result, context }) {
      return {
        summary:
          `הוכרעה אחריות בתיק ״${entity.incident.title}״: ` +
          `${result.outcome}, חיוב אורח ${result.guestChargeAgorot} אגורות`,
        resourceId: entity.incident.id,
        propertyId: entity.incident.propertyId,
        reason: context.reason ?? null,
        after: {
          outcome: result.outcome,
          basis: result.basis,
          decidedByUserId: result.decidedByUserId,
          assessedTotalAgorot: result.assessedTotalAgorot,
          guestChargeAgorot: result.guestChargeAgorot,
          ownerChargeAgorot: result.ownerChargeAgorot,
          businessAbsorbedAgorot: result.businessAbsorbedAgorot,
        },
      }
    },

    /**
     * `approval.decided` is what this is: a person deciding a thing that was
     * awaiting a decision. It is the closest name in the frozen catalogue and
     * it is not a stretch — the payload names the case, so a subscriber can
     * tell an incident decision from a booking one.
     */
    events({ entity, result }): readonly CaseEventDraft[] {
      return [
        {
          name: 'approval.decided',
          propertyId: entity.incident.propertyId,
          payload: {
            subject: 'incident_case',
            caseId: entity.incident.id,
            decisionId: result.id,
            outcome: result.outcome,
            decidedByUserId: result.decidedByUserId,
            guestChargeAgorot: result.guestChargeAgorot,
          },
        },
      ]
    },
  })
}

function fieldForProblem(problem: string): string {
  if (problem === 'no_rationale') return 'reason'
  if (problem === 'no_basis') return 'basis'
  if (problem === 'no_decider' || problem === 'not_a_person') return 'decidedBy'
  if (problem === 'guest_charge_without_guest_outcome') return 'outcome'
  return 'guestChargeAgorot'
}

/* -------------------------------------------------------------- closing -- */

const CLOSE_INPUT = s.object({ caseId: s.uuid({ label: 'תיק' }) })

export type CloseCaseInput = { caseId: string }

export type CloseCaseOperation = Operation<
  CloseCaseInput,
  CaseFile,
  IncidentCase
>

/**
 * Close a case.
 *
 * `incident.resolve` and not `incident.update`, because closing is where the
 * money stops being arguable. `checkTransition` refuses a closure with an
 * unanswered question outstanding and refuses one where costs were recorded
 * and nobody decided — the two ways a case gets tidied away instead of
 * settled. Neither is a warning; both are refusals with a sentence.
 */
export function defineCloseCase(
  options: IncidentOperationOptions,
): CloseCaseOperation {
  const cases = repositoryFor(options)

  return defineOperation<CloseCaseInput, CaseFile, IncidentCase>({
    name: 'incident_case.close',
    permission: 'incident.resolve',
    resourceType: 'incident_case',
    input: CLOSE_INPUT,

    async loadResource({ input, context }) {
      const file = await cases.loadCase(
        context.actor.organizationId,
        input.caseId,
      )
      if (!file) return null
      return {
        resource: resourceFor(file.incident),
        entity: file,
        version: file.incident.version,
      }
    },

    rule({ entity }) {
      refuseTransition(factsFor(entity), 'closed')
    },

    async execute({ input, context, now, tx }) {
      return cases.setStatus(
        context.actor.organizationId,
        input.caseId,
        'closed',
        context.actor.userId,
        now,
        tx,
      )
    },

    audit({ entity, result }) {
      return {
        summary:
          `נסגר תיק ״${entity.incident.title}״. עלות שנבחנה: ` +
          `${assessedTotal(entity.costLines)} אגורות`,
        resourceId: result.id,
        propertyId: result.propertyId,
        before: { status: entity.incident.status },
        after: {
          status: result.status,
          decisions: entity.decisions.length,
          assessedTotalAgorot: assessedTotal(entity.costLines),
        },
      }
    },

    events({ entity, result }): readonly CaseEventDraft[] {
      return [
        {
          name: 'incident.closed',
          propertyId: result.propertyId,
          payload: {
            caseId: result.id,
            decisions: entity.decisions.length,
            assessedTotalAgorot: assessedTotal(entity.costLines),
          },
        },
      ]
    },
  })
}

/* --------------------------------------------------------------- bundle -- */

export interface IncidentOperations {
  openCase: OpenCaseOperation
  addEvidence: AddEvidenceOperation
  advanceCase: AdvanceCaseOperation
  decideLiability: DecideLiabilityOperation
  closeCase: CloseCaseOperation
}

/**
 * All five, built over one client.
 *
 * Built per call rather than cached at module scope: the client carries the
 * caller's session, and one shared instance would be one shared identity.
 */
export function defineIncidentOperations(
  options: IncidentOperationOptions,
): IncidentOperations {
  return {
    openCase: defineOpenCase(options),
    addEvidence: defineAddEvidence(options),
    advanceCase: defineAdvanceCase(options),
    decideLiability: defineDecideLiability(options),
    closeCase: defineCloseCase(options),
  }
}
