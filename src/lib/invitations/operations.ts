/**
 * EXECUTION CONTEXT — SERVER ONLY. Admitting somebody to the organization.
 *
 * ── What this closes ──────────────────────────────────────────────────────
 *
 * `/team/invite` shipped complete and disabled, and the reason on screen was
 * exact: `public.invitations` needs a minted, hashed token and an expiry, and
 * nothing in `src/lib` minted one. Writing the row from the route would have
 * created a membership offer with no `audit_events` row, which contradicts the
 * audit screen shipped beside it. This is the operation that was missing.
 *
 * ── The three rules that are not the database's ───────────────────────────
 *
 * 0001 enforces the shape: the email format, one live invitation per address,
 * an expiry after creation, and the scope union. What it cannot enforce is the
 * authorization arithmetic, and all three of those live here:
 *
 *   · **You cannot grant reach you do not hold.** The requested scope is
 *     compared against the inviter's own scope for the `team` family with
 *     `scopeContains`, which is the codebase's one answer to that question. A
 *     general manager narrowed to two properties cannot mint an
 *     organization-wide administrator.
 *   · **A platform role is not assignable inside a customer organization**,
 *     and `roles_insert` says the same thing about creating one. Offering it
 *     here would offer a choice the database refuses on arrival.
 *   · **The owner is transferred, never invited.** There is a grant for that —
 *     `organization.transfer_ownership` — and it is a different act. A second
 *     owner created by an invitation form is not a feature.
 *
 * ── Where the token goes ──────────────────────────────────────────────────
 *
 * Not into the result. Read `delivery.ts`: an operation's result is persisted
 * into `idempotency_keys`, so a token returned from here would be a credential
 * stored in plain text by the side door. Only the hash reaches the row and
 * only the delivery port sees the token.
 */

import { assertCan, scopeContains, scopeFor, type Scope } from '../authz/can'
import { BusinessRuleError, NotFoundError } from '../errors'
import {
  PG_ERROR,
  asString,
  asStringOrNull,
  clientFor,
  recordWrite,
  toRow,
} from '../persistence'
import type { Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'

import type { InvitationDelivery } from './delivery'
import {
  INVITATION_MAX_TTL_DAYS,
  INVITATION_TTL_DAYS,
  invitationExpiry,
  mintInvitationToken,
} from './token'

/* ---------------------------------------------------------------- input -- */

/**
 * The runtime half of `Scope['kind']`, which exists only as a union.
 *
 * `satisfies` refuses a member the union does not carry, and `toScope` below
 * switches exhaustively over the union, so a member added to `Scope` fails to
 * compile there. Between them the tuple cannot drift from the type in either
 * direction.
 */
export const INVITATION_SCOPE_KINDS = [
  'all_organization',
  'properties',
  'units',
  'team',
  'own_records',
] as const satisfies readonly Scope['kind'][]

export type InvitationScopeKind = (typeof INVITATION_SCOPE_KINDS)[number]

/** `invitations_email_format`, as 0001 writes it. Copied, not invented. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export type InvitationDraft = {
  email: string
  /** `public.roles.id`. The code is a label; the row is the grant. */
  roleId: string
  scopeKind: InvitationScopeKind
  propertyIds: readonly string[]
  unitIds: readonly string[]
  teamIds: readonly string[]
  /** Sent with the invitation. Affects nothing about permissions. */
  message: string | null
  /** Days until the link stops working. Defaults to `INVITATION_TTL_DAYS`. */
  expiresInDays?: number
}

export type CreatedInvitation = {
  id: string
  email: string
  roleId: string
  /** ISO 8601. Safe to persist into `idempotency_keys` — see `delivery.ts`. */
  expiresAt: string
}

const ID_LIST = s.arrayOf(s.uuid(), { max: 200 })

