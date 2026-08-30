/**
 * EXECUTION CONTEXT — SERVER ONLY, AND PRIVILEGED.
 *
 * ############################################################################
 * # THE ONE WRITE ROW LEVEL SECURITY CANNOT AUTHORIZE.                       #
 * #                                                                          #
 * # `0004_rls.sql` says it in a comment above the organizations policies,    #
 * # and the live database agrees — verified, not assumed:                    #
 * #                                                                          #
 * #   organizations              authenticated: SELECT, UPDATE                #
 * #   organization_subscriptions authenticated: SELECT                        #
 * #                                                                          #
 * # There is no INSERT privilege on either, and no INSERT policy could help  #
 * # if there were: every tenant policy is written as                          #
 * # `organization_id IN (SELECT my_organizations())`, and the person         #
 * # creating their first workspace is a member of nothing, so that set is    #
 * # empty by definition. `memberships`, `membership_roles` and               #
 * # `membership_scopes` DO grant INSERT to `authenticated`, but their        #
 * # policies demand `user.invite` / `role.assign` inside an organization the  #
 * # caller is not yet in — the same wall, one table further down.            #
 * #                                                                          #
 * # So all five rows are written by the service layer, together, and this    #
 * # file is that layer. It is the ONLY privileged write in the onboarding    #
 * # flow: the property and the unit are created by the caller under the      #
 * # ordinary policies, because by then the membership exists and the         #
 * # policies admit them. Reaching for privilege there would delete the       #
 * # tenant isolation the product rests on for no reason at all.              #
 * ############################################################################
 *
 * ── Why not `postgresUnitOfWork` ──────────────────────────────────────────
 *
 * Because it does the opposite of what this needs, deliberately and correctly.
 * It exists to make a direct connection BE the signed-in user — `set local
 * role authenticated` plus the JWT claims — and it refuses to run if that did
 * not take effect, because a direct connection is otherwise the owner with
 * `BYPASSRLS`. Every statement inside it is therefore subject to the very
 * policies that have no answer for this write, and the organization insert
 * would fail with 42501.
 *
 * What this file borrows instead is that module's plumbing: the same
 * `DATABASE_URL`, the same `postgresPool`, the same transaction pooler. The
 * difference is one line that is not there — the role switch — and it is the
 * whole reason the file needs the warning above it.
 *
 * ── Atomic, and when it honestly is not ───────────────────────────────────
 *
 * `strategy()` reports which of two paths is available, and the caller is told
 * which one ran:
 *
 *   'atomic'      — `DATABASE_URL` is set. One `BEGIN … COMMIT`. A failure at
 *                   any point rolls the whole thing back and no row survives.
 *                   This is a real transaction, not a hopeful one.
 *
 *   'compensated' — only `SUPABASE_SERVICE_ROLE_KEY` is set. PostgREST has no
 *                   multi-statement transaction, so the five inserts are five
 *                   round trips and a failure at the fourth leaves three rows
 *                   standing. That partial state is DETECTED and removed
 *                   explicitly, in reverse order, and if the removal itself
 *                   fails the caller is told the data outcome is `partial`
 *                   rather than `not_saved`. It is not atomic and this file
 *                   does not pretend it is.
 *
 *   'unavailable' — neither is configured. Refused loudly, before anything is
 *                   written, naming the variable that is missing.
 *
 * An organization with no owner is the failure this care exists to prevent: no
 * policy admits anybody to it, so nobody can read it, edit it, or delete it.
 * It is unreachable rather than merely wrong.
 */

import { AppError, BusinessRuleError, InternalError } from '@/lib/errors'
import { postgresPool } from '@/lib/persistence'
import { createAdminClient } from '@/lib/supabase/admin'

import {
  FIXED_COUNTRY,
  FIXED_CURRENCY,
  FIXED_LOCALE,
  type BusinessType,
} from './schema'

/* ----------------------------------------------------------------- types -- */

export type WorkspaceSeed = {
  name: string
  slug: string
  businessType: BusinessType
  timezone: string
}

