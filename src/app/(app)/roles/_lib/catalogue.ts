/**
 * The roles screen, derived from the catalogue rather than transcribed.
 *
 * ── The property this file exists to have ─────────────────────────────────
 *
 * A permission added to `src/lib/authz/permissions.ts` next year must appear
 * on the roles screen without anybody editing this file. That is not a
 * convenience: `grantsForSystemRole` computes `organization_owner` as *every*
 * non-platform grant and `administrator` as that set minus `OWNER_ONLY`, so a
 * screen carrying its own hand-written list of what an owner may do would
 * start disagreeing with the engine the first time the catalogue grew — and it
 * would disagree silently, in the direction of understating what the two most
 * senior roles can actually do.
 *
 * So nothing below enumerates a permission. The grants come from
 * `grantsForSystemRole`, the *grouping* comes from the grant string's own
 * prefix, and the only hand-written thing is the Hebrew name for each prefix —
 * with `groupLabel` falling back to the prefix itself for one this file has
 * not been taught, exactly as `labelOr` does elsewhere. A new `webhook.*`
 * family therefore renders under `webhook` in English rather than vanishing.
 *
 * ── Twenty roles, or twenty-two ───────────────────────────────────────────
 *
 * `SYSTEM_ROLES` holds twenty roles assignable inside a customer organization.
 * `PLATFORM_ROLES` holds two more — ESTIA's own staff — and
 * `0002_authz.sql` seeds all twenty-two into `public.roles`. Both are shown,
 * and the platform pair is shown as what it is: never assignable in a customer
 * organization, and holding permissions that no customer role can ever carry.
 * Dropping them would describe a database with twenty rows in a table that has
 * twenty-two.
 *
 * ── Pure, and therefore testable without a request ────────────────────────
 *
 * Nothing here reads a row, a cookie or a session. The counts and the groups
 * are functions of the catalogue alone, which is what lets the test beside
 * this file assert the derivation itself rather than a snapshot of today's
 * output.
 */

import {
  FIELD_PERMISSIONS,
  PERMISSIONS,
  SENSITIVE_ACTIONS,
  type Grant,
} from '@/lib/authz/permissions'
import {
  OWNER_ONLY,
  PLATFORM_ROLES,
  SYSTEM_ROLES,
  grantsForSystemRole,
  type PlatformRole,
  type SystemRole,
} from '@/lib/authz/roles'

/* --------------------------------------------------------------- groups -- */

/**
 * The Hebrew name for a grant family, keyed by the prefix before the first dot.
 *
 * Deliberately a partial record and not a total one. A total `Record<Prefix,
 * string>` would need `Prefix` to be derived from the catalogue, which would
 * make adding a permission with a new prefix a type error in this file — the
 * exact coupling the screen is supposed to be free of. The fallback below is
 * the honest behaviour instead.
 */
const GROUP_LABEL: Readonly<Record<string, string>> = {
  organization: 'ארגון',
  property: 'נכסים',
  unit: 'יחידות',
  booking: 'הזמנות',
  availability: 'זמינות',
  hold: 'החזקות',
  guest: 'אורחים',
  lead: 'לידים',
  quote: 'הצעות מחיר',
  finance: 'כספים',
  payment: 'תשלומים',
  deposit: 'פיקדונות',
  expense: 'הוצאות',
  invoice: 'חשבוניות',
  report: 'דוחות',
  user: 'אנשים',
  role: 'תפקידים',
  permission: 'הרשאות',
  team: 'צוותים',
  task: 'משימות',
  checklist: 'צ׳ק-ליסטים',
  inventory: 'מלאי',
  incident: 'תקלות',
  message: 'הודעות',
  template: 'תבניות',
  product: 'מוצרים',
  order: 'הזמנות שירות',
  review: 'ביקורות',
  site: 'אתר',
  pricing: 'תמחור',
  channel: 'ערוצי הפצה',
  owner: 'בעלי נכסים',
  owner_statement: 'דוחות בעלים',
  agent: 'סוכנים',
  agent_agreement: 'הסכמי סוכנים',
  agent_limits: 'תקרות לסוכנים',
  agent_booking: 'הזמנות סוכנים',
  agent_statement: 'דוחות סוכנים',
  agency: 'סוכנויות',
  commission: 'עמלות',
  audit: 'יומן ביקורת',
  approval: 'אישורים',
  automation: 'אוטומציות',
  integration: 'חיבורים',
  platform: 'פלטפורמת ESTIA',
  rate: 'מחירונים',
}

/** The prefix a grant belongs to: everything before the first dot. */
export function groupIdOf(grant: Grant): string {
  const dot = grant.indexOf('.')
  return dot < 0 ? grant : grant.slice(0, dot)
}

/** The Hebrew name for a family, or the family's own id when unknown. */
export function groupLabel(groupId: string): string {
  return GROUP_LABEL[groupId] ?? groupId
}

export type GrantGroup = {
  id: string
  label: string
  grants: readonly Grant[]
}

/**
 * Group a set of grants by family, in the catalogue's declaration order.
 *
 * The order matters and is not alphabetical: `PERMISSIONS` is written in the
 * order a person thinks about the product — organization, then inventory, then
 * bookings, then money — and reproducing that order is what makes a wall of
 * ninety grants readable. Alphabetising it would put `agent.audit.view`
 * between `agency.manage` and `approval.request` and destroy the shape.
 */
