/**
 * Agencies.
 *
 * Two documents appeared to contradict each other: one calls `agency` an entity
 * in the data model, the other calls "authorised agency" one of four permission
 * presets. `ARCHITECTURE.md` §12 settles it — **both are true and they are
 * different things**, and this file implements the first.
 *
 *   · **An agency is an entity.** It has a name, members and payment details,
 *     and it sells for several organizations at once — so it cannot be a
 *     sub-record of any one of them. `Agency` below carries no
 *     `organizationId`, and that absence is the design.
 *
 *   · **"Authorised agency" is a permission preset.** It lives in `access.ts`
 *     as `AGENT_PRESETS.agency`, a set of starting rungs like the other three,
 *     and it has no existence after it is chosen.
 *
 * ── Access derives from an agreement ──────────────────────────────────────
 *
 * What connects an agency to an organization is an `AgencyAgreement` — a
 * commercial document with a start and an end. An agreement that has ended
 * removes the agency's reach **without anybody deleting anything**: the
 * bookings, the commissions and the attribution all stand, and only the access
 * stops. That is the same rule suspension follows for an individual, and it
 * matters more here, because an agency that stopped working with a business in
 * March is still owed money on stays happening in August.
 *
 * The agreement is a *commercial* record, not an authorization one. It does not
 * grant permissions; it decides whether the agency's agents have a live
 * relationship at all, and their actual grants still come from the ladders on
 * each individual membership.
 */

import { BusinessRuleError } from '../errors'
import type { CommissionBase, CommissionRule } from './commission'

// ── The entity ────────────────────────────────────────────────────────────

/**
 * An agency, globally.
 *
 * No `organizationId`. An agency that belonged to one organization could not
 * sell for a second, which is the entire reason it is an entity rather than a
 * row on somebody's team list.
 */
export interface Agency {
  id: string
  name: string
  /** For the invoice the business receives. Never per-organization. */
  taxId: string | null
  contactPhoneE164: string | null
  contactEmail: string | null
  status: 'active' | 'inactive'
  createdAt: string
}

/**
 * Somebody who sells under an agency's banner.
 *
 * Also global, and also not per-organization: a person is a member of the
 * agency, and the agency's agreements decide which businesses that reaches.
 * `manager` may see the agency's own agreements and run its agents; `agent`
 * sells. Neither is a permission — permissions come from each individual's
 * membership ladders — it is the agency's own internal structure.
 */
export interface AgencyMembership {
  agencyId: string
  userId: string
  role: 'manager' | 'agent'
  status: 'active' | 'suspended' | 'removed'
  joinedAt: string
  leftAt: string | null
}

// ── The agreement ─────────────────────────────────────────────────────────

/**
 * The commercial relationship between one agency and one organization.
 *
 * This is the per-organization half. The same agency has a different agreement
 * with every business it sells for — different rates, different bases,
 * different dates — and no business can see another's terms.
 */
export interface AgencyAgreement {
  id: string
  agencyId: string
  organizationId: string
  /** The agency's default commission. Individual rules may still override it. */
  rule: CommissionRule
  base: CommissionBase
  /** ISO date. Inclusive. */
  activeFrom: string
  /** ISO date, inclusive. `null` means open-ended. */
  activeUntil: string | null
  /** Days the business has to pay an approved commission. Commercial, not code. */
  paymentTermsDays: number
  status: 'draft' | 'active' | 'terminated'
  signedAt: string | null
  createdAt: string
  version: number
}

/**
 * Is this agreement live on this date?
 *
 * Decided against the date every time it is asked, never read from the status
 * alone. An agreement whose end date passed last night is over whether or not
 * anybody has run a job to say so — the same discipline holds and approvals
 * follow, and for the same reason: a background job that stops running must not
 * be able to grant access it was supposed to remove.
 */
export function isAgreementActive(
  agreement: AgencyAgreement,
  on: string,
): boolean {
  if (agreement.status !== 'active') return false
  if (on < agreement.activeFrom) return false
  if (agreement.activeUntil !== null && on > agreement.activeUntil) return false
  return true
}

/**
 * The agreement letting this agency sell for this organization today, or `null`.
 *
 * `null` is a complete answer and callers must treat it as one: no live
 * agreement means no reach, not a fallback to some default arrangement.
 *
 * Where two agreements overlap — a renewal signed before the old one lapsed —
 * the one that started most recently wins, because that is the renewal.
 */
