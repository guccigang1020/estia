/**
 * EXECUTION CONTEXT — SERVER ONLY. Writing to the two tables that had no
 * writer: `public.teams` and the customer half of `public.roles`.
 *
 * ── What was missing, precisely ───────────────────────────────────────────
 *
 * `teams` has existed since 0008. `memberships.team_id` points at it, and the
 * `team` variant of `membership_scopes` points at it, so team-scoped
 * permission has been expressible in the schema and unreachable in the
 * product: to scope somebody to a team you first need a team, and nothing
 * could make one.
 *
 * `roles` had the customer-side twin of that hole. `roles_insert` has always
 * admitted a custom role, `custom_roles` is sold in the Management plan, and
 * no code path ever wrote one — a paid feature with nothing behind it.
 *
 * ── Seven operations, and the permission on each is the policy's own ──────
 *
 *   team.create · team.rename · team.archive · team.assignMember  → team.manage
 *   role.create · role.delete                                     → role.create
 *   role.setPermissions                                           → permission.edit
 *
 * Those are not chosen here. They are read off `0004_rls.sql` and
 * `0008_accommodation.sql`, so the service floor and the database floor refuse
 * the same person for the same reason. An operation declaring a grant the
 * policy does not honour would produce a screen that offers a button and a
 * database that refuses it, which is worse than no button.
 *
 * `permission.edit` is in `SENSITIVE_ACTIONS`, so `setPermissions` demands a
 * stated reason without this file asking for one. That is the pipeline's
 * default doing exactly what it is for.
 *
 * ── The escalation rule ───────────────────────────────────────────────────
 *
 * `assertGrantable` — see `grantable.ts` — refuses any grant the author does
 * not hold, on create and on every subsequent edit. The database refuses the
 * same thing independently in `tg_role_permission_within_reach` (0069). Read
 * either file for the argument; the short version is that `permission.edit` is
 * itself grantable, so the person editing role grants is not necessarily the
 * owner and must not be able to write themselves a promotion.
 *
 * ── A system role is not editable here or anywhere ────────────────────────
 *
 * Every load below refuses `isSystem`. The grants of a system role do not live
 * in `role_permissions` at all — `grantsForSystemRole()` derives them, and
 * `organization_owner` is *computed* as the whole non-platform catalogue — so
 * an operation that edited the row would change a label and leave the
 * authority untouched. The screen would then be lying in the most dangerous
 * possible direction.
 */

import { assertCan } from './can'
import { assertGrantable } from './grantable'
import type { Grant } from './permissions'
import { TEAM_KINDS, type TeamKind } from './team-kind'
import { BusinessRuleError } from '../errors'
import { defineOperation, s, type Operation } from '../service'

/* ----------------------------------------------------------------- shape -- */

/**
 * `public.team_kind` lives in `team-kind.ts` and is re-exported here so a
 * server-side reader of this module has it to hand.
 *
 * A browser must import the leaf directly. The crews panel is a Client
 * Component, and reaching the enum through this file would pull the whole
 * service pipeline — `defineOperation`, the schema validator, the error
 * taxonomy — into the bundle to draw six options. That is the failure
 * `scripts/client-bundle.mjs` exists to catch.
 */
export { TEAM_KINDS, type TeamKind }

export type TeamRecord = {
  id: string
  organizationId: string
  /** The property this crew works at, or null for an organization-wide team. */
  propertyId: string | null
  name: string
  description: string | null
  kind: TeamKind
  /** `#RRGGBB` or null — `teams_color_format` refuses anything else. */
  color: string | null
  /** ISO 8601 when the team was archived. Archiving is a soft delete. */
  archivedAt: string | null
  version: number
}

/**
 * What still points at a team.
 *
 * Both counts exist because both are reasons not to archive, and they are
 * different problems for the reader: people in a crew have to be moved, while
 * a membership *scoped* to the team is somebody whose whole reach is defined
 * by it and who would silently keep that reach against an archived row.
 */
export type TeamUsage = {
  memberCount: number
  scopeCount: number
}