const INPUT = s.object({
  email: s.string({
    label: 'כתובת דוא״ל',
    min: 3,
    max: 254,
    pattern: EMAIL,
    patternMessage: 'כתובת הדוא״ל אינה בפורמט תקין.',
  }),
  roleId: s.uuid({ label: 'תפקיד' }),
  scopeKind: s.enumOf(INVITATION_SCOPE_KINDS, { label: 'טווח' }),
  propertyIds: ID_LIST,
  unitIds: ID_LIST,
  teamIds: ID_LIST,
  message: s.nullable(s.string({ label: 'הודעה אישית', max: 2000 })),
  expiresInDays: s.optional(
    s.number({
      label: 'תוקף ההזמנה בימים',
      integer: true,
      min: 1,
      max: INVITATION_MAX_TTL_DAYS,
    }),
  ),
})

export type InvitationCreationOperation = Operation<
  InvitationDraft,
  null,
  CreatedInvitation
>

export type InvitationOperations = {
  createInvitation: InvitationCreationOperation
}

/* -------------------------------------------------------------- refusals -- */

export class InvitationScopeShapeError extends BusinessRuleError {
  constructor(kind: InvitationScopeKind) {
    super({
      code: 'invitation.scope_shape',
      message: `Scope kind '${kind}' was given the wrong id lists`,
      userMessage:
        kind === 'properties'
          ? 'בחר לפחות נכס אחד, או שנה את הטווח לכל הארגון.'
          : kind === 'units'
            ? 'בחר לפחות יחידה אחת, או שנה את הטווח לכל הארגון.'
            : kind === 'team'
              ? 'בחר צוות, או שנה את הטווח לכל הארגון.'
              : 'הטווח שנבחר אינו נושא רשימת מזהים, ולכן אין לצרף אליו נכסים, יחידות או צוותים.',
      publicDetails: { scopeKind: kind },
    })
  }
}

/**
 * The inviter is handing out reach they do not hold.
 *
 * A business rule and not an authorization error, because the person *is*
 * allowed to invite — they are simply allowed to invite into less than they
 * asked for, and the sentence has to say which half is wrong.
 */
export class InvitationScopeTooWideError extends BusinessRuleError {
  constructor() {
    super({
      code: 'invitation.scope_exceeds_inviter',
      message: 'The requested scope is not contained by the inviter own scope',
      userMessage:
        'הטווח שביקשת רחב מהטווח שלך. אפשר להזמין רק לתוך הנכסים, היחידות או ' +
        'הצוותים שאתה עצמך מגיע אליהם.',
    })
  }
}

export class RoleNotAssignableError extends BusinessRuleError {
  constructor(reason: 'platform' | 'owner', roleCode: string) {
    super({
      code: `invitation.role_not_assignable.${reason}`,
      message: `Role '${roleCode}' may not be assigned by invitation: ${reason}`,
      userMessage:
        reason === 'platform'
          ? 'התפקיד הזה שמור לצוות המערכת ואינו ניתן להקצאה בתוך ארגון לקוח.'
          : 'בעלות על הארגון מועברת ואינה מוזמנת. השתמש בהעברת בעלות במסך ההגדרות.',
      publicDetails: { roleCode },
    })
  }
}

/** `invitations_one_live_per_email_idx`, named rather than reported as `23505`. */
export class InvitationAlreadyLiveError extends BusinessRuleError {
  constructor(email: string, cause?: unknown) {
    super({
      code: 'invitation.already_live',
      message: `A live invitation already exists for ${email}`,
      userMessage:
        `כבר קיימת הזמנה פעילה לכתובת ${email}. בטל אותה ברשימת הצוות לפני ` +
        'שליחת הזמנה חדשה, או המתן לפקיעתה.',
      publicDetails: { email },
      cause,
    })
  }
}

/**
 * The insert was accepted and the row could not be read back.
 *
 * Distinct from a failure on purpose: the invitation exists, and the token was
 * minted for it. Telling somebody it failed would have them send a second one.
 */
export class InvitationNotReadableError extends BusinessRuleError {
  constructor() {
    super({
      code: 'invitation.not_readable',
      message:
        'invitations insert returned no row; invitations_select refused the read',
      userMessage:
        'ההזמנה נשמרה אך לא ניתן להציג אותה בהרשאות שלך. בדוק את רשימת הצוות ' +
        'לפני שליחת הזמנה נוספת.',
    })
  }
}

/* ------------------------------------------------------------- helpers -- */