export type SignupStrategy = 'atomic' | 'compensated' | 'unavailable'

export type SignupSuccess = {
  organizationId: string
  /** True only for the `BEGIN … COMMIT` path. Never optimistic. */
  atomic: boolean
  /** Set when the slug was already this person's own organization. */
  replayed: boolean
}

/** The slug belongs to an organization this caller is not a member of. */
export class SlugTakenError extends BusinessRuleError {
  constructor(slug: string) {
    super({
      code: 'organization_slug_taken',
      message: `organizations.slug '${slug}' is already in use`,
      userMessage:
        'הכתובת הזו כבר תפוסה על ידי עסק אחר. בחר כתובת אחרת ונסה שוב.',
    })
  }
}

/** Neither `DATABASE_URL` nor `SUPABASE_SERVICE_ROLE_KEY` is configured. */
export class SignupUnavailableError extends AppError {
  constructor() {
    super({
      code: 'workspace_creation_unavailable',
      status: 503,
      message:
        'Cannot create an organization: neither DATABASE_URL nor ' +
        'SUPABASE_SERVICE_ROLE_KEY is set. Creating the first organization, ' +
        'its owner membership and its subscription is the one write no row ' +
        'level security policy can authorize — see 0004_rls.sql — so it needs ' +
        'one of the two privileged paths. Set DATABASE_URL to the Supabase ' +
        'transaction pooler (port 6543) for the atomic path.',
      userMessage:
        'לא ניתן ליצור מרחב עבודה כרגע: חסרה הגדרת שרת. פנה למנהל המערכת — אף נתון לא נשמר.',
      retryable: false,
      dataOutcome: 'not_saved',
    })
  }
}

/**
 * The compensated path failed AND could not undo itself.
 *
 * Reported separately from an ordinary failure because the two mean different
 * things to whoever reads it: an ordinary failure wrote nothing, and this one
 * left rows behind that need a human. `dataOutcome: 'unknown'` is what carries
 * that distinction to the screen — "לא ידוע אם השינוי נשמר. בדוק את המצב לפני
 * ניסיון חוזר", which is precisely the situation and precisely the advice.
 */
export class OrphanedOrganizationError extends AppError {
  constructor(organizationId: string, detail: string, cause?: unknown) {
    super({
      code: 'workspace_creation_partial',
      status: 500,
      message:
        `Workspace creation failed part-way and the cleanup did not complete ` +
        `for organization ${organizationId}: ${detail}. Rows may remain that ` +
        `no membership reaches.`,
      userMessage:
        'יצירת מרחב העבודה נכשלה באמצע, וניקוי השאריות לא הושלם. אל תנסה שוב — פנה לתמיכה עם המזהה שלמטה.',
      retryable: false,
      dataOutcome: 'unknown',
      cause,
    })
  }
}

/* ------------------------------------------------------------- detection -- */

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL
  return url && url.trim() !== '' ? url : undefined
}

function hasServiceRoleKey(): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return typeof key === 'string' && key.trim() !== ''
}

/** Which path `createWorkspace` will take, without taking it. */
export function strategy(): SignupStrategy {
  if (databaseUrl()) return 'atomic'
  if (hasServiceRoleKey()) return 'compensated'
  return 'unavailable'
}

/* --------------------------------------------------------------- shared -- */

/** Postgres unique violation, from either driver. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

/**
 * The organization this slug already names, IF this caller owns it.
 *
 * This is the double-submit answer. Two clicks send the same slug; the unique
 * index `organizations_slug_key` lets exactly one through and refuses the
 * other with 23505. The loser asks this question, finds the organization the
 * winner just created with its own membership attached, and reports success
 * with that id — one organization, one owner, two clicks. A slug that belongs
 * to somebody else returns null and becomes a field error instead.
 *
 * Privileged, because the point is to look at a row the caller may have no
 * membership for. It returns an id or nothing, never the row.
 */