export type MembershipRecord = {
  id: string
  organizationId: string
  userId: string
  status: string
  teamId: string | null
}

export type RoleRecord = {
  id: string
  /** Null for a role ESTIA ships with. Never editable — see the header. */
  organizationId: string | null
  code: string
  name: string
  description: string | null
  isSystem: boolean
  isPlatform: boolean
  grants: readonly Grant[]
  holderCount: number
  version: number
}

/* ------------------------------------------------------------------ port -- */

/**
 * The rows these operations need, declared as a port.
 *
 * Two implementations: `SupabaseAdministrationStore` for the request path and
 * `InMemoryAdministrationStore` for the tests, so every refusal below is
 * asserted through the real pipeline without a database. `tx` is the open
 * transaction and is passed to every write; the in-memory double ignores it.
 */
export interface AdministrationStore {
  loadTeam(organizationId: string, teamId: string): Promise<TeamRecord | null>
  teamUsage(organizationId: string, teamId: string): Promise<TeamUsage>
  createTeam(
    input: {
      organizationId: string
      name: string
      kind: TeamKind
      propertyId: string | null
      description: string | null
      color: string | null
      createdBy: string
    },
    tx: unknown,
  ): Promise<{ id: string }>
  renameTeam(
    input: {
      organizationId: string
      teamId: string
      name: string
      description: string | null
      color: string | null
      updatedBy: string
    },
    tx: unknown,
  ): Promise<void>
  archiveTeam(
    input: {
      organizationId: string
      teamId: string
      archivedAt: Date
      archivedBy: string
    },
    tx: unknown,
  ): Promise<void>

  loadMembership(
    organizationId: string,
    membershipId: string,
  ): Promise<MembershipRecord | null>
  /** Goes through `assign_membership_to_team` — see 0069 for why. */
  assignMembershipToTeam(
    membershipId: string,
    teamId: string | null,
    tx: unknown,
  ): Promise<void>

  loadRole(organizationId: string, roleId: string): Promise<RoleRecord | null>
  /** Whether this organization already has a role with this code. */
  roleCodeTaken(organizationId: string, code: string): Promise<boolean>
  createRole(
    input: {
      organizationId: string
      code: string
      name: string
      description: string | null
      grants: readonly Grant[]
      createdBy: string
    },
    tx: unknown,
  ): Promise<{ id: string }>
  replaceRoleGrants(
    input: { roleId: string; grants: readonly Grant[]; updatedBy: string },
    tx: unknown,
  ): Promise<void>
  deleteRole(
    input: { organizationId: string; roleId: string },
    tx: unknown,
  ): Promise<void>
  /** Live invitations naming this role. The foreign key is ON DELETE RESTRICT. */
  openInvitationCount(organizationId: string, roleId: string): Promise<number>
}

/* --------------------------------------------------------------- schemas -- */

/**
 * Two characters is a real name in Hebrew — "מ1" is a crew somebody labelled —
 * and forty is the width the roster column can show without wrapping.
 */
const TEAM_NAME = s.string({ label: 'שם הצוות', min: 2, max: 40 })

const HEX_COLOUR = s.string({
  label: 'צבע',
  pattern: /^#[0-9A-Fa-f]{6}$/,
  patternMessage: 'צבע נכתב כשישה תווים אחרי סולמית, למשל #2F6F4E.',
})

const CREATE_TEAM_INPUT = s.object({
  name: TEAM_NAME,
  kind: s.enumOf(TEAM_KINDS, { label: 'סוג הצוות' }),
  propertyId: s.optional(s.uuid({ label: 'נכס' })),
  description: s.optional(s.string({ label: 'תיאור', max: 280 })),
  color: s.optional(HEX_COLOUR),
})

const RENAME_TEAM_INPUT = s.object({
  teamId: s.uuid({ label: 'צוות' }),
  name: TEAM_NAME,
  description: s.optional(s.string({ label: 'תיאור', max: 280 })),
  color: s.optional(HEX_COLOUR),
})

