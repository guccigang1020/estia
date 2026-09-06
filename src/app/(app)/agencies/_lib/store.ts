/**
 * EXECUTION CONTEXT — SERVER ONLY. `AgencyStore` against Supabase.
 *
 * A mapping with no decisions in it. Every refusal lives in
 * `src/lib/agents/agency-operations.ts` or in the database; what is here is the
 * shape of the rows and the two function calls the write path cannot make as
 * table writes.
 *
 * ── An UPDATE that matches nothing is not a success ───────────────────────
 *
 * Row level security turns a refusal into an empty result set, not an error.
 * `update(...).eq('id', …)` against a row the policy will not show reports
 * `error: null` and changes nothing, and the screen says "נשמר". Every write
 * below therefore asks for the row back and throws when none comes — which
 * also catches the other case with the same symptom: an optimistic-locking
 * `eq('version', …)` that lost a race.
 *
 * ── Why two calls are RPCs ────────────────────────────────────────────────
 *
 * `createAgency` and `deactivate` are `SECURITY DEFINER` functions from
 * `0070_agencies_write_path.sql`. The reasons are in that file's header and in
 * `agency-store.ts`, and neither is "it was easier": an `INSERT … RETURNING` on
 * `agencies` raises under its own SELECT policy, and whether a deactivation may
 * mark the *entity* inactive depends on another organization's agreements,
 * which this client cannot see and must not guess. No service-role client is
 * used anywhere here.
 */

import type {
  AgencyContactDraft,
  AgencyRecord,
  AgencyStore,
  AgencyTermsTarget,
  CreateAgencyRequest,
  DeactivateResult,
  SaveTermsRequest,
} from '@/lib/agents'
import { COMMISSION_BASES } from '@/lib/contracts/states'
import { AppError } from '@/lib/errors'
import {
  asEnum,
  asNumber,
  asString,
  asStringOrNull,
  clientFor,
  toRow,
  toRows,
  type Db,
  type Row,
} from '@/lib/persistence'
import type { TransactionHandle } from '@/lib/service'

const AGENCY_COLUMNS =
  'id, name, tax_id, contact_phone, contact_phone_e164, contact_email, ' +
  'address_line1, city, country, note, status, deactivation_reason, version'

const AGREEMENT_COLUMNS =
  'id, agency_id, status, rule, base, active_from, active_until, ' +
  'payment_terms_days, version'

const AGREEMENT_STATUSES = ['draft', 'active', 'terminated'] as const
const AGENCY_STATUSES = ['active', 'inactive'] as const

/**
 * A write that reached no row.
 *
 * Its own class rather than a bare `Error`, so `toSafeResponse` gives the
 * person a sentence about a stale screen instead of "אירעה תקלה". Both causes
 * genuinely mean "reload and look again": the policy refused, or somebody else
 * saved first.
 */
