/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Which step of onboarding this person is actually on.
 *
 * ── Why this is a query and not a cookie ──────────────────────────────────
 *
 * The wizard holds no "current step" of its own. Each step commits before the
 * next one is offered, so the step is a fact about the database and is derived
 * from it on every request:
 *
 *     no workspace                 → organization
 *     workspace, no property       → property
 *     property, no unit            → unit
 *     unit exists                  → done
 *
 * That makes refresh, the back button, a closed laptop and a second device all
 * behave the same way and require no code of their own. It also means an
 * abandoned signup resumes exactly where it stopped rather than starting over
 * or, worse, creating a second organization.
 *
 * ── Why each step commits ─────────────────────────────────────────────────
 *
 * The alternative — collect all four screens and write at the end — would put
 * the organization, the property and the unit in one write. They cannot BE one
 * write: the organization is created by the service layer with privilege
 * (`signup.ts` explains why) and the property and unit are created by the
 * caller under ordinary policies, which is only possible AFTER the membership
 * exists. Committing each step is not a compromise here, it is what the
 * privilege boundary already dictates.
 *
 * Every count below runs as the signed-in user. Row level security is what
 * confines them to the caller's organization; there is no `organization_id`
 * filter written here that could be forgotten, and `properties_select` also
 * applies the caller's property scope.
 */

import { createClient } from '@/lib/supabase/server'

export type OnboardingStep = 'organization' | 'property' | 'unit' | 'done'

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'organization',
  'property',
  'unit',
  'done',
]

export type OnboardingProgress = {
  step: OnboardingStep
  /** The property the unit step will hang off, once one exists. */
  propertyId: string | null
  propertyName: string | null
  /** House times, so a new unit starts from the property's own defaults. */
  checkInTime: string | null
  checkOutTime: string | null
}

const NO_WORKSPACE: OnboardingProgress = {
  step: 'organization',
  propertyId: null,
  propertyName: null,
  checkInTime: null,
  checkOutTime: null,
}

/**
 * Read the progress inside ONE organization.
 *
 * ── Why `organizationId` is an argument and not left to RLS ───────────────
 *
 * Row level security answers "may this person see this property", and that is
 * a different question from "is this property in the workspace they are
 * currently acting in". `properties_select` admits every property in every
 * organization the caller has an active membership in — correctly. Someone who
 * runs one business and helps with a second would therefore have the second
 * one's property answer this query, and the wizard would skip the property
 * step for a workspace that has none, then try to hang a unit off a property in
 * the wrong tenant. The insert would be refused by `units_insert` — the tenant
 * boundary holds — but the person would be stuck on a screen that cannot
 * succeed and could not be told why.
 *
 * So the filter is explicit AND the policy still applies underneath. Neither
 * replaces the other: the policy is the security boundary, this is the answer
 * to which workspace we are in.
 *
 * A read failure resolves to "no property yet" rather than throwing. The cost
 * of being wrong in that direction is one extra screen the person can skip;
 * the cost of throwing is an unreachable product for somebody who has no other
 * way in. The write paths do not share this tolerance — a failed insert is
 * always reported.
 */
export async function loadProgress(
  organizationId: string,
): Promise<OnboardingProgress> {
  const supabase = await createClient()

  const { data: properties, error: propertyError } = await supabase
    .from('properties')
    .select('id, name, default_check_in_time, default_check_out_time')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('created_at')
    .limit(1)

  if (propertyError || !properties || properties.length === 0) {
    return { ...NO_WORKSPACE, step: 'property' }
  }

  const property = properties[0]!
  const propertyId = property.id as string

  const { count, error: unitError } = await supabase
    .from('units')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)

  const hasUnit = !unitError && (count ?? 0) > 0

  return {
    step: hasUnit ? 'done' : 'unit',
    propertyId,
    propertyName: (property.name as string | null) ?? null,
    checkInTime: shortTime(property.default_check_in_time),
    checkOutTime: shortTime(property.default_check_out_time),
  }
}

/**
 * `time` comes back as `HH:MM:SS`; `<input type="time">` wants `HH:MM`.
 * Handing the seconds to the control makes it render empty in some browsers,
 * which reads as "no check-in time is set" when one plainly is.
 */
function shortTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}:\d{2})/.exec(value)
  return match ? match[1]! : null
}
