/**
 * The data-access contract behind the agency operations.
 *
 * Injected for the same reason `AgentRepository` is, and stated there: the
 * value in this domain is the refusals — who may edit an agency, what
 * deactivation is allowed to reach, whether the terms are coherent — and none
 * of that can be exercised properly through a database connection. Behind this
 * interface the whole write path runs in a millisecond against an in-memory
 * double, and the Supabase implementation is a mapping with no decisions in it.
 *
 * Every write takes the transaction handle the service pipeline opened. That is
 * not politeness: `setTerms` writes the agreement *and* the commission rule the
 * resolver reads, and a write that quietly used its own connection would let
 * the document and the resolver disagree without failing anything.
 *
 * ── Two calls here are database functions, and that is the design ─────────
 *
 * `createAgency` and `deactivate` are `SECURITY DEFINER` functions in
 * `0070_agencies_write_path.sql`, not table writes. Neither could be done from
 * the request path:
 *
 *   · An agency and its first agreement have to appear together, because
 *     `agencies_select` shows a row only to a member of the agency or to a
 *     business with a non-draft agreement — so `INSERT … RETURNING` on
 *     `agencies` alone raises, and two sequential writes can leave an agency no
 *     policy will ever show and no role can delete.
 *   · Whether a deactivation may also mark the *entity* inactive depends on
 *     whether another organization holds an agreement with it — which the
 *     caller cannot see, correctly, and must not be allowed to guess.
 *
 * No request path holds a service-role client. That is the rule the precedent
 * in `0061_webhook_enqueue.sql` set, and both functions check membership and
 * the grant explicitly inside, because RLS is bypassed for their bodies.
 */

import type { TransactionHandle } from '../service'
import type {
  CommissionBase,
  CommissionCondition,
  CommissionRule,
} from './commission'

/** The contact block, as a caller supplies it. Nulls clear; they never mean "leave alone". */
export interface AgencyContactDraft {
  name: string
  taxId: string | null
  contactPhone: string | null
  contactEmail: string | null
  addressLine1: string | null
  city: string | null
  /** ISO 3166-1 alpha-2, upper case. `agencies_country_format` enforces it. */
  country: string
  note: string | null
}

/**
 * An agency as the write path needs to see it.
 *
 * Wider than `Agency` in `agency.ts`, which is the read model the screens and
 * the reach rules use. The three extra facts are the ones a *decision* needs:
 * whether the record has an owner, and how many agreements this business holds
 * with it in each state.
 */
export interface AgencyRecord extends AgencyContactDraft {
  id: string
  contactPhoneE164: string | null
  status: 'active' | 'inactive'
  deactivationReason: string | null
  /** Owned by `tg_touch_row`. Optimistic locking reads it and never writes it. */
  version: number
  /**
   * True while nobody from the agency manages its own record.
   *
   * The hinge of `agencies_update` in 0070: a stub a guesthouse typed in during
   * a telephone call is theirs to correct; the moment a real manager exists the
   * record belongs to the agency and the business loses write access to it.
   */
  unclaimed: boolean
  /** This organization's agreements with it, by state. Not the agency's total. */
  liveAgreements: number
  terminatedAgreements: number
}

/** The agreement, as `setTerms` edits it. */
export interface AgencyAgreementRecord {
  id: string
  status: 'draft' | 'active' | 'terminated'
  rule: unknown
  base: CommissionBase
  activeFrom: string
  activeUntil: string | null
  paymentTermsDays: number
  version: number
}

/**
 * Everything `setTerms` locks against and writes to.
 *
 * `defaultRuleId` is the `agent_commission_rules` row scoped to this agency
 * with no agent and no narrowing — the one `selectCommissionRule` resolves.
 * `null` means there is none yet, which is the normal state of an agency
 * created before anybody set its terms.
 */
export interface AgencyTermsTarget {
  agency: AgencyRecord
  agreement: AgencyAgreementRecord
  defaultRuleId: string | null
}

export interface CreateAgencyRequest {
  organizationId: string
  contact: AgencyContactDraft
  terms: {
    rule: CommissionRule
    base: CommissionBase
    activeFrom: string
    paymentTermsDays: number
  }
}

export interface SaveTermsRequest {
  organizationId: string
  agencyId: string
  agreementId: string
  /** The existing default rule to update, or `null` to write the first one. */
  existingRuleId: string | null
  rule: CommissionRule
  base: CommissionBase
  eligibility: readonly CommissionCondition[]
  activeFrom: string
  activeUntil: string | null
  paymentTermsDays: number
  note: string | null
}

export interface DeactivateResult {
  agreementsEnded: number
  entityMarkedInactive: boolean
}

export interface AgencyStore {
  /** `public.create_agency`. The agency and its first agreement, atomically. */
  createAgency(
    request: CreateAgencyRequest,
    tx: TransactionHandle,
  ): Promise<{ id: string }>

  /**
   * The agency, confined to this organization by its agreements.
   *
   * `agencies` has no `organization_id` and cannot have one, so the read starts
   * from `agency_agreements` for this organization. An agency this business has
   * never signed with comes back `null` — the same answer an unknown id gets,
   * deliberately indistinguishable.
   */
  loadAgency(
    organizationId: string,
    agencyId: string,
  ): Promise<AgencyRecord | null>

  loadTermsTarget(
    organizationId: string,
    agencyId: string,
  ): Promise<AgencyTermsTarget | null>

  saveContact(
    request: { agencyId: string; contact: AgencyContactDraft },
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<{ id: string; version: number }>

  /** Writes the agreement and the commission rule the resolver reads. Both. */
  saveTerms(
    request: SaveTermsRequest,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<{ agreementId: string; ruleId: string }>

  /** `public.deactivate_agency`. Ends this business's agreements; deletes nothing. */
  deactivate(
    request: { agencyId: string; organizationId: string; reason: string },
    tx: TransactionHandle,
  ): Promise<DeactivateResult>

  /** Reopens the agreement this business most recently ended. */
  reactivate(
    request: { agencyId: string; organizationId: string },
    tx: TransactionHandle,
  ): Promise<{ agreementId: string }>
}
