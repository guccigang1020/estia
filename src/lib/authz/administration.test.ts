/**
 * Teams and custom roles, exercised through the real pipeline.
 *
 * Every test runs `defineOperation`'s whole sequence — authorize, validate,
 * load, authorize again, rule, transaction, audit — against the in-memory
 * store, so a refusal asserted here is a refusal that holds on the path the
 * screens take rather than one a helper happens to enforce.
 *
 * The store enforces nothing. If a rule below stopped being written in
 * `administration.ts` these tests would go green against a double that never
 * checked it, so the double is deliberately dumb.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { BusinessRuleError, ValidationError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'
import { InMemoryAdministrationStore } from './administration-store'
import {
  defineCustomRoleOperations,
  defineTeamOperations,
} from './administration'
import { AuthorizationError, type Actor } from './can'
import type { Grant } from './permissions'

const ORG = 'org-a'
const OTHER_ORG = 'org-b'
const NOW = new Date('2026-05-04T08:00:00.000Z')

const TEAM = '11111111-1111-4111-8111-111111111111'
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222'
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333'
const ROLE = '44444444-4444-4444-8444-444444444444'
const SYSTEM_ROLE = '55555555-5555-4555-8555-555555555555'
const PROPERTY = '66666666-6666-4666-8666-666666666666'

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actorWith(
  grants: readonly Grant[],
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

/** Holds team.manage and nothing about people — the operations manager case. */
const teamManager = () => actorWith(['team.manage'])

/** The owner: creates roles, edits their grants, and holds everything. */
const owner = () =>
  actorWith([
    'role.create',
    'permission.edit',
    'team.manage',
    'user.view',
    'user.edit',
    'organization.settings.edit',
    'payment.refund',
    'task.view',
    'task.assign',
    'incident.view',
  ])

let store: InMemoryAdministrationStore
let audit: InMemoryAuditWriter
let teams: ReturnType<typeof defineTeamOperations>
let roles: ReturnType<typeof defineCustomRoleOperations>

beforeEach(() => {
  store = new InMemoryAdministrationStore()
  audit = new InMemoryAuditWriter()
  teams = defineTeamOperations(store)
  roles = defineCustomRoleOperations(store)

  store.seedTeam({ id: TEAM, organizationId: ORG, name: 'משק בית' })
  store.seedTeam({
    id: OTHER_TEAM,
    organizationId: OTHER_ORG,
    name: 'צוות של מישהו אחר',
  })
  store.seedMembership({
    id: MEMBERSHIP,
    organizationId: ORG,
    userId: 'user-2',
    status: 'active',
    teamId: null,
  })
  store.seedRole({
    id: ROLE,
    organizationId: ORG,
    code: 'shift_lead',
    name: 'אחראי משמרת',
    grants: ['task.view'],
  })
  store.seedRole({
    id: SYSTEM_ROLE,
    organizationId: null,
    code: 'cleaner',
    name: 'מנקה',
    isSystem: true,
    grants: ['task.view', 'task.complete'],
  })
})