export function groupGrants(grants: Iterable<Grant>): readonly GrantGroup[] {
  const held = new Set<Grant>(grants)
  const groups = new Map<string, Grant[]>()

  // `CATALOGUE_ORDER` and not the input, so two roles never present the same
  // family in two different orders.
  for (const grant of CATALOGUE_ORDER) {
    if (!held.has(grant)) continue
    const id = groupIdOf(grant)
    const entries = groups.get(id) ?? []
    entries.push(grant)
    groups.set(id, entries)
  }

  return [...groups].map(([id, entries]) => ({
    id,
    label: groupLabel(id),
    grants: entries,
  }))
}

/** Every grant the engine understands, permissions first, then field rights. */
export const CATALOGUE_ORDER: readonly Grant[] = [
  ...PERMISSIONS,
  ...FIELD_PERMISSIONS,
]

/* ---------------------------------------------------------------- roles -- */

export type RoleProfile = {
  code: SystemRole | PlatformRole
  /** True for the two ESTIA staff roles, which no customer may be given. */
  isPlatform: boolean
  /**
   * True when the role's grants are computed from the whole catalogue rather
   * than listed. `organization_owner` and `administrator` only — and it is
   * shown on screen, because "this role will pick up next year's permission
   * automatically" is the reason a reviewer can trust the other twenty.
   */
  isDerived: boolean
  grants: readonly Grant[]
  grantCount: number
  groups: readonly GrantGroup[]
  /** Grants this role holds that `SENSITIVE_ACTIONS` marks. */
  sensitive: readonly Grant[]
  /** Grants reserved to the owner that this role holds. Empty for nineteen. */
  ownerOnly: readonly Grant[]
}

/**
 * A platform role's grants, which the role catalogue in code does not define.
 *
 * `grantsForSystemRole` has no case for `platform_super_admin` or
 * `platform_support`, and this file does not invent one: `Actor.isPlatformStaff`
 * is the flag the engine actually reads for ESTIA staff, and the two role rows
 * exist so the `roles` table matches the migration. Rendering them with an
 * empty grant list and saying so is the true statement; composing a plausible
 * list would be this screen making up an authorization model.
 */
const PLATFORM_ROLE_SET: ReadonlySet<string> = new Set(PLATFORM_ROLES)

export function isPlatformRole(code: string): code is PlatformRole {
  return PLATFORM_ROLE_SET.has(code)
}

const DERIVED_ROLES: ReadonlySet<string> = new Set([
  'organization_owner',
  'administrator',
])

const SYSTEM_ROLE_SET: ReadonlySet<string> = new Set(SYSTEM_ROLES)

/**
 * Is this a code the catalogue in code actually knows?
 *
 * The screen maps over rows from `public.roles`, and a row's `code` is a
 * `text` column — the catalogue and the table are two artefacts that agree
 * today because two migrations and one TypeScript file were written to match.
 * `grantsForSystemRole` indexes a record by that code, so an unrecognised one
 * would produce `undefined` and the next line would throw on a screen whose
 * whole job is to be readable.
 *
 * So the code is checked rather than asserted, and an unknown one is rendered
 * as a role whose grants this screen cannot state — which is exactly what a
 * customer's own role already renders as. Deny by default applies to knowledge
 * too: "I do not know what this grants" is always available and always true.
 */
export function isKnownRole(code: string): code is SystemRole | PlatformRole {
  return SYSTEM_ROLE_SET.has(code) || PLATFORM_ROLE_SET.has(code)
}

/** The profile for a code off a database row, or `null` when it is unknown. */
export function knownRoleProfile(code: string): RoleProfile | null {
  return isKnownRole(code) ? roleProfile(code) : null
}

/** Everything the screen shows about one role, derived. */
export function roleProfile(code: SystemRole | PlatformRole): RoleProfile {
  if (isPlatformRole(code)) {
    return {
      code,
      isPlatform: true,
      isDerived: false,
      grants: [],
      grantCount: 0,
      groups: [],
      sensitive: [],
      ownerOnly: [],
    }
  }

  const grants = grantsForSystemRole(code)
  const held = new Set<Grant>(grants)

  return {
    code,
    isPlatform: false,
    isDerived: DERIVED_ROLES.has(code),
    grants,
    grantCount: held.size,
    groups: groupGrants(held),
    sensitive: [...SENSITIVE_ACTIONS].filter((grant) => held.has(grant)),
    ownerOnly: OWNER_ONLY.filter((grant) => held.has(grant)),
  }
}

/** The twenty customer roles and the two platform roles, in catalogue order. */
export const ROLE_CODES: readonly (SystemRole | PlatformRole)[] = [
  ...SYSTEM_ROLES,
  ...PLATFORM_ROLES,
]

/**
 * How the owner and the administrator differ, computed rather than asserted.
 *
 * `OWNER_ONLY` is the list, but the list is only half the claim: what matters
 * is that it is *exactly* the difference, so that a permission added next year
 * lands in both roles rather than in neither. Computing the set difference
 * here means the screen states a fact it has just verified, and the test
 * beside this file asserts the same thing from the other direction.
 */
export function ownerAdvantage(): readonly Grant[] {
  const administrator = new Set(grantsForSystemRole('administrator'))
  return grantsForSystemRole('organization_owner').filter(
    (grant) => !administrator.has(grant),
  )
}