async function ownedOrganizationIdForSlug(
  userId: string,
  slug: string,
): Promise<string | null> {
  const url = databaseUrl()

  if (url) {
    const sql = postgresPool(url)
    const rows = await sql<{ id: string }[]>`
      select o.id
      from public.organizations o
      join public.memberships m
        on m.organization_id = o.id
       and m.user_id = ${userId}
      where o.slug = ${slug}
      limit 1`
    return rows[0]?.id ?? null
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('organizations')
    .select('id, memberships!inner(user_id)')
    .eq('slug', slug)
    .eq('memberships.user_id', userId)
    .maybeSingle()

  if (error) throw error
  return (data?.id as string | undefined) ?? null
}

/* ---------------------------------------------------------- atomic path -- */

/**
 * One transaction, five inserts, all or nothing.
 *
 * The plan is READ inside the transaction rather than hardcoded, because
 * `0003_plans.sql` is explicit that the catalogue is data an administrator
 * edits and this file is not entitled to a second opinion about prices. The
 * agreed prices are copied from the plan row at this instant — that snapshot
 * is the entire reason `organization_subscriptions` has its own price columns.
 *
 * `trial_ends_at` is left NULL on purpose. A trial length is a revenue-model
 * decision, not an engineering one, and nothing in the product reads the
 * column: `loadPlan` admits any subscription whose status is not `cancelled`.
 * A number invented here would be a commitment nobody made.
 */
async function createAtomically(
  userId: string,
  seed: WorkspaceSeed,
): Promise<string> {
  const sql = postgresPool(databaseUrl()!)

  return sql.begin(async (tx) => {
    const planRows = await tx<
      { id: string; monthly: string; yearly: string }[]
    >`
      select id,
             monthly_price_agorot::text as monthly,
             yearly_price_agorot::text  as yearly
      from public.plans
      where deleted_at is null and is_public
      order by sort_order, monthly_price_agorot
      limit 1`

    const plan = planRows[0]
    if (!plan) {
      throw new InternalError({
        message:
          'No public plan exists in public.plans, so no subscription can be ' +
          'attached. An organization without one resolves to `no_subscription` ' +
          'and its owner cannot use it.',
      })
    }

    const roleRows = await tx<{ id: string }[]>`
      select id from public.roles
      where code = 'organization_owner' and organization_id is null
      limit 1`

    const ownerRole = roleRows[0]
    if (!ownerRole) {
      throw new InternalError({
        message:
          'The system role organization_owner is missing from public.roles. ' +
          'Without it the creator would hold no grants in their own business.',
      })
    }

    const orgRows = await tx<{ id: string }[]>`
      insert into public.organizations
        (slug, name, business_type, country, timezone, currency, locale,
         status, created_by, updated_by)
      values
        (${seed.slug}, ${seed.name},
         ${seed.businessType}::public.organization_business_type,
         ${FIXED_COUNTRY}, ${seed.timezone}, ${FIXED_CURRENCY}, ${FIXED_LOCALE},
         'onboarding'::public.organization_status, ${userId}, ${userId})
      returning id`

    const organizationId = orgRows[0]!.id

    // `joined_at` is not decoration: `memberships_joined_when_active` refuses
    // an active membership without one.
    const membershipRows = await tx<{ id: string }[]>`
      insert into public.memberships
        (user_id, organization_id, status, joined_at, employment_type,
         language, created_by, updated_by)
      values
        (${userId}, ${organizationId}, 'active'::public.membership_status,
         now(), 'owner'::public.employment_type, 'he', ${userId}, ${userId})
      returning id`

    const membershipId = membershipRows[0]!.id

    await tx`
      insert into public.membership_roles
        (membership_id, organization_id, role_id, created_by)
      values (${membershipId}, ${organizationId}, ${ownerRole.id}, ${userId})`

    // Explicit rather than implied. 0008 treats a missing scope row as
    // organization-wide, but a row that says so is a fact rather than a
    // default somebody could reasonably change later.
    await tx`
      insert into public.membership_scopes
        (membership_id, organization_id, kind, created_by, updated_by)
      values
        (${membershipId}, ${organizationId},
         'all_organization'::public.membership_scope_kind, ${userId}, ${userId})`

    await tx`
      insert into public.organization_subscriptions
        (organization_id, plan_id, status, billing_interval,
         agreed_monthly_price_agorot, agreed_yearly_price_agorot,
         created_by, updated_by)
      values
        (${organizationId}, ${plan.id}, 'trialing'::public.subscription_status,
         'monthly'::public.billing_interval,
         ${plan.monthly}::bigint, ${plan.yearly}::bigint,
         ${userId}, ${userId})`

    return organizationId
  })
}

/* ----------------------------------------------------- compensated path -- */

type CreatedRows = {
  organizationId: string | null
  membershipId: string | null
}

/**
 * Undo what was written, newest first.
 *
 * Not a single `delete from organizations` relying on the cascade, even though
 * every one of these tables does cascade from it. Two reasons, and both are
 * about being able to say what happened: `audit_events.organization_id` is ON
 * DELETE RESTRICT, so a cascade can be refused by a table this function never
 * touched and the failure would name the wrong thing; and deleting explicitly
 * means each statement's outcome is separately known, which is what lets the
 * caller be told the truth about whether anything survived.
 *
 * Returns the steps that failed. An empty array means the partial state is
 * genuinely gone.
 */
async function cleanUp(created: CreatedRows): Promise<string[]> {
  const admin = createAdminClient()
  const failures: string[] = []

  // `PromiseLike`, not `Promise`: a PostgREST filter builder is a thenable and
  // is only executed when it is awaited. Typing it as a Promise is what makes
  // the compiler reject the calls below, and reaching for `any` to silence
  // that would also silence the error field this function exists to read.
  const attempt = async (label: string, run: () => PromiseLike<unknown>) => {
    try {
      const result = (await run()) as { error?: { message?: string } | null }
      if (result?.error) failures.push(`${label}: ${result.error.message}`)
    } catch (cause) {
      failures.push(`${label}: ${String(cause)}`)
    }
  }

  if (created.organizationId) {
    await attempt('organization_subscriptions', () =>
      admin
        .from('organization_subscriptions')
        .delete()
        .eq('organization_id', created.organizationId!),
    )
  }

  if (created.membershipId) {
    await attempt('membership_roles', () =>
      admin
        .from('membership_roles')
        .delete()
        .eq('membership_id', created.membershipId!),
    )
    await attempt('membership_scopes', () =>
      admin
        .from('membership_scopes')
        .delete()
        .eq('membership_id', created.membershipId!),
    )
    await attempt('memberships', () =>
      admin.from('memberships').delete().eq('id', created.membershipId!),
    )
  }

  if (created.organizationId) {
    await attempt('organizations', () =>
      admin.from('organizations').delete().eq('id', created.organizationId!),
    )
  }

  return failures
}

async function createCompensated(
  userId: string,
  seed: WorkspaceSeed,
): Promise<string> {
  const admin = createAdminClient()
  const created: CreatedRows = { organizationId: null, membershipId: null }

  try {
    const { data: planRow, error: planError } = await admin
      .from('plans')
      .select('id, monthly_price_agorot, yearly_price_agorot')
      .is('deleted_at', null)
      .eq('is_public', true)
      .order('sort_order')
      .order('monthly_price_agorot')
      .limit(1)
      .maybeSingle()

    if (planError) throw planError
    if (!planRow) {
      throw new InternalError({
        message: 'No public plan exists in public.plans.',
      })
    }

    const { data: roleRow, error: roleError } = await admin
      .from('roles')
      .select('id')
      .eq('code', 'organization_owner')
      .is('organization_id', null)
      .maybeSingle()

    if (roleError) throw roleError
    if (!roleRow) {
      throw new InternalError({
        message: 'The system role organization_owner is missing.',
      })
    }

    const { data: orgRow, error: orgError } = await admin
      .from('organizations')
      .insert({
        slug: seed.slug,
        name: seed.name,
        business_type: seed.businessType,
        country: FIXED_COUNTRY,
        timezone: seed.timezone,
        currency: FIXED_CURRENCY,
        locale: FIXED_LOCALE,
        status: 'onboarding',
        created_by: userId,
        updated_by: userId,
      })
      .select('id')
      .single()

    if (orgError) throw orgError
    created.organizationId = orgRow.id as string

    const { data: membershipRow, error: membershipError } = await admin
      .from('memberships')
      .insert({
        user_id: userId,
        organization_id: created.organizationId,
        status: 'active',
        joined_at: new Date().toISOString(),
        employment_type: 'owner',
        language: 'he',
        created_by: userId,
        updated_by: userId,
      })
      .select('id')
      .single()

    if (membershipError) throw membershipError
    created.membershipId = membershipRow.id as string

    const { error: roleAssignError } = await admin
      .from('membership_roles')
      .insert({
        membership_id: created.membershipId,
        organization_id: created.organizationId,
        role_id: roleRow.id,
        created_by: userId,
      })

    if (roleAssignError) throw roleAssignError

    const { error: scopeError } = await admin.from('membership_scopes').insert({
      membership_id: created.membershipId,
      organization_id: created.organizationId,
      kind: 'all_organization',
      created_by: userId,
      updated_by: userId,
    })

    if (scopeError) throw scopeError

    const { error: subscriptionError } = await admin
      .from('organization_subscriptions')
      .insert({
        organization_id: created.organizationId,
        plan_id: planRow.id,
        status: 'trialing',
        billing_interval: 'monthly',
        agreed_monthly_price_agorot: planRow.monthly_price_agorot,
        agreed_yearly_price_agorot: planRow.yearly_price_agorot,
        created_by: userId,
        updated_by: userId,
      })

    if (subscriptionError) throw subscriptionError

    return created.organizationId
  } catch (cause) {
    // The slug race is not a partial write: the organization insert was the
    // first statement and it was refused, so there is nothing to undo.
    if (isUniqueViolation(cause) && created.organizationId === null) throw cause

    const failures = await cleanUp(created)

    if (failures.length > 0 && created.organizationId) {
      throw new OrphanedOrganizationError(
        created.organizationId,
        failures.join('; '),
        cause,
      )
    }

    throw cause
  }
}

/* ---------------------------------------------------------------- entry -- */

/**
 * Create the organization, its owner membership and its subscription.
 *
 * `userId` must come from a verified session — `getUser()`, never a form field
 * and never `getSession()`. This function has no way to check that and every
 * caller must, because the id it is handed becomes the owner of a new business.
 */
export async function createWorkspace(
  userId: string,
  seed: WorkspaceSeed,
): Promise<SignupSuccess> {
  const mode = strategy()
  if (mode === 'unavailable') throw new SignupUnavailableError()

  try {
    const organizationId =
      mode === 'atomic'
        ? await createAtomically(userId, seed)
        : await createCompensated(userId, seed)

    return { organizationId, atomic: mode === 'atomic', replayed: false }
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause

    // Either this caller's own second click, or somebody else's slug.
    const existing = await ownedOrganizationIdForSlug(userId, seed.slug)
    if (existing) {
      return {
        organizationId: existing,
        atomic: mode === 'atomic',
        replayed: true,
      }
    }

    throw new SlugTakenError(seed.slug)
  }
}

/**
 * Is this slug free?
 *
 * Privileged, because `organizations_select` only shows the caller their own
 * organizations — asked as the caller, every slug in the system would look
 * available and the answer would be worthless. It returns one boolean and
 * never a name, and slugs are public URL identifiers by design (0001 says so
 * on the column), so this discloses nothing a link would not.
 */
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const url = databaseUrl()

  if (url) {
    const sql = postgresPool(url)
    const rows = await sql<{ taken: boolean }[]>`
      select exists (
        select 1 from public.organizations where slug = ${slug}
      ) as taken`
    return rows[0]?.taken === false
  }

  if (!hasServiceRoleKey()) throw new SignupUnavailableError()

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()

  if (error) throw error
  return data === null
}