const ARCHIVE_TEAM_INPUT = s.object({
  teamId: s.uuid({ label: 'צוות' }),
})

/**
 * `teamId` is `nullable`, not `optional`, and the difference is the feature:
 * `null` means "take this person out of every team", while an absent key would
 * mean "I did not mention the team" — which is not something this operation
 * can be asked.
 */
const ASSIGN_MEMBER_INPUT = s.object({
  membershipId: s.uuid({ label: 'חבר צוות' }),
  teamId: s.nullable(s.uuid({ label: 'צוות' })),
})

/**
 * The code is Latin, lowercase and snake_case, and that is not a style rule:
 * it is the string `roles_custom_organization_key` is unique on and the one a
 * reviewer greps for. The Hebrew name is the `name` column beside it.
 */
const ROLE_CODE = s.string({
  label: 'מזהה התפקיד',
  min: 3,
  max: 40,
  pattern: /^[a-z][a-z0-9_]*$/,
  patternMessage:
    'מזהה מורכב מאותיות לטיניות קטנות, ספרות וקו תחתון, ומתחיל באות.',
})

const GRANT_LIST = s.arrayOf(s.string({ label: 'הרשאה', min: 1, max: 64 }), {
  label: 'הרשאות',
  max: 200,
})

const CREATE_ROLE_INPUT = s.object({
  code: ROLE_CODE,
  name: s.string({ label: 'שם התפקיד', min: 2, max: 60 }),
  description: s.optional(s.string({ label: 'תיאור', max: 280 })),
  grants: GRANT_LIST,
})

const SET_PERMISSIONS_INPUT = s.object({
  roleId: s.uuid({ label: 'תפקיד' }),
  grants: GRANT_LIST,
})

const DELETE_ROLE_INPUT = s.object({
  roleId: s.uuid({ label: 'תפקיד' }),
})

/* ------------------------------------------------------------ operations -- */

export type CreateTeamInput = {
  name: string
  kind: TeamKind
  propertyId?: string
  description?: string
  color?: string
}

export type RenameTeamInput = {
  teamId: string
  name: string
  description?: string
  color?: string
}

export interface TeamOperations {
  create: Operation<CreateTeamInput, null, { id: string }>
  rename: Operation<RenameTeamInput, TeamRecord, { id: string }>
  archive: Operation<{ teamId: string }, TeamRecord, { id: string }>
  assignMember: Operation<
    { membershipId: string; teamId: string | null },
    MembershipRecord,
    { membershipId: string; teamId: string | null }
  >
}

