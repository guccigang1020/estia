/**
 * The join that makes a person somebody in this organization: membership,
 * roles, scope — and the personas the switcher offers, derived from the same
 * records rather than declared beside them.
 *
 * ── Why the personas are derived ──────────────────────────────────────────
 *
 * `types.ts` is explicit that a persona whose membership is missing is a
 * broken demo and should fail loudly. The cheapest way to honour that is to
 * make the two impossible to disagree: the memberships below are built by
 * walking `PEOPLE`, and the personas are built by walking the same list and
 * keeping the ones that carry a label. There is no second list to forget.
 *
 * ── Scope is the point, not decoration ────────────────────────────────────
 *
 * Four of the eight personas hold `all_organization` and would be
 * indistinguishable on a scope-blind screen. `property_manager` and the
 * external agent are narrowed to אחוזת רימונים, and the cleaner is narrowed to
 * her team — so switching persona changes which rows exist, not only which
 * buttons are enabled. A demo where every persona sees the same data proves
 * nothing about a model whose whole subject is that they do not.
 */

import type { SystemRole } from '../authz/roles'

import type { DemoPersona, DemoRow } from './types'
import { ID_GROUP, idsFor, momentOn, stampedNoDelete } from './dataset-support'
import {
  ORGANIZATION_ID,
  PEOPLE,
  roleId,
  type DemoPerson,
} from './dataset-identity'
import { PROPERTY_IDS, TEAM_IDS } from './dataset-inventory'

const membershipIds = idsFor(ID_GROUP.membership)
const scopeIds = idsFor(ID_GROUP.membershipScope)

/** A scope row, in the union shape `membership_scopes_shape` enforces. */
type ScopeShape = {
  kind: 'all_organization' | 'properties' | 'units' | 'team' | 'own_records'
  propertyIds?: readonly string[]
  unitIds?: readonly string[]
  teamIds?: readonly string[]
}

const SCOPES: Readonly<Record<string, ScopeShape>> = {
  owner: { kind: 'all_organization' },
  administrator: { kind: 'all_organization' },
  'general-manager': { kind: 'all_organization' },
  'property-manager': {
    kind: 'properties',
    propertyIds: [PROPERTY_IDS.rimonim],
  },
  reception: { kind: 'all_organization' },
  // A cleaner is scoped to her team, which is how `memberships.team_id` and
  // `Scope.team` were designed to be used together. It also means a resource
  // that carries no team — a property, a booking — is out of her reach without
  // any screen having to decide that, which is the privacy rule working.
  housekeeping: { kind: 'team', teamIds: [TEAM_IDS.housekeeping] },
  accountant: { kind: 'all_organization' },
  'sales-agent': { kind: 'properties', propertyIds: [PROPERTY_IDS.rimonim] },
  'second-cleaner': { kind: 'team', teamIds: [TEAM_IDS.housekeeping] },
  maintenance: { kind: 'team', teamIds: [TEAM_IDS.maintenance] },
}

const TEAM_OF: Readonly<Record<string, string | null>> = {
  owner: null,
  administrator: null,
  'general-manager': null,
  'property-manager': null,
  reception: TEAM_IDS.frontDesk,
  housekeeping: TEAM_IDS.housekeeping,
  accountant: null,
  'sales-agent': null,
  'second-cleaner': TEAM_IDS.housekeeping,
  maintenance: TEAM_IDS.maintenance,
}

const DEFAULT_PROPERTY_OF: Readonly<Record<string, string | null>> = {
  owner: null,
  administrator: null,
  'general-manager': null,
  'property-manager': PROPERTY_IDS.rimonim,
  reception: PROPERTY_IDS.rimonim,
  housekeeping: null,
  accountant: null,
  'sales-agent': null,
  'second-cleaner': null,
  maintenance: null,
}