/**
 * The requested reach, as the authorization engine models it.
 *
 * Exhaustive over `Scope['kind']`: a member added to the union fails to
 * compile here rather than falling silently into a default that grants
 * everything.
 */
function toScope(input: InvitationDraft): Scope {
  switch (input.scopeKind) {
    case 'all_organization':
      return { kind: 'all_organization' }
    case 'properties':
      return { kind: 'properties', propertyIds: input.propertyIds }
    case 'units':
      return { kind: 'units', unitIds: input.unitIds }
    case 'team':
      return { kind: 'team', teamIds: input.teamIds }
    case 'own_records':
      return { kind: 'own_records' }
  }
}

/** Mirrors `invitations_scope_shape`: each variant carries its ids and no others. */
function assertScopeShape(input: InvitationDraft): void {
  const counts = {
    properties: input.propertyIds.length,
    units: input.unitIds.length,
    teams: input.teamIds.length,
  }

  const expected: Record<InvitationScopeKind, typeof counts> = {
    all_organization: { properties: 0, units: 0, teams: 0 },
    own_records: { properties: 0, units: 0, teams: 0 },
    properties: { properties: -1, units: 0, teams: 0 },
    units: { properties: 0, units: -1, teams: 0 },
    team: { properties: 0, units: 0, teams: -1 },
  }

  const want = expected[input.scopeKind]
  const wrong = (['properties', 'units', 'teams'] as const).some((key) =>
    want[key] === -1 ? counts[key] === 0 : counts[key] !== 0,
  )

  if (wrong) throw new InvitationScopeShapeError(input.scopeKind)
}

function isDuplicateLiveInvitation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as {
    code?: unknown
    message?: unknown
    details?: unknown
  }
  if (record.code !== PG_ERROR.UNIQUE_VIOLATION) return false
  const haystack = `${String(record.message ?? '')} ${String(record.details ?? '')}`
  return haystack.includes('invitations_one_live_per_email_idx')
}

/**
 * The role, checked rather than trusted.
 *
 * `roles_select` admits the global catalogue (`organization_id is null`) and
 * roles belonging to organizations the caller is a member of, so the query
 * carries no tenant filter and the tenant check is made here on the row that
 * came back. A `NotFoundError` is raised only when the read succeeded and
 * returned nothing — a failed read is rethrown as itself, because "the
 * database is unreachable" and "there is no such role" are different facts and
 * only one of them means the person should pick again.
 */
async function loadAssignableRole(
  db: Db,
  organizationId: string,
  roleId: string,
): Promise<{ id: string; code: string; name: string }> {
  const { data, error } = await db
    .from('roles')
    .select('id, code, name, is_platform, organization_id')
    .eq('id', roleId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw new NotFoundError('role', roleId, {
      userMessage: 'התפקיד שנבחר לא נמצא. רענן את הדף ובחר תפקיד שוב.',
    })
  }

  const row = toRow(data)
  const owner = asStringOrNull(row, 'organization_id')
  if (owner !== null && owner !== organizationId) {
    // Belongs to another tenant. Refused as absent rather than as forbidden:
    // to this organization, that role does not exist.
    throw new NotFoundError('role', roleId, {
      userMessage: 'התפקיד שנבחר לא נמצא. רענן את הדף ובחר תפקיד שוב.',
    })
  }

  const code = asString(row, 'code')
  if (row.is_platform === true)
    throw new RoleNotAssignableError('platform', code)
  if (code === 'organization_owner') {
    throw new RoleNotAssignableError('owner', code)
  }

  return { id: asString(row, 'id'), code, name: asString(row, 'name') }
}

/* ------------------------------------------------------------ the build -- */