/** Absent and blank both mean "not given". An empty string is not a value. */
function orNull(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function defineTeamOperations(
  store: AdministrationStore,
): TeamOperations {
  const loadTeam = async ({
    input,
    context,
  }: {
    input: { teamId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const team = await store.loadTeam(
      context.actor.organizationId,
      input.teamId,
    )
    if (team === null) return null
    return {
      resource: {
        organizationId: team.organizationId,
        // A team attached to a property is located in it, so a property-scoped
        // manager reaches their own crews and not the villa next door. An
        // organization-wide team carries no location and is therefore only
        // reachable by an organization-wide scope — `scopeReaches` denying by
        // default is the wanted answer here, not an accident.
        ...(team.propertyId === null ? {} : { propertyId: team.propertyId }),
        family: 'team' as const,
      },
      entity: team,
      version: team.version,
    }
  }

  const create = defineOperation<CreateTeamInput, null, { id: string }>({
    name: 'team.create',
    permission: 'team.manage',
    resourceType: 'team',
    input: CREATE_TEAM_INPUT,

    // A create still loads a resource, because the scope question is about
    // where the team will live and can be answered before it exists. Without
    // this the second `assertCan` never runs and a property-scoped manager
    // could create a crew inside a property they cannot see.
    async loadResource({ input, context }) {
      return {
        resource: {
          organizationId: context.actor.organizationId,
          ...(input.propertyId === undefined
            ? {}
            : { propertyId: input.propertyId }),
          family: 'team' as const,
        },
        entity: null,
      }
    },

    async execute({ input, context, tx }) {
      return store.createTeam(
        {
          organizationId: context.actor.organizationId,
          name: input.name,
          kind: input.kind,
          propertyId: input.propertyId ?? null,
          description: orNull(input.description),
          color: orNull(input.color),
          createdBy: context.actor.userId,
        },
        tx,
      )
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `יצר את הצוות ״${input.name}״.`,
        after: { name: input.name, kind: input.kind },
      }
    },
  })

  const rename = defineOperation<RenameTeamInput, TeamRecord, { id: string }>({
    name: 'team.rename',
    permission: 'team.manage',
    resourceType: 'team',
    input: RENAME_TEAM_INPUT,
    // `teams.version` is a real column maintained by `teams_touch`, so the
    // caller can and must say which version they edited. Two supervisors
    // renaming the same crew is not hypothetical on a shared screen.
    requiresVersion: true,
    loadResource: loadTeam,

    rule({ entity }) {
      if (entity.archivedAt !== null) {
        throw new BusinessRuleError({
          code: 'team_archived',
          message: `team ${entity.id} is archived`,
          userMessage:
            'הצוות בארכיון. אי אפשר לערוך צוות שהוצא משימוש — צור צוות חדש במקומו.',
        })
      }
    },

    async execute({ input, context, tx }) {
      await store.renameTeam(
        {
          organizationId: context.actor.organizationId,
          teamId: input.teamId,
          name: input.name,
          description: orNull(input.description),
          color: orNull(input.color),
          updatedBy: context.actor.userId,
        },
        tx,
      )
      return { id: input.teamId }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary:
          entity.name === input.name
            ? `עדכן את פרטי הצוות ״${entity.name}״.`
            : `שינה את שם הצוות מ״${entity.name}״ ל״${input.name}״.`,
        before: { name: entity.name, description: entity.description },
        after: { name: input.name, description: orNull(input.description) },
      }
    },
  })

  const archive = defineOperation<
    { teamId: string },
    TeamRecord,
    { id: string }
  >({
    name: 'team.archive',
    permission: 'team.manage',
    resourceType: 'team',
    input: ARCHIVE_TEAM_INPUT,
    loadResource: loadTeam,

    /**
     * Archiving is a soft delete, and it is refused while anything still
     * points at the team.
     *
     * 0008 guards the hard DELETE with `tg_guard_scope_references` and
     * deliberately leaves the soft one alone — archiving a property must not
     * require unpicking everybody's scope first. For a team the calculus is
     * the other way round: a membership *scoped* to a team is a person whose
     * entire reach is that team, and letting the team be archived under them
     * leaves a live scope pointing at a dead row, which reads on the roster as
     * a scope naming nothing. So it is refused, and the refusal says what to
     * do instead.
     */
    async rule({ entity, context }) {
      if (entity.archivedAt !== null) {
        throw new BusinessRuleError({
          code: 'team_already_archived',
          message: `team ${entity.id} is already archived`,
          userMessage: 'הצוות כבר בארכיון.',
        })
      }

      const usage = await store.teamUsage(
        context.actor.organizationId,
        entity.id,
      )

      if (usage.memberCount > 0) {
        throw new BusinessRuleError({
          code: 'team_still_staffed',
          message: `team ${entity.id} still has ${usage.memberCount} members`,
          userMessage:
            usage.memberCount === 1
              ? 'אדם אחד עדיין משויך לצוות. העבר אותו לצוות אחר לפני ההוצאה לארכיון.'
              : `${usage.memberCount} אנשים עדיין משויכים לצוות. העבר אותם לצוות אחר לפני ההוצאה לארכיון.`,
        })
      }

      if (usage.scopeCount > 0) {
        throw new BusinessRuleError({
          code: 'team_still_scoped',
          message: `team ${entity.id} is named by ${usage.scopeCount} scopes`,
          userMessage:
            'הטווח של מישהו בארגון מוגדר לפי הצוות הזה. שנה את הטווח שלו לפני ההוצאה לארכיון, אחרת הוא יישאר עם טווח שאינו מצביע על דבר.',
        })
      }
    },

    async execute({ input, context, tx, now }) {
      await store.archiveTeam(
        {
          organizationId: context.actor.organizationId,
          teamId: input.teamId,
          archivedAt: now,
          archivedBy: context.actor.userId,
        },
        tx,
      )
      return { id: input.teamId }
    },

    audit({ entity, now }) {
      return {
        resourceId: entity.id,
        summary: `הוציא את הצוות ״${entity.name}״ לארכיון.`,
        before: { archivedAt: null },
        after: { archivedAt: now.toISOString() },
      }
    },
  })

  const assignMember = defineOperation<
    { membershipId: string; teamId: string | null },
    MembershipRecord,
    { membershipId: string; teamId: string | null }
  >({
    name: 'team.assign_member',
    // `team.manage`, not `user.edit`. The database agrees through
    // `assign_membership_to_team` (0069), which is the only reason this is
    // possible without widening `memberships_update` — read the argument
    // there.
    permission: 'team.manage',
    resourceType: 'membership',
    input: ASSIGN_MEMBER_INPUT,

    async loadResource({ input, context }) {
      const membership = await store.loadMembership(
        context.actor.organizationId,
        input.membershipId,
      )
      if (membership === null) return null
      return {
        resource: {
          organizationId: membership.organizationId,
          // A person is not located in a property — `queries.ts` on the roster
          // makes the same argument — so this carries no location and only an
          // organization-wide scope reaches it. That is stricter than the
          // roster, which is a read; moving somebody between crews is a write.
          family: 'team' as const,
        },
        entity: membership,
      }
    },

    async rule({ entity, input, context }) {
      if (entity.status === 'removed') {
        throw new BusinessRuleError({
          code: 'membership_removed',
          message: `membership ${entity.id} was removed`,
          userMessage:
            'האדם הזה הוסר מהארגון. השיוך לצוות לא ישנה דבר עבורו, ולכן הוא נדחה.',
        })
      }

      if (input.teamId === null) return

      const team = await store.loadTeam(
        context.actor.organizationId,
        input.teamId,
      )

      if (team === null) {
        throw new BusinessRuleError({
          code: 'team_not_found',
          message: `team ${input.teamId} is not in this organization`,
          userMessage: 'הצוות שנבחר אינו קיים בארגון הזה.',
        })
      }

      if (team.archivedAt !== null) {
        throw new BusinessRuleError({
          code: 'team_archived',
          message: `team ${team.id} is archived`,
          userMessage:
            'הצוות בארכיון, ולכן אי אפשר לשייך אליו אנשים. זו הדרך שבה ארכיון מתמלא בחזרה.',
        })
      }
    },

    async execute({ input, tx }) {
      await store.assignMembershipToTeam(input.membershipId, input.teamId, tx)
      return { membershipId: input.membershipId, teamId: input.teamId }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary:
          input.teamId === null
            ? 'הוציא חבר צוות מהצוות שלו.'
            : 'שייך חבר צוות לצוות.',
        before: { teamId: entity.teamId },
        after: { teamId: input.teamId },
      }
    },
  })

  return { create, rename, archive, assignMember }
}

