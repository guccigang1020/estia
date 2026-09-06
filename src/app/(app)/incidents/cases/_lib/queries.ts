/**
 * EXECUTION CONTEXT — SERVER ONLY. The read side of the damage case register.
 *
 * ══ THE TABLES MAY NOT EXIST YET, AND THAT IS A STATE ══════════════════════
 *
 * `src/lib/incidents/**` is written against a schema that has been proposed
 * and not yet applied — the migration belongs to the coordinator. So every
 * read here goes through `readIncidents`, which turns `42P01` and `PGRST205`
 * into `state: 'not_provisioned'` and rethrows everything else. The screen
 * renders `DomainGap` naming the seven tables rather than an empty list,
 * because an empty list would tell a business that the capability works and
 * that they have never had a damage case — which is the opposite of true.
 *
 * The day the migration runs, these screens fill up with no code change.
 *
 * ── Three floors, and the menu is none of them ────────────────────────────
 *
 *   1. `requireGrant('incident.view')` refuses the route.
 *   2. The selected property narrows every query, and **every row that
 *      survives it is checked again** with `can()` against the property it
 *      names. A query built wrong then returns short rather than wide, which
 *      is the failure direction that matters.
 *   3. Row level security refuses regardless of both. The policies the
 *      migration must carry are in this module's report; every one checks
 *      `has_permission(organization_id, 'incident.view')` plus
 *      `property_in_scope(property_id)`.
 *
 * ── What is deliberately not read, and what is gated ──────────────────────
 *
 * No guest name, no phone, no email. A damage case is argued about a stay and
 * a person who may work one is not thereby somebody who may read the guest's
 * details — the booking id is enough to act on and is itself withheld without
 * `booking.view`.
 *
 * Money is gated separately from the case. `incident.view` says somebody may
 * see that a worktop is being argued about; `expense.view` says they may see
 * what it cost, and `payment.view` says they may see what is held as a
 * deposit. Three grants because they are three different disclosures, and the
 * cheapest way to leak a repair bill is to assume the first implies the other
 * two.
 */

import { can, holdsGrant, type Actor, type Resource } from '@/lib/authz/can'
import { localDate } from '@/lib/booking/dates'
import {
  availableTransitions,
  compareChain,
  daysInState,
  isWaitingOnSomebody,
  tallyEvidence,
  type CaseFacts,
  type EvidenceTally,
  type IncidentCase,
  type IncidentCaseStatus,
  type InspectionChainStep,
} from '@/lib/incidents'
import { assessedTotal, provisionalTotal, sumLines } from '@/lib/incidents'
import {
  INCIDENT_TABLES,
  SupabaseIncidentRepository,
  readIncidents,
  type CaseFile,
  type Provisioned,
} from '@/lib/incidents/repository'
import type { Db } from '@/lib/persistence'

/** Named once, so the screen and the gap notice cannot disagree. */
export const CASE_TABLES: readonly string[] = INCIDENT_TABLES

function caseResource(incident: IncidentCase): Resource {
  return {
    organizationId: incident.organizationId,
    propertyId: incident.propertyId,
    ...(incident.unitId === null ? {} : { unitId: incident.unitId }),
    family: 'operations',
  }
}

/* ------------------------------------------------------------- register -- */

/**
 * One line of the register.
 *
 * No money, deliberately, and for the reason the fault register beside it
 * gives: this list is read by supervisors and it is a picture of what is being
 * argued about, not of what it is costing. The cost is on the case, behind
 * `expense.view`.
 */
export interface CaseRow {
  id: string
  title: string
  caseType: IncidentCase['caseType']
  origin: IncidentCase['origin']
  status: IncidentCaseStatus
  propertyId: string
  unitId: string | null
  /**
   * The property-local day it was opened, as `YYYY-MM-DD`.
   *
   * Converted with `localDate` against `PROPERTY_TIME_ZONE` and never sliced
   * off an ISO string: a case opened at 00:30 in Israel would otherwise be
   * filed under yesterday, and the age beside it would be a day out.
   */
  openedOn: string
  /** How long it has been sitting where it is. Whole days, floored. */
  ageDays: number
  /** True while somebody outside the business owes an answer. */
  waiting: boolean
}

export interface CaseRegister {
  rows: readonly CaseRow[]
  /** How many the reader could reach before the status filter. */
  reachable: number
}