function services(): OperationServices {
  return {
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    events: new InMemoryEventBus(),
  }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: owner(),
    auditActor: { type: 'user', userId: 'user-1', label: 'שרה לוי' },
    correlationId: 'corr-1',
    now: NOW,
    reason: 'רפורמה במבנה הצוותים',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ teams -- */

describe('creating a team', () => {
  it('creates one, so team-scoped permission finally has something to name', async () => {
    const outcome = await teams.create.run({
      request: { input: { name: 'תחזוקה', kind: 'maintenance' } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(store.teams.get(outcome.data.id)?.name).toBe('תחזוקה')
    expect(store.teams.get(outcome.data.id)?.organizationId).toBe(ORG)
  })

  it('refuses somebody without team.manage', async () => {
    await expect(
      teams.create.run({
        request: { input: { name: 'תחזוקה', kind: 'maintenance' } },
        context: context({ actor: actorWith(['user.view']) }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  /**
   * The reason `create` bothers to load a resource at all. Without it the
   * second `assertCan` never runs and a manager confined to one villa could
   * create a crew inside another one.
   */
  it('refuses a property-scoped manager creating a crew in another property', async () => {
    await expect(
      teams.create.run({
        request: {
          input: {
            name: 'תחזוקה',
            kind: 'maintenance',
            propertyId: PROPERTY,
          },
        },
        context: context({
          actor: actorWith(['team.manage'], {
            scope: { kind: 'properties', propertyIds: ['another-property'] },
          }),
        }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses a name that is not a name', async () => {
    await expect(
      teams.create.run({
        request: { input: { name: 'א', kind: 'other' } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a colour that is not a colour', async () => {
    await expect(
      teams.create.run({
        request: {
          input: { name: 'תחזוקה', kind: 'other', color: 'ירוק' },
        },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('records one audit event naming the team', async () => {
    await teams.create.run({
      request: { input: { name: 'קבלה', kind: 'front_desk' } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain('קבלה')
  })
})

describe('renaming a team', () => {
  it('renames it', async () => {
    await teams.rename.run({
      request: {
        input: { teamId: TEAM, name: 'משק בית ראשי' },
        expectedVersion: 1,
      },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(store.teams.get(TEAM)?.name).toBe('משק בית ראשי')
  })

  it('refuses without the version the caller believes they are editing', async () => {
    await expect(
      teams.rename.run({
        request: { input: { teamId: TEAM, name: 'משק בית ראשי' } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a team belonging to another organization', async () => {
    await expect(
      teams.rename.run({
        request: {
          input: { teamId: OTHER_TEAM, name: 'שלי עכשיו' },
          expectedVersion: 1,
        },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toThrow()
  })

  it('refuses an archived team', async () => {
    store.seedTeam({
      id: TEAM,
      organizationId: ORG,
      name: 'משק בית',
      archivedAt: NOW.toISOString(),
    })

    await expect(
      teams.rename.run({
        request: {
          input: { teamId: TEAM, name: 'משק בית ראשי' },
          expectedVersion: 1,
        },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('archiving a team', () => {
  it('archives an empty one', async () => {
    await teams.archive.run({
      request: { input: { teamId: TEAM } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(store.teams.get(TEAM)?.archivedAt).toBe(NOW.toISOString())
  })

  it('refuses while somebody is still in it', async () => {
    store.seedMembership({
      id: MEMBERSHIP,
      organizationId: ORG,
      userId: 'user-2',
      status: 'active',
      teamId: TEAM,
    })

    await expect(
      teams.archive.run({
        request: { input: { teamId: TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  /**
   * A membership whose SCOPE is the team is the sharper case: archiving under
   * them leaves a live scope pointing at a dead row, and the roster then shows
   * a reach that names nothing.
   */
  it('refuses while a membership scope is defined by it', async () => {
    store.teamScopes.set(TEAM, 1)

    await expect(
      teams.archive.run({
        request: { input: { teamId: TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a second time', async () => {
    await teams.archive.run({
      request: { input: { teamId: TEAM } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    await expect(
      teams.archive.run({
        request: { input: { teamId: TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('putting somebody in a team', () => {
  it('is team.manage and not user.edit', async () => {
    await teams.assignMember.run({
      request: { input: { membershipId: MEMBERSHIP, teamId: TEAM } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(store.memberships.get(MEMBERSHIP)?.teamId).toBe(TEAM)
  })

  it('takes somebody out of every team when the team is null', async () => {
    store.seedMembership({
      id: MEMBERSHIP,
      organizationId: ORG,
      userId: 'user-2',
      status: 'active',
      teamId: TEAM,
    })

    await teams.assignMember.run({
      request: { input: { membershipId: MEMBERSHIP, teamId: null } },
      context: context({ actor: teamManager() }),
      services: services(),
    })

    expect(store.memberships.get(MEMBERSHIP)?.teamId).toBeNull()
  })

  it('refuses somebody without team.manage', async () => {
    await expect(
      teams.assignMember.run({
        request: { input: { membershipId: MEMBERSHIP, teamId: TEAM } },
        context: context({ actor: actorWith(['user.edit', 'user.view']) }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses a team in another organization', async () => {
    await expect(
      teams.assignMember.run({
        request: { input: { membershipId: MEMBERSHIP, teamId: OTHER_TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses an archived team, which is how an archive refills', async () => {
    store.seedTeam({
      id: TEAM,
      organizationId: ORG,
      name: 'משק בית',
      archivedAt: NOW.toISOString(),
    })

    await expect(
      teams.assignMember.run({
        request: { input: { membershipId: MEMBERSHIP, teamId: TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a membership that was removed from the organization', async () => {
    store.seedMembership({
      id: MEMBERSHIP,
      organizationId: ORG,
      userId: 'user-2',
      status: 'removed',
      teamId: null,
    })

    await expect(
      teams.assignMember.run({
        request: { input: { membershipId: MEMBERSHIP, teamId: TEAM } },
        context: context({ actor: teamManager() }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

/* ------------------------------------------------------------ custom roles -- */

describe('the plan gate on custom roles', () => {
  /**
   * `ENTITLEMENT_FOR_GRANT` maps `role.create` to `custom_roles`, so this
   * refusal comes out of `authorize()` rather than out of this module — which
   * is what lets the screen tell the difference between "ask an administrator"
   * and "this is not in your package".
   */
  it('refuses a business whose package does not include it', async () => {
    const withoutFeature = actorWith(['role.create', 'permission.edit'], {
      entitlements: new Set<Entitlement>(['team']),
    })

    try {
      await roles.create.run({
        request: {
          input: { code: 'shift_lead', name: 'אחראי משמרת', grants: [] },
        },
        context: context({ actor: withoutFeature }),
        services: services(),
      })
      throw new Error('a role was created without the entitlement')
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError)
      expect((error as AuthorizationError).decision.reason).toBe(
        'plan_does_not_include',
      )
    }
  })
})

describe('creating a custom role', () => {
  it('creates one with the grants it was given', async () => {
    const outcome = await roles.create.run({
      request: {
        input: {
          code: 'night_lead',
          name: 'אחראי לילה',
          grants: ['task.view', 'incident.view'],
        },
      },
      context: context(),
      services: services(),
    })

    expect(store.roles.get(outcome.data.id)?.grants).toEqual([
      'task.view',
      'incident.view',
    ])
  })

  /**
   * THE ESCALATION TEST. Somebody who may edit role grants and does not hold
   * `organization.settings.edit` must not be able to mint a role carrying it.
   * `tg_role_permission_within_reach` in 0069 refuses the same write at the
   * database, independently.
   */
  it('refuses a role carrying a grant its author does not hold', async () => {
    const editor = actorWith(['role.create', 'permission.edit', 'task.view'])

    try {
      await roles.create.run({
        request: {
          input: {
            code: 'night_lead',
            name: 'אחראי לילה',
            grants: ['task.view', 'organization.settings.edit'],
          },
        },
        context: context({ actor: editor }),
        services: services(),
      })
      throw new Error('the role was minted with a grant its author lacked')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect((error as BusinessRuleError).code).toBe('beyond_author')
      expect((error as BusinessRuleError).userMessage).toContain(
        'organization.settings.edit',
      )
    }

    expect(store.roles.size).toBe(2)
  })

  it('refuses a platform grant', async () => {
    await expect(
      roles.create.run({
        request: {
          input: {
            code: 'night_lead',
            name: 'אחראי לילה',
            grants: ['platform.impersonate'],
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a grant string the catalogue has never heard of', async () => {
    await expect(
      roles.create.run({
        request: {
          input: {
            code: 'night_lead',
            name: 'אחראי לילה',
            grants: ['booking.do_anything'],
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  /**
   * Writing the grants is `permission.edit`, which `role_permissions_insert`
   * demands and which is owner-only in the shipped catalogue. Creating the
   * empty role row is `role.create`. The two are separable and are separated.
   */
  it('refuses grants from somebody holding role.create alone', async () => {
    await expect(
      roles.create.run({
        request: {
          input: {
            code: 'night_lead',
            name: 'אחראי לילה',
            grants: ['task.view'],
          },
        },
        context: context({ actor: actorWith(['role.create', 'task.view']) }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('admits an empty role from somebody holding role.create alone', async () => {
    const outcome = await roles.create.run({
      request: {
        input: { code: 'night_lead', name: 'אחראי לילה', grants: [] },
      },
      context: context({ actor: actorWith(['role.create']) }),
      services: services(),
    })

    expect(store.roles.get(outcome.data.id)?.grants).toEqual([])
  })

  it('refuses a code already used in this organization', async () => {
    await expect(
      roles.create.run({
        request: {
          input: { code: 'shift_lead', name: 'עוד אחד', grants: [] },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a code that shadows a role ESTIA ships with', async () => {
    await expect(
      roles.create.run({
        request: {
          input: { code: 'cleaner', name: 'המנקה שלי', grants: [] },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a code that is not a code', async () => {
    await expect(
      roles.create.run({
        request: {
          input: { code: 'אחראי משמרת', name: 'אחראי משמרת', grants: [] },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('setting a role permissions', () => {
  it('replaces the whole set', async () => {
    await roles.setPermissions.run({
      request: {
        input: { roleId: ROLE, grants: ['incident.view', 'task.assign'] },
      },
      context: context(),
      services: services(),
    })

    expect(store.roles.get(ROLE)?.grants).toEqual([
      'incident.view',
      'task.assign',
    ])
  })

  it('refuses the escalation on an existing role too', async () => {
    const editor = actorWith(['permission.edit', 'task.view'])

    await expect(
      roles.setPermissions.run({
        request: {
          input: { roleId: ROLE, grants: ['task.view', 'payment.refund'] },
        },
        context: context({ actor: editor }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(store.roles.get(ROLE)?.grants).toEqual(['task.view'])
  })

  /**
   * `permission.edit` is in `SENSITIVE_ACTIONS`, so the pipeline demands a
   * stated reason without this module asking for one.
   */
  it('demands a stated reason', async () => {
    await expect(
      roles.setPermissions.run({
        request: { input: { roleId: ROLE, grants: ['task.view'] } },
        context: context({ reason: null }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a system role, whose grants live in code', async () => {
    try {
      await roles.setPermissions.run({
        request: { input: { roleId: SYSTEM_ROLE, grants: ['task.view'] } },
        context: context(),
        services: services(),
      })
      throw new Error('a system role was edited')
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect((error as BusinessRuleError).code).toBe('role_is_system')
    }

    expect(store.roles.get(SYSTEM_ROLE)?.grants).toEqual([
      'task.view',
      'task.complete',
    ])
  })

  it('refuses somebody holding role.create but not permission.edit', async () => {
    await expect(
      roles.setPermissions.run({
        request: { input: { roleId: ROLE, grants: ['task.view'] } },
        context: context({ actor: actorWith(['role.create', 'task.view']) }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('summarises the change as a difference, not as a wall of codes', async () => {
    await roles.setPermissions.run({
      request: {
        input: { roleId: ROLE, grants: ['incident.view', 'task.assign'] },
      },
      context: context(),
      services: services(),
    })

    expect(audit.records[0].summary).toContain('2 נוספו')
    expect(audit.records[0].summary).toContain('1 הוסרו')
  })
})

describe('deleting a custom role', () => {
  it('deletes one nobody holds', async () => {
    await roles.remove.run({
      request: { input: { roleId: ROLE } },
      context: context(),
      services: services(),
    })

    expect(store.roles.has(ROLE)).toBe(false)
  })

  it('demands a stated reason, because it takes authority away', async () => {
    await expect(
      roles.remove.run({
        request: { input: { roleId: ROLE } },
        context: context({ reason: null }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a system role', async () => {
    await expect(
      roles.remove.run({
        request: { input: { roleId: SYSTEM_ROLE } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(store.roles.has(SYSTEM_ROLE)).toBe(true)
  })

  it('refuses while somebody still holds it', async () => {
    store.seedRole({
      id: ROLE,
      organizationId: ORG,
      code: 'shift_lead',
      name: 'אחראי משמרת',
      grants: ['task.view'],
      holderCount: 2,
    })

    await expect(
      roles.remove.run({
        request: { input: { roleId: ROLE } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses while a live invitation names it', async () => {
    store.invitations.set(ROLE, 1)

    await expect(
      roles.remove.run({
        request: { input: { roleId: ROLE } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a role belonging to another organization', async () => {
    store.seedRole({
      id: ROLE,
      organizationId: OTHER_ORG,
      code: 'shift_lead',
      name: 'אחראי משמרת',
    })

    await expect(
      roles.remove.run({
        request: { input: { roleId: ROLE } },
        context: context(),
        services: services(),
      }),
    ).rejects.toThrow()

    expect(store.roles.has(ROLE)).toBe(true)
  })
})