/* ------------------------------------------------------------ custom roles -- */

export type CreateRoleInput = {
  code: string
  name: string
  description?: string
  grants: readonly string[]
}

export interface CustomRoleOperations {
  create: Operation<CreateRoleInput, null, { id: string }>
  setPermissions: Operation<
    { roleId: string; grants: readonly string[] },
    RoleRecord,
    { id: string; grantCount: number }
  >
  remove: Operation<{ roleId: string }, RoleRecord, { id: string }>
}

/**
 * Refuse a role this product does not consider a customer's to edit.
 *
 * Written once because three operations need the same three refusals, and
 * because "which roles are editable" is exactly the kind of rule that grows a
 * second, slightly different copy.
 */
function assertEditableRole(role: RoleRecord): void {
  if (role.isSystem || role.organizationId === null) {
    throw new BusinessRuleError({
      code: 'role_is_system',
      message: `role ${role.id} is a system role`,
      userMessage:
        'זהו תפקיד שמגיע עם המערכת. ההרשאות שלו נגזרות מהקטלוג שבקוד ואינן יושבות בטבלה, ולכן אי אפשר לערוך או למחוק אותו — אפשר ליצור לצידו תפקיד מותאם.',
    })
  }

  if (role.isPlatform) {
    throw new BusinessRuleError({
      code: 'role_is_platform',
      message: `role ${role.id} is a platform role`,
      userMessage: 'זהו תפקיד של צוות ESTIA ואינו נערך מתוך ארגון של לקוח.',
    })
  }
}