export function activeAgreementFor(
  agreements: readonly AgencyAgreement[],
  agencyId: string,
  organizationId: string,
  on: string,
): AgencyAgreement | null {
  const live = agreements.filter(
    (agreement) =>
      agreement.agencyId === agencyId &&
      agreement.organizationId === organizationId &&
      isAgreementActive(agreement, on),
  )
  if (live.length === 0) return null

  return live.sort((a, b) => {
    if (a.activeFrom !== b.activeFrom) {
      return a.activeFrom < b.activeFrom ? 1 : -1
    }
    return a.id < b.id ? 1 : -1
  })[0]
}

/**
 * Every organization this agency may currently sell for.
 *
 * The agency's own view of its book of business. Derived from live agreements
 * rather than stored, so ending an agreement removes the organization from this
 * list with no second write to forget.
 */
export function organizationsForAgency(
  agreements: readonly AgencyAgreement[],
  agencyId: string,
  on: string,
): readonly string[] {
  const organizations = new Set<string>()
  for (const agreement of agreements) {
    if (agreement.agencyId !== agencyId) continue
    if (!isAgreementActive(agreement, on)) continue
    organizations.add(agreement.organizationId)
  }
  return [...organizations]
}

/**
 * Can this person act for this agency in this organization right now?
 *
 * Both halves are required and they fail differently. A person who left the
 * agency keeps nothing; an agency whose agreement lapsed keeps its history and
 * loses its reach. Neither is a permission check — that is still `can()` on the
 * individual's membership. This only decides whether the commercial
 * relationship exists at all.
 */
export function agencyReachesOrganization(input: {
  membership: AgencyMembership | null
  agreements: readonly AgencyAgreement[]
  agencyId: string
  organizationId: string
  on: string
}): boolean {
  if (input.membership === null) return false
  if (input.membership.agencyId !== input.agencyId) return false
  if (input.membership.status !== 'active') return false

  return (
    activeAgreementFor(
      input.agreements,
      input.agencyId,
      input.organizationId,
      input.on,
    ) !== null
  )
}

// ── Ending one ────────────────────────────────────────────────────────────

/**
 * End an agreement.
 *
 * Sets a status and a final date. It deletes nothing, and it deliberately
 * cannot: the commissions written under this agreement are still owed, the
 * bookings it produced are still attributed to it, and a report comparing
 * direct against agency sales must still be able to read it. An agreement is
 * closed, never removed.
 *
 * The end date may be in the future — a notice period is normal — so this does
 * not immediately revoke anything. `isAgreementActive` reads the date.
 */
export function terminateAgreement(
  agreement: AgencyAgreement,
  input: { effectiveOn: string },
): AgencyAgreement {
  if (agreement.status === 'terminated') {
    throw new BusinessRuleError({
      code: 'agency_agreement.already_terminated',
      message: `Agreement ${agreement.id} is already terminated`,
      userMessage: 'ההסכם כבר הסתיים.',
    })
  }
  if (input.effectiveOn < agreement.activeFrom) {
    throw new BusinessRuleError({
      code: 'agency_agreement.ends_before_it_starts',
      message:
        `Agreement ${agreement.id} cannot end on ${input.effectiveOn}, ` +
        `before it began on ${agreement.activeFrom}`,
      userMessage: 'תאריך סיום ההסכם מוקדם מתאריך תחילתו.',
    })
  }

  return {
    ...agreement,
    status: 'terminated',
    activeUntil: input.effectiveOn,
    version: agreement.version + 1,
  }
}

/**
 * ── A note for whoever owns `supabase/migrations/` ────────────────────────
 *
 * None of these three records has a table. `agencies`, `agency_memberships`
 * and `agency_agreements` are all absent from 0001–0011, and `bookings` and
 * `commissions` both carry an `agency_id` that references nothing — it is a
 * bare `uuid` column with no foreign key, which the migration for `commissions`
 * is explicit about.
 *
 * That is workable while agencies are unused and becomes a real problem the
 * first time one exists: an `agency_id` pointing at no row cannot be joined,
 * cannot be constrained, and cannot be prevented from naming an agency that
 * belongs to a different tenant. `agencies` in particular is the one table in
 * this module that must **not** carry `organization_id`, which makes it the one
 * table whose RLS policy has to be written by hand rather than copied.
 */