export function defineInvitationOperations(options: {
  db: Db
  delivery: InvitationDelivery
}): InvitationOperations {
  const createInvitation = defineOperation<
    InvitationDraft,
    null,
    CreatedInvitation
  >({
    name: 'invitation.create',
    permission: 'user.invite',
    resourceType: 'invitation',
    input: INPUT,

    async rule({ input, context }) {
      const { actor } = context

      // Scope, asserted by hand: there is nothing to load, so the pipeline's
      // second `assertCan` never ran.
      assertCan(actor, 'user.invite', {
        organizationId: actor.organizationId,
        family: 'team',
      })

      assertScopeShape(input)

      // You cannot grant reach you do not hold. `scopeContains` is the one
      // answer to that question in this codebase; a second comparison written
      // here would be a second opinion about who may admit whom.
      const inviterScope = scopeFor(actor, {
        organizationId: actor.organizationId,
        family: 'team',
      })
      if (!scopeContains(inviterScope, toScope(input))) {
        throw new InvitationScopeTooWideError()
      }

      await loadAssignableRole(options.db, actor.organizationId, input.roleId)

      // The live-invitation check. `invitations_one_live_per_email_idx` is the
      // authority and is checked again on the insert below; this is the read
      // that names the problem in a sentence instead of a constraint.
      const email = input.email.toLowerCase()
      const { data, error } = await options.db
        .from('invitations')
        .select('id')
        .eq('organization_id', actor.organizationId)
        .eq('email', email)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .maybeSingle()

      if (error) throw error
      if (data) throw new InvitationAlreadyLiveError(email)
    },

    async execute({ input, context, now, tx }) {
      const db = clientFor(tx, options.db)
      const email = input.email.toLowerCase()

      const { token, tokenHash } = await mintInvitationToken()
      const expiresAt = invitationExpiry(
        now,
        input.expiresInDays ?? INVITATION_TTL_DAYS,
      )

      const { data, error } = await db
        .from('invitations')
        .insert({
          organization_id: context.actor.organizationId,
          email,
          role_id: input.roleId,
          scope_kind: input.scopeKind,
          scope_property_ids: [...input.propertyIds],
          scope_unit_ids: [...input.unitIds],
          scope_team_ids: [...input.teamIds],
          // The hash and only the hash. See `token.ts`.
          token_hash: tokenHash,
          expires_at: expiresAt.toISOString(),
          message: input.message,
          invited_by: context.actor.userId,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, email')
        .single()

      if (isDuplicateLiveInvitation(error)) {
        throw new InvitationAlreadyLiveError(email, error)
      }
      if (error) throw error
      if (!data) throw new InvitationNotReadableError()

      recordWrite(tx, 'invitations.insert')

      const row = toRow(data)
      const id = asString(row, 'id')

      // Sideways, not through the result. The result is persisted for a
      // replay and must never carry the credential.
      await options.delivery.deliver({
        invitationId: id,
        email,
        token,
        expiresAt,
        message: input.message,
      })

      return {
        id,
        email: asString(row, 'email'),
        roleId: input.roleId,
        expiresAt: expiresAt.toISOString(),
      }
    },

    audit({ input, result, context }) {
      const reach =
        input.scopeKind === 'all_organization'
          ? 'בכל הארגון'
          : input.scopeKind === 'own_records'
            ? 'על הרשומות שלו בלבד'
            : input.scopeKind === 'properties'
              ? `ב-${input.propertyIds.length} נכסים`
              : input.scopeKind === 'units'
                ? `ב-${input.unitIds.length} יחידות`
                : `בצוות אחד`

      return {
        resourceId: result.id,
        after: {
          email: result.email,
          roleId: input.roleId,
          scopeKind: input.scopeKind,
          scopePropertyIds: [...input.propertyIds],
          scopeUnitIds: [...input.unitIds],
          scopeTeamIds: [...input.teamIds],
          expiresAt: result.expiresAt,
          // Neither the token nor its hash. The first is a credential and the
          // second is what a stolen audit export would be used to look one up
          // by; the event records that an invitation was created, which is the
          // fact somebody reading the timeline needs.
        },
        summary:
          `${context.auditActor.label} הזמינה את ${result.email} לארגון ` +
          `בתפקיד שנבחר, ${reach}. ההזמנה תפוג ב-${result.expiresAt}`,
      }
    },

    // No domain event. `DOMAIN_EVENTS` carries `agent.invited`, which is the
    // agent network and a different table, and no name for admitting a member.
    // `contracts/events.ts` is a frozen vocabulary owned by the coordinator, so
    // the name is proposed in the report rather than widened here.
  })

  return { createInvitation }
}