export function defineCustomRoleOperations(
  store: AdministrationStore,
): CustomRoleOperations {
  const loadRole = async ({
    input,
    context,
  }: {
    input: { roleId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const role = await store.loadRole(
      context.actor.organizationId,
      input.roleId,
    )
    if (role === null) return null
    return {
      resource: {
        organizationId: context.actor.organizationId,
        family: 'team' as const,
      },
      entity: role,
      version: role.version,
    }
  }

  const create = defineOperation<CreateRoleInput, null, { id: string }>({
    name: 'role.create',
    // Matches `roles_insert`. The plan gate rides along for free:
    // `ENTITLEMENT_FOR_GRANT` maps `role.create` to `custom_roles`, so a
    // business without the feature is refused by `authorize()` with
    // `plan_does_not_include` rather than `missing_permission` — which is what
    // lets the screen show the upgrade argument instead of a broken button.
    permission: 'role.create',
    resourceType: 'role',
    input: CREATE_ROLE_INPUT,

    async loadResource({ context }) {
      return {
        resource: {
          organizationId: context.actor.organizationId,
          family: 'team' as const,
        },
        entity: null,
      }
    },

    async rule({ input, context }) {
      // Writing the grants is `permission.edit`, which is a strictly higher
      // authority than creating the role row — `role_permissions_insert` says
      // so, and it is owner-only in the shipped catalogue. Asserted only when
      // there are grants to write, so somebody holding `role.create` alone can
      // still draft the empty role and hand the permissions question on.
      if (input.grants.length > 0) {
        assertCan(context.actor, 'permission.edit', {
          organizationId: context.actor.organizationId,
          family: 'team',
        })
        assertGrantable(context.actor, input.grants)
      }

      if (await store.roleCodeTaken(context.actor.organizationId, input.code)) {
        throw new BusinessRuleError({
          code: 'role_code_taken',
          message: `role code ${input.code} already exists`,
          userMessage: `כבר קיים תפקיד עם המזהה ״${input.code}״. בחר מזהה אחר.`,
        })
      }
    },

    async execute({ input, context, tx }) {
      return store.createRole(
        {
          organizationId: context.actor.organizationId,
          code: input.code,
          name: input.name,
          description: orNull(input.description),
          grants: input.grants as readonly Grant[],
          createdBy: context.actor.userId,
        },
        tx,
      )
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary:
          input.grants.length === 0
            ? `יצר תפקיד מותאם ״${input.name}״ ללא הרשאות.`
            : `יצר תפקיד מותאם ״${input.name}״ עם ${input.grants.length} הרשאות.`,
        after: { code: input.code, grants: [...input.grants] },
      }
    },
  })

  const setPermissions = defineOperation<
    { roleId: string; grants: readonly string[] },
    RoleRecord,
    { id: string; grantCount: number }
  >({
    name: 'role.set_permissions',
    // `permission.edit` is in `SENSITIVE_ACTIONS`, so the pipeline demands a
    // stated reason here without this file asking for one.
    permission: 'permission.edit',
    resourceType: 'role',
    input: SET_PERMISSIONS_INPUT,
    /*
     * Deliberately NOT `requiresVersion`.
     *
     * `roles.version` is bumped by `roles_touch` on an UPDATE of the role row,
     * and this operation writes `role_permissions` — a child table with no
     * version of its own. Demanding the parent's version would look like
     * optimistic locking and lock nothing: two editors would both read version
     * 1, both pass, and the second replace would win. A guarantee that does
     * not hold is worse than an absent one, so the honest position is that the
     * last write wins and the audit trail records both, each with its reason.
     */
    loadResource: loadRole,

    rule({ entity, input, context }) {
      assertEditableRole(entity)
      assertGrantable(context.actor, input.grants)
    },

    async execute({ input, context, tx }) {
      await store.replaceRoleGrants(
        {
          roleId: input.roleId,
          grants: input.grants as readonly Grant[],
          updatedBy: context.actor.userId,
        },
        tx,
      )
      return { id: input.roleId, grantCount: input.grants.length }
    },

    audit({ entity, input }) {
      const held = new Set(entity.grants as readonly string[])
      const now = new Set(input.grants)
      const added = input.grants.filter((grant) => !held.has(grant))
      const removed = entity.grants.filter((grant) => !now.has(grant))

      return {
        resourceId: entity.id,
        // The difference, not the whole list. "Added payment.refund" is the
        // sentence somebody reviewing this trail is looking for; a hundred
        // unchanged codes around it is how they stop looking.
        summary:
          `עדכן את ההרשאות של התפקיד ״${entity.name}״: ` +
          `${added.length} נוספו, ${removed.length} הוסרו.`,
        before: { grants: [...entity.grants] },
        after: { grants: [...input.grants] },
      }
    },
  })

  const remove = defineOperation<
    { roleId: string },
    RoleRecord,
    { id: string }
  >({
    name: 'role.delete',
    // `roles_delete` is written around `role.create`, so this is too. A
    // separate `role.delete` permission would be a right the database has
    // never heard of.
    permission: 'role.create',
    resourceType: 'role',
    input: DELETE_ROLE_INPUT,
    // Deleting a role takes authority away from everybody holding it. That
    // is not a keystroke.
    requiresReason: true,
    loadResource: loadRole,

    async rule({ entity, context }) {
      assertEditableRole(entity)

      if (entity.holderCount > 0) {
        throw new BusinessRuleError({
          code: 'role_still_held',
          message: `role ${entity.id} is held by ${entity.holderCount} memberships`,
          userMessage:
            entity.holderCount === 1
              ? 'אדם אחד עדיין מחזיק בתפקיד הזה. מחיקה הייתה שוללת ממנו הרשאות בלי שאיש ישים לב, ולכן יש להסיר ממנו את התפקיד קודם.'
              : `${entity.holderCount} אנשים עדיין מחזיקים בתפקיד הזה. הסר אותו מהם לפני המחיקה.`,
        })
      }

      // `invitations_role_id_fkey` is ON DELETE RESTRICT, so the database
      // would refuse this anyway — with a constraint name. Refusing here
      // means the person is told that an invitation is waiting on the role,
      // which is the fact they can act on.
      const invitations = await store.openInvitationCount(
        context.actor.organizationId,
        entity.id,
      )

      if (invitations > 0) {
        throw new BusinessRuleError({
          code: 'role_named_by_invitation',
          message: `role ${entity.id} is named by ${invitations} live invitations`,
          userMessage:
            'יש הזמנה פתוחה שמעניקה את התפקיד הזה. בטל אותה או המתן שתתקבל לפני המחיקה.',
        })
      }
    },

    async execute({ input, context, tx }) {
      await store.deleteRole(
        { organizationId: context.actor.organizationId, roleId: input.roleId },
        tx,
      )
      return { id: input.roleId }
    },

    audit({ entity }) {
      return {
        resourceId: entity.id,
        summary: `מחק את התפקיד המותאם ״${entity.name}״.`,
        before: { code: entity.code, grants: [...entity.grants] },
        after: null,
      }
    },
  })

  return { create, setPermissions, remove }
}