class WriteReachedNothingError extends AppError {
  constructor(what: string) {
    super({
      code: 'agency_write_reached_no_row',
      status: 409,
      message: `The ${what} write matched no row: refused by policy, or the version moved`,
      userMessage:
        'השינוי לא נשמר. או שהרשומה השתנתה בינתיים, או שאין לך הרשאה לערוך אותה. רענן את המסך ובדוק מה מצבה עכשיו.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

export class SupabaseAgencyStore implements AgencyStore {
  constructor(private readonly db: Db) {}

  async createAgency(
    request: CreateAgencyRequest,
    tx: TransactionHandle,
  ): Promise<{ id: string }> {
    const db = clientFor(tx, this.db)
    const { contact, terms } = request

    const { data, error } = await db.rpc('create_agency', {
      p_organization_id: request.organizationId,
      p_name: contact.name,
      p_tax_id: contact.taxId,
      p_contact_phone: contact.contactPhone,
      p_contact_email: contact.contactEmail,
      p_address_line1: contact.addressLine1,
      p_city: contact.city,
      p_country: contact.country,
      p_note: contact.note,
      p_rule: terms.rule,
      p_base: terms.base,
      p_active_from: terms.activeFrom,
      p_payment_terms_days: terms.paymentTermsDays,
    })

    if (error) throw error
    if (typeof data !== 'string' || data.length === 0) {
      throw new WriteReachedNothingError('agency creation')
    }
    return { id: data }
  }

  async loadAgency(
    organizationId: string,
    agencyId: string,
  ): Promise<AgencyRecord | null> {
    // The tenant confinement. `agencies` has no organization_id and cannot have
    // one, so an agency this business never signed with must be indistinguishable
    // from an id that does not exist — hence the agreement read first, and a
    // plain `null` when it returns nothing.
    const agreements = await this.agreementsFor(organizationId, agencyId)
    if (agreements.length === 0) return null

    const { data, error } = await this.db
      .from('agencies')
      .select(AGENCY_COLUMNS)
      .eq('id', agencyId)
      .maybeSingle()

    if (error) throw error
    const row = data === null ? null : toRow(data)
    if (row === null) return null

    return this.toRecord(row, agreements, await this.hasManager(agencyId))
  }

  async loadTermsTarget(
    organizationId: string,
    agencyId: string,
  ): Promise<AgencyTermsTarget | null> {
    const agency = await this.loadAgency(organizationId, agencyId)
    if (agency === null) return null

    const agreements = await this.agreementsFor(organizationId, agencyId)
    // The live one, or the most recently started otherwise — the same
    // "latest start wins" rule `activeAgreementFor` uses for a renewal signed
    // before the old one lapsed.
    const chosen =
      agreements.find((row) => asString(row, 'status') === 'active') ??
      agreements[0]
    if (chosen === undefined) return null

    return {
      agency,
      agreement: {
        id: asString(chosen, 'id'),
        status: asEnum(chosen, 'status', AGREEMENT_STATUSES),
        rule: chosen.rule ?? null,
        base: asEnum(chosen, 'base', COMMISSION_BASES),
        activeFrom: asString(chosen, 'active_from'),
        activeUntil: asStringOrNull(chosen, 'active_until'),
        paymentTermsDays: asNumber(chosen, 'payment_terms_days'),
        version: asNumber(chosen, 'version'),
      },
      defaultRuleId: await this.defaultRuleId(organizationId, agencyId),
    }
  }

  async saveContact(
    request: { agencyId: string; contact: AgencyContactDraft },
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<{ id: string; version: number }> {
    const db = clientFor(tx, this.db)
    const { contact } = request

    const { data, error } = await db
      .from('agencies')
      .update({
        name: contact.name,
        tax_id: contact.taxId,
        contact_phone: contact.contactPhone,
        contact_email: contact.contactEmail,
        address_line1: contact.addressLine1,
        city: contact.city,
        country: contact.country,
        note: contact.note,
        // `contact_phone_e164` is generated and is deliberately absent: a write
        // path that could set it is a write path that can store two spellings
        // of one number.
      })
      .eq('id', request.agencyId)
      .eq('version', expectedVersion)
      .select('id, version')

    if (error) throw error
    const rows = toRows(data)
    if (rows.length === 0) throw new WriteReachedNothingError('contact')

    return {
      id: asString(rows[0], 'id'),
      version: asNumber(rows[0], 'version'),
    }
  }

  async saveTerms(
    request: SaveTermsRequest,
    expectedVersion: number,
    tx: TransactionHandle,
  ): Promise<{ agreementId: string; ruleId: string }> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('agency_agreements')
      .update({
        rule: request.rule,
        base: request.base,
        active_from: request.activeFrom,
        active_until: request.activeUntil,
        payment_terms_days: request.paymentTermsDays,
        note: request.note,
      })
      .eq('id', request.agreementId)
      .eq('organization_id', request.organizationId)
      .eq('version', expectedVersion)
      .select('id')

    if (error) throw error
    if (toRows(data).length === 0) {
      throw new WriteReachedNothingError('agreement terms')
    }

    // And the row the resolver reads. `agency_agreements.rule` is the document;
    // `selectCommissionRule` never looks at it. Writing only the first would
    // render 12% beside an agency that earns nothing.
    const rulePayload = {
      organization_id: request.organizationId,
      agency_id: request.agencyId,
      agent_user_id: null,
      rule: request.rule,
      base: request.base,
      eligibility_conditions: [...request.eligibility],
      // The scope columns stay NULL — "any" — which is what makes this the
      // agency's default rule and what
      // `agent_commission_rules_agency_default_idx` in 0070 keeps unique. An
      // empty array here would mean "no property at all", i.e. a rule that pays
      // nobody; `commission.ts` calls that difference out by name.
      effective_from: request.activeFrom,
      effective_until: request.activeUntil,
    }

    const written =
      request.existingRuleId === null
        ? await db
            .from('agent_commission_rules')
            .insert(rulePayload)
            .select('id')
        : await db
            .from('agent_commission_rules')
            .update(rulePayload)
            .eq('id', request.existingRuleId)
            .eq('organization_id', request.organizationId)
            .select('id')

    if (written.error) throw written.error
    const ruleRows = toRows(written.data)
    if (ruleRows.length === 0) {
      throw new WriteReachedNothingError('commission rule')
    }

    return {
      agreementId: request.agreementId,
      ruleId: asString(ruleRows[0], 'id'),
    }
  }

  async deactivate(
    request: { agencyId: string; organizationId: string; reason: string },
    tx: TransactionHandle,
  ): Promise<DeactivateResult> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db.rpc('deactivate_agency', {
      p_agency_id: request.agencyId,
      p_organization_id: request.organizationId,
      p_reason: request.reason,
    })

    if (error) throw error
    if (typeof data !== 'object' || data === null) {
      throw new WriteReachedNothingError('deactivation')
    }

    const answer = data as Record<string, unknown>
    return {
      agreementsEnded:
        typeof answer.agreements_ended === 'number'
          ? answer.agreements_ended
          : 0,
      entityMarkedInactive: answer.entity_marked_inactive === true,
    }
  }

  async reactivate(
    request: { agencyId: string; organizationId: string },
    tx: TransactionHandle,
  ): Promise<{ agreementId: string }> {
    const db = clientFor(tx, this.db)

    // The most recently ended one. Reopening an older agreement would restore
    // terms that were superseded before they were terminated.
    const { data: candidates, error: readError } = await this.db
      .from('agency_agreements')
      .select('id, terminated_at')
      .eq('agency_id', request.agencyId)
      .eq('organization_id', request.organizationId)
      .eq('status', 'terminated')
      .order('terminated_at', { ascending: false })
      .limit(1)

    if (readError) throw readError
    const rows = toRows(candidates)
    if (rows.length === 0) throw new WriteReachedNothingError('reactivation')
    const agreementId = asString(rows[0], 'id')

    const { data, error } = await db
      .from('agency_agreements')
      .update({
        status: 'active',
        terminated_at: null,
        termination_reason: null,
        // Open-ended again. The old end date was written by the deactivation
        // itself, so keeping it would reopen an agreement that is already over.
        active_until: null,
      })
      .eq('id', agreementId)
      .eq('organization_id', request.organizationId)
      .select('id')

    if (error) throw error
    if (toRows(data).length === 0) {
      throw new WriteReachedNothingError('reactivation')
    }

    // The entity's own flag, only where the deactivation set it.
    // `agencies_inactive_pair` makes clearing all three unavoidable rather than
    // remembered.
    const { error: agencyError } = await db
      .from('agencies')
      .update({
        status: 'active',
        deactivated_at: null,
        deactivated_by: null,
        deactivation_reason: null,
      })
      .eq('id', request.agencyId)
      .eq('status', 'inactive')

    if (agencyError) throw agencyError

    return { agreementId }
  }

  /* ------------------------------------------------------------ pieces -- */

  private async agreementsFor(
    organizationId: string,
    agencyId: string,
  ): Promise<readonly Row[]> {
    const { data, error } = await this.db
      .from('agency_agreements')
      .select(AGREEMENT_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('agency_id', agencyId)
      .order('active_from', { ascending: false })

    if (error) throw error
    return toRows(data)
  }

  /**
   * Does somebody from the agency manage its own record?
   *
   * The same question `agency_is_unclaimed` asks in the database, asked here so
   * the screen can explain the refusal instead of the person meeting a write
   * that changed nothing. The database's answer is the one that binds.
   */
  private async hasManager(agencyId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('agency_memberships')
      .select('user_id')
      .eq('agency_id', agencyId)
      .eq('role', 'manager')
      .eq('status', 'active')
      .limit(1)

    if (error) throw error
    return toRows(data).length > 0
  }

  private async defaultRuleId(
    organizationId: string,
    agencyId: string,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from('agent_commission_rules')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('agency_id', agencyId)
      .is('agent_user_id', null)
      .is('property_ids', null)
      .is('unit_ids', null)
      .is('rate_plan_ids', null)
      .is('period_from', null)
      .is('period_to', null)
      .is('deleted_at', null)
      .limit(1)

    if (error) throw error
    const rows = toRows(data)
    return rows.length === 0 ? null : asString(rows[0], 'id')
  }

  private toRecord(
    row: Row,
    agreements: readonly Row[],
    managed: boolean,
  ): AgencyRecord {
    return {
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      taxId: asStringOrNull(row, 'tax_id'),
      contactPhone: asStringOrNull(row, 'contact_phone'),
      contactPhoneE164: asStringOrNull(row, 'contact_phone_e164'),
      contactEmail: asStringOrNull(row, 'contact_email'),
      addressLine1: asStringOrNull(row, 'address_line1'),
      city: asStringOrNull(row, 'city'),
      country: asString(row, 'country'),
      note: asStringOrNull(row, 'note'),
      status: asEnum(row, 'status', AGENCY_STATUSES),
      deactivationReason: asStringOrNull(row, 'deactivation_reason'),
      version: asNumber(row, 'version'),
      unclaimed: !managed,
      liveAgreements: agreements.filter(
        (agreement) => asString(agreement, 'status') === 'active',
      ).length,
      terminatedAgreements: agreements.filter(
        (agreement) => asString(agreement, 'status') === 'terminated',
      ).length,
    }
  }
}