export async function loadCaseRegister(args: {
  db: Db
  actor: Actor
  organizationId: string
  propertyId: string | null
  now: Date
  statuses?: readonly IncidentCaseStatus[]
}): Promise<Provisioned<CaseRegister>> {
  const repository = new SupabaseIncidentRepository(args.db)

  return readIncidents(async () => {
    const [cases, reachable] = await Promise.all([
      repository.listCases(args.organizationId, {
        propertyId: args.propertyId,
        statuses: args.statuses,
      }),
      repository.countCases(args.organizationId, {
        propertyId: args.propertyId,
      }),
    ])

    // The second floor. Every row the query returned is checked again against
    // the property it names, so a filter built wrong returns short.
    const rows = cases
      .filter((incident) =>
        can(args.actor, 'incident.view', caseResource(incident)),
      )
      .map((incident) => ({
        id: incident.id,
        title: incident.title,
        caseType: incident.caseType,
        origin: incident.origin,
        status: incident.status,
        propertyId: incident.propertyId,
        unitId: incident.unitId,
        openedOn: localDate(incident.openedAt),
        ageDays: daysInState(incident.openedAt, args.now),
        waiting: isWaitingOnSomebody(incident.status),
      }))

    return { rows, reachable }
  })
}

/* --------------------------------------------------------------- detail -- */

/** What the money panel shows, when the reader may see money at all. */
export interface CaseMoney {
  /** What it cost, receipts preferred over estimates. */
  assessedAgorot: number
  /** What was feared before anybody invoiced. */
  provisionalAgorot: number
  /** Every line, so a total is never a number nobody can take apart. */
  totalAgorot: number
  lineCount: number
}

export interface CaseDetail {
  file: CaseFile
  facts: CaseFacts
  /** What the workflow would actually allow from here. */
  available: readonly IncidentCaseStatus[]
  evidence: EvidenceTally
  /** The inspection chain, stage by stage. Differences, never conclusions. */
  comparison: readonly InspectionChainStep[]
  /** `expense.view`. Absent rather than zeroed when the reader may not see it. */
  money: CaseMoney | null
  /** May move it along. `incident.update`. */
  mayWork: boolean
  /** May decide and close it. `incident.resolve`. */
  mayDecide: boolean
  /** May be shown the stay this is argued against. `booking.view`. */
  maySeeBooking: boolean
  /** May be shown what is held as a deposit. `payment.view`. */
  maySeeDeposit: boolean
  /**
   * What is held as a deposit against this stay, or `null` when nobody here
   * can say.
   *
   * Always `null` today, and deliberately so rather than `0`. The held deposit
   * lives in the payments module — `CollectionFacts` and the payment rows —
   * and there is no read on `PaymentPolicyRepository` that answers "how much
   * is held against booking X". Reporting `0` would tell somebody deciding a
   * ₪1,410 case that there is nothing to apply it against, which is the
   * expensive direction to be wrong in. So the screen says the figure is not
   * available rather than inventing one, and this becomes a number the day the
   * payments module exposes it.
   */
  depositHeldAgorot: number | null
}

export async function loadCaseDetail(args: {
  db: Db
  actor: Actor
  organizationId: string
  caseId: string
}): Promise<Provisioned<CaseDetail | null>> {
  const repository = new SupabaseIncidentRepository(args.db)

  return readIncidents(async () => {
    const file = await repository.loadCase(args.organizationId, args.caseId)
    if (!file) return null

    // The row-level check, again, against the property this case names. A case
    // the reader may not reach is reported as absent rather than as refused:
    // "you may not see case 4131" confirms that case 4131 exists.
    if (!can(args.actor, 'incident.view', caseResource(file.incident))) {
      return null
    }

    const facts: CaseFacts = {
      status: file.incident.status,
      questions: file.questions,
      hasLiabilityDecision: file.decisions.length > 0,
      recordedCostAgorot: sumLines(file.costLines),
    }

    const resource = caseResource(file.incident)
    const mayReadMoney = can(args.actor, 'expense.view', resource)

    const redacted: CaseFile = {
      ...file,
      // Withheld rather than zeroed. A money panel showing ₪0 to somebody who
      // may not read expenses is a lie about the case, not a redaction.
      costLines: mayReadMoney ? file.costLines : [],
      decisions: mayReadMoney
        ? file.decisions
        : // The outcome is operational — who is being argued with — and the
          // amounts are financial. A reader without `expense.view` learns that
          // a decision exists and not what it was worth.
          file.decisions.map((decision) => ({
            ...decision,
            assessedTotalAgorot: 0,
            guestChargeAgorot: 0,
            ownerChargeAgorot: 0,
            businessAbsorbedAgorot: 0,
          })),
    }

    return {
      file: redacted,
      facts,
      available: availableTransitions(facts),
      evidence: tallyEvidence(file.evidence),
      comparison: compareChain(file.inspections),
      money: mayReadMoney
        ? {
            assessedAgorot: assessedTotal(file.costLines),
            provisionalAgorot: provisionalTotal(file.costLines),
            totalAgorot: sumLines(file.costLines),
            lineCount: file.costLines.length,
          }
        : null,
      mayWork: can(args.actor, 'incident.update', resource),
      mayDecide: can(args.actor, 'incident.resolve', resource),
      maySeeBooking: holdsGrant(args.actor, 'booking.view'),
      maySeeDeposit: holdsGrant(args.actor, 'payment.view'),
      depositHeldAgorot: null,
    }
  })
}