/** How long each person has been here, in days before today. */
const JOINED_DAYS_AGO: Readonly<Record<string, number>> = {
  owner: 420,
  administrator: 360,
  'general-manager': 300,
  'property-manager': 260,
  reception: 190,
  housekeeping: 210,
  accountant: 340,
  'sales-agent': 120,
  'second-cleaner': 70,
  maintenance: 240,
}

function membershipIdFor(entry: DemoPerson): string {
  return membershipIds(PEOPLE.indexOf(entry) + 1)
}

/** `person key → memberships.id`, for the tables that point at a membership. */
export const MEMBERSHIP_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PEOPLE.map((entry) => [entry.key, membershipIdFor(entry)]),
  ),
)

export const MEMBERSHIP_ROWS: DemoRow[] = PEOPLE.map((entry) => {
  const joined = -(JOINED_DAYS_AGO[entry.key] ?? 90)
  return {
    id: MEMBERSHIP_IDS[entry.key],
    user_id: entry.userId,
    organization_id: ORGANIZATION_ID,
    status: 'active',
    // `memberships_joined_when_active`: an active membership must say when it
    // became one. Not a formality — it is what an audit trail dates from.
    joined_at: momentOn(joined, '10:00'),
    invited_by: entry.key === 'owner' ? null : PEOPLE[0].userId,
    last_active_at: momentOn(0, '08:15'),
    default_property_id: DEFAULT_PROPERTY_OF[entry.key] ?? null,
    team_id: TEAM_OF[entry.key] ?? null,
    employment_type: entry.employmentType,
    language: 'he',
    notification_preferences: { email: true, sms: entry.key === 'reception' },
    metadata: {},
    ...stampedNoDelete(entry.key === 'owner' ? null : PEOPLE[0].userId, joined),
  }
})

export const MEMBERSHIP_ROLE_ROWS: DemoRow[] = PEOPLE.map((entry) => ({
  membership_id: MEMBERSHIP_IDS[entry.key],
  organization_id: ORGANIZATION_ID,
  role_id: roleId(entry.role),
  created_at: momentOn(-(JOINED_DAYS_AGO[entry.key] ?? 90), '10:00'),
  created_by: entry.key === 'owner' ? null : PEOPLE[0].userId,
}))

export const MEMBERSHIP_SCOPE_ROWS: DemoRow[] = PEOPLE.map((entry, index) => {
  const scope = SCOPES[entry.key] ?? { kind: 'all_organization' }
  return {
    id: scopeIds(index + 1),
    membership_id: MEMBERSHIP_IDS[entry.key],
    organization_id: ORGANIZATION_ID,
    kind: scope.kind,
    // The check constraint requires each variant to carry exactly its own ids
    // and empty the others. Written out rather than spread, so the shape is
    // visible instead of implied.
    property_ids:
      scope.kind === 'properties' ? [...(scope.propertyIds ?? [])] : [],
    unit_ids: scope.kind === 'units' ? [...(scope.unitIds ?? [])] : [],
    team_ids: scope.kind === 'team' ? [...(scope.teamIds ?? [])] : [],
    ...stampedNoDelete(
      entry.key === 'owner' ? null : PEOPLE[0].userId,
      -(JOINED_DAYS_AGO[entry.key] ?? 90),
    ),
  }
})

/* ----------------------------------------------------------- personas ---- */

/**
 * The people the switcher offers, in the order the tour should walk them.
 *
 * Order matters: it goes from the widest reach to the narrowest, so each step
 * removes something rather than shuffling. The two members without a label —
 * the second cleaner and the handyman — are members, not personas: they exist
 * so assignments and approvals point at real people.
 */
export const DEMO_PERSONAS: readonly DemoPersona[] = PEOPLE.filter(
  (entry) => entry.personaLabel !== null,
).map((entry) => ({
  id: entry.key,
  label: entry.personaLabel as string,
  summary: entry.personaSummary,
  role: entry.role as SystemRole,
  userId: entry.userId,
  fullName: entry.fullName,
  email: entry.email,
}))
