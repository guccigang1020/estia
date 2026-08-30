'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Creating a workspace from nothing.
 *
 * ── Three writes, two privilege levels ────────────────────────────────────
 *
 * `createOrganizationAction` is privileged and is the only one that is. It
 * delegates to `signup.ts`, which explains at length why no policy can admit
 * it. `createPropertyAction` and `createFirstUnitAction` run as the signed-in
 * user through `createClient()`, under `properties_insert` and `units_insert`,
 * which by then have something to check: the caller holds an ACTIVE membership
 * with the `organization_owner` role, so `has_permission(org, 'property.create')`
 * and `has_permission(org, 'unit.manage')` are satisfied honestly rather than
 * bypassed. Using the admin client for those two would have been one line
 * shorter and would have thrown away the tenant isolation the whole product
 * rests on.
 *
 * ── Nothing here trusts the form ──────────────────────────────────────────
 *
 * Every action re-runs the same validators the browser ran, from `schema.ts`,
 * and refuses on its own terms. A Server Action is a POST; it can arrive
 * without the form ever having rendered. The organization id is never taken
 * from the request either — it comes from `shellContext()`, which resolves it
 * from the memberships the database will admit right now.
 *
 * ── Duplicate submission, and who arbitrates ──────────────────────────────
 *
 * The button disables itself and the wizard holds a synchronous lock, and
 * neither is the guarantee: two clicks in the same tick, or a retried request
 * after a timeout, can still deliver two POSTs. The database settles it, three
 * times over, and each time with a unique index that already existed:
 *
 *     organizations_slug_key                 (slug)
 *     properties_organization_slug_idx       (organization_id, slug)
 *     units_property_code_idx                (property_id, lower(code))
 *
 * The second write loses with 23505 and each action responds the same way: go
 * and find the row the first write created, and return THAT as the success.
 * One organization, one property, one unit, however many clicks. A slug that
 * turns out to belong to somebody else is the one case that is genuinely an
 * error, and it comes back as a field error on the slug rather than a 500.
 *
 * ── What a caller gets back ───────────────────────────────────────────────
 *
 * Never a throw. A thrown error inside a Server Action reaches the browser as
 * a digest and a blank screen. Every failure is the `SafeErrorBody` that
 * `src/lib/errors` already produced — Hebrew sentence, whether anything was
 * saved, whether a retry is safe, and a correlation id matching the server log
 * — which `ActionError` renders verbatim.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

import {
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import { createClient, getCurrentUser } from '@/lib/supabase/server'

import {
  ALL_PROPERTIES,
  PROPERTY_COOKIE,
  WORKSPACE_COOKIE,
  shellContext,
} from '../../_lib/context'
import { loadProgress } from './queries'
import { createWorkspace, isSlugAvailable } from './signup'
import {
  PROPERTY_FIELD_LABEL,
  SLUG_MAX,
  SLUG_MIN,
  SLUG_PATTERN,
  UNIT_FIELD_LABEL,
  isBusinessType,
  isPropertyType,
  isUnitType,
  parseUnitDraft,
  slugify,
  validateOrganization,
  validateProperty,
  validateUnit,
  type OrganizationDraft,
  type PropertyDraft,
  type UnitDraft,
} from './schema'

/* ---------------------------------------------------------------- shape -- */

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

function failure(cause: unknown): { ok: false; error: SafeErrorBody } {
  return { ok: false, error: toSafeResponse(cause, crypto.randomUUID()).error }
}

function refuse(
  code: string,
  message: string,
  retryMessage: string,
): { ok: false; error: SafeErrorBody } {
  return {
    ok: false,
    error: {
      code,
      message,
      dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
      retryMessage,
      dataOutcome: 'not_saved',
      retryable: false,
      correlationId: crypto.randomUUID(),
    },
  }
}

const SIGNED_OUT = () =>
  refuse(
    'unauthenticated',
    'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
    'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
  )

/* --------------------------------------------------------------- cookie -- */

/**
 * The cookie NAMES come from `(app)/_lib/context.ts`, which owns them — two
 * spellings of `estia.workspace` in one codebase is a bug that presents as a
 * person landing in the wrong tenant.
 *
 * Only the options are restated, because `selectWorkspaceAction` keeps them
 * private. The values are copied deliberately and the reasoning lives beside
 * them there: a year, because a workspace choice is a working habit rather
 * than a session detail; `httpOnly` because nothing in the browser needs to
 * read it, and a value page script cannot touch is one fewer way into the
 * wrong tenant; `lax` to keep it off cross-site POSTs.
 */
const COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 365,
} as const

/* ------------------------------------------------------ step 1 · the slug -- */

export type SlugAnswer = {
  slug: string
  available: boolean
  /** Hebrew, and present only when the answer is "no". */
  reason: string | null
}

/**
 * Is this slug free, asked before the form is submitted.
 *
 * A courtesy, not a permission: the slug can be taken in the second between
 * this answer and the submit, which is why `createOrganizationAction` handles
 * 23505 on its own. Restricted to a caller who has no workspace yet, so it is
 * not a general-purpose oracle for enumerating tenants — and slugs are public
 * URL identifiers by design, so a "taken" answer discloses nothing a link
 * would not.
 */
export async function checkSlugAction(
  raw: string,
): Promise<ActionResult<SlugAnswer>> {
  const context = await shellContext()
  if (!context) return SIGNED_OUT()
  if (context.status !== 'no_workspace') {
    return refuse(
      'already_has_workspace',
      'כבר יש לך מרחב עבודה, ולכן אין צורך לבדוק כתובת חדשה.',
      'ניסיון חוזר לא יעזור.',
    )
  }

  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    return {
      ok: true,
      data: {
        slug,
        available: false,
        reason: `אורך הכתובת חייב להיות בין ${SLUG_MIN} ל־${SLUG_MAX} תווים.`,
      },
    }
  }

  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: true,
      data: {
        slug,
        available: false,
        reason:
          'הכתובת יכולה להכיל אותיות לטיניות קטנות, ספרות ומקפים בלבד, ולהתחיל ולהסתיים באות או בספרה.',
      },
    }
  }

  try {
    const available = await isSlugAvailable(slug)
    return {
      ok: true,
      data: {
        slug,
        available,
        reason: available ? null : 'הכתובת הזו כבר תפוסה. בחר אחרת.',
      },
    }
  } catch (cause) {
    return failure(cause)
  }
}

/* ---------------------------------------------- step 1 · the organization -- */

export type CreatedWorkspace = {
  organizationId: string
  slug: string
  /** False when the write could not be made in one transaction. */
  atomic: boolean
}

export async function createOrganizationAction(
  draft: OrganizationDraft,
): Promise<ActionResult<CreatedWorkspace>> {
  const user = await getCurrentUser()
  if (!user) return SIGNED_OUT()

  const context = await shellContext()

  // Already has one. Not an error and not a second organization: return the
  // workspace they are in. This is the cheap half of duplicate protection —
  // the expensive half is the unique index below.
  if (context && context.status !== 'no_workspace') {
    return {
      ok: true,
      data: {
        organizationId: context.workspace.organizationId,
        slug: context.workspace.slug,
        atomic: true,
      },
    }
  }

  const normalized: OrganizationDraft = {
    name: draft?.name?.trim() ?? '',
    slug: draft?.slug?.trim().toLowerCase() ?? '',
    businessType: draft?.businessType ?? '',
    timezone: draft?.timezone?.trim() ?? '',
  }

  const issues = validateOrganization(normalized)
  if (issues.length > 0) return failure(new ValidationError(issues))

  // Narrowing for the type system; `validateOrganization` already refused
  // anything else, and this cannot be reached with an invalid value.
  if (!isBusinessType(normalized.businessType)) {
    return failure(
      new ValidationError([
        {
          field: 'businessType',
          code: 'invalid',
          message: 'יש לבחור סוג עסק מהרשימה.',
          label: 'סוג העסק',
        },
      ]),
    )
  }

  try {
    const created = await createWorkspace(user.id, {
      name: normalized.name,
      slug: normalized.slug,
      businessType: normalized.businessType,
      timezone: normalized.timezone,
    })

    // Point the shell at the workspace that now exists. Without this the
    // cookie is absent and `chooseWorkspace` falls back to the first
    // membership — which is the same organization today and would quietly
    // stop being it the moment this person joins a second one.
    const store = await cookies()
    store.set(WORKSPACE_COOKIE, created.organizationId, COOKIE_OPTIONS)
    store.set(PROPERTY_COOKIE, ALL_PROPERTIES, COOKIE_OPTIONS)

    // The shell reads both cookies in a layout, so the whole tree is stale.
    revalidatePath('/', 'layout')

    return {
      ok: true,
      data: {
        organizationId: created.organizationId,
        slug: normalized.slug,
        atomic: created.atomic,
      },
    }
  } catch (cause) {
    return failure(cause)
  }
}

/* --------------------------------------------------- step 2 · the property -- */

export type CreatedProperty = { propertyId: string; name: string }

export async function createPropertyAction(
  draft: PropertyDraft,
): Promise<ActionResult<CreatedProperty>> {
  const context = await shellContext()
  if (!context) return SIGNED_OUT()
  if (context.status !== 'ready') {
    return refuse(
      'no_active_workspace',
      'אין לך מרחב עבודה פעיל, ולכן לא ניתן ליצור נכס.',
      'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
    )
  }

  const normalized: PropertyDraft = {
    name: draft?.name?.trim() ?? '',
    propertyType: draft?.propertyType ?? '',
    addressLine1: draft?.addressLine1?.trim() ?? '',
    city: draft?.city?.trim() ?? '',
    checkInTime: draft?.checkInTime?.trim() ?? '',
    checkOutTime: draft?.checkOutTime?.trim() ?? '',
    cancellationPolicyText: draft?.cancellationPolicyText?.trim() ?? '',
  }

  const issues = validateProperty(normalized)
  if (issues.length > 0) return failure(new ValidationError(issues))
  if (!isPropertyType(normalized.propertyType)) {
    return failure(
      new ValidationError([
        {
          field: 'propertyType',
          code: 'invalid',
          message: 'יש לבחור סוג נכס מהרשימה.',
          label: PROPERTY_FIELD_LABEL.propertyType,
        },
      ]),
    )
  }

  const organizationId = context.actor.organizationId
  const userId = context.user.id

  /**
   * A URL identifier, derived once and never shown as a business fact. A
   * Hebrew name slugifies to nothing, which is why there is a fallback — and
   * why the fallback is a machine word rather than a guess at transliteration.
   * It is also the key the unique index arbitrates a double-click on, below.
   */
  const slug = slugify(normalized.name) || 'property-1'

  try {
    const supabase = await createClient()

    // The property inherits the organization's time zone rather than the
    // column's `Asia/Jerusalem` default. A business that chose Athens in step
    // one and finds its first property in Jerusalem would have every check-in
    // time an hour out, and nothing on screen would say why.
    const { data: organization } = await supabase
      .from('organizations')
      .select('timezone, currency')
      .eq('id', organizationId)
      .maybeSingle()

    const { data, error } = await supabase
      .from('properties')
      .insert({
        organization_id: organizationId,
        slug,
        name: normalized.name,
        property_type: normalized.propertyType,
        // Not `draft`. A property nobody can sell from is not what somebody
        // finishing a signup wizard meant to create.
        status: 'active',
        address_line1: normalized.addressLine1,
        city: normalized.city,
        country: 'IL',
        timezone: (organization?.timezone as string | undefined) ?? undefined,
        currency: (organization?.currency as string | undefined) ?? undefined,
        default_check_in_time: normalized.checkInTime,
        default_check_out_time: normalized.checkOutTime,
        // Prose, because a human agrees to it. The structured
        // `cancellation_policy` jsonb stays `{}`: refund percentages nobody
        // typed would be invented terms, and something will eventually compute
        // money from that column.
        cancellation_policy_text: normalized.cancellationPolicyText,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, name')
      .single()

    if (error) {
      if (error.code === '23505') {
        // A second click. Find what the first one made.
        //
        // Scoped to this organization, and that is load-bearing rather than
        // tidy: the unique index is (organization_id, slug), so the SAME slug
        // legitimately exists in two organizations. Somebody who belongs to
        // both would otherwise match the other one's property here — RLS
        // admits it, because they may genuinely read it — and this step would
        // hand the wizard a property in the wrong tenant.
        const { data: existing } = await supabase
          .from('properties')
          .select('id, name')
          .eq('organization_id', organizationId)
          .eq('slug', slug)
          .is('deleted_at', null)
          .maybeSingle()

        if (existing) {
          revalidatePath('/onboarding')
          return {
            ok: true,
            data: {
              propertyId: existing.id as string,
              name: (existing.name as string) ?? normalized.name,
            },
          }
        }
      }
      throw error
    }

    revalidatePath('/onboarding')
    revalidatePath('/', 'layout')

    return {
      ok: true,
      data: {
        propertyId: data.id as string,
        name: (data.name as string) ?? normalized.name,
      },
    }
  } catch (cause) {
    return failure(cause)
  }
}

/* ------------------------------------------------------- step 3 · the unit -- */

export type CreatedUnit = { unitId: string; name: string }

export async function createFirstUnitAction(
  propertyId: string,
  draft: UnitDraft,
): Promise<ActionResult<CreatedUnit>> {
  const context = await shellContext()
  if (!context) return SIGNED_OUT()
  if (context.status !== 'ready') {
    return refuse(
      'no_active_workspace',
      'אין לך מרחב עבודה פעיל, ולכן לא ניתן ליצור יחידה.',
      'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
    )
  }

  const normalized: UnitDraft = {
    name: draft?.name?.trim() ?? '',
    unitType: draft?.unitType ?? '',
    capacity: draft?.capacity?.trim() ?? '',
    bedrooms: draft?.bedrooms?.trim() ?? '',
    bathrooms: draft?.bathrooms?.trim() ?? '',
    basePrice: draft?.basePrice?.trim() ?? '',
    deposit: draft?.deposit?.trim() ?? '',
  }

  const issues = validateUnit(normalized)
  if (issues.length > 0) return failure(new ValidationError(issues))
  if (!isUnitType(normalized.unitType)) {
    return failure(
      new ValidationError([
        {
          field: 'unitType',
          code: 'invalid',
          message: 'יש לבחור סוג יחידה מהרשימה.',
          label: UNIT_FIELD_LABEL.unitType,
        },
      ]),
    )
  }

  const numbers = parseUnitDraft(normalized)
  if (!numbers) {
    return failure(
      new ValidationError([
        {
          field: 'capacity',
          code: 'invalid',
          message: 'אחד מהמספרים בטופס אינו תקין.',
          label: UNIT_FIELD_LABEL.capacity,
        },
      ]),
    )
  }

  const organizationId = context.actor.organizationId
  const userId = context.user.id

  // The property must be the caller's own. `units_insert` checks this again in
  // the database — `property_in_scope(property_id, organization_id)` — so this
  // is the readable refusal rather than the enforcing one.
  const progress = await loadProgress(organizationId)
  const targetPropertyId =
    typeof propertyId === 'string' && propertyId.length > 0
      ? propertyId
      : progress.propertyId

  if (!targetPropertyId || targetPropertyId !== progress.propertyId) {
    return refuse(
      'property_not_in_scope',
      'הנכס המבוקש אינו שייך למרחב העבודה שלך.',
      'רענן את הדף ונסה שוב.',
    )
  }

  /** Short operational code. Same double-click arbitration as the slug. */
  const code = (slugify(normalized.name) || 'u1').slice(0, 32)

  // The unit starts from the house times the previous step recorded, which is
  // exactly what 0008 says property defaults are for. They stay editable on
  // the unit later — a suite with a late checkout is an ordinary thing.
  const houseTimes = {
    checkIn: progress.checkInTime ?? '15:00',
    checkOut: progress.checkOutTime ?? '11:00',
  }

  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from('units')
      .insert({
        organization_id: organizationId,
        property_id: targetPropertyId,
        code,
        name: normalized.name,
        unit_type: normalized.unitType,
        status: 'active',
        max_guests: numbers.maxGuests,
        // `units_standard_guests_range` requires 1 ≤ standard ≤ max, and the
        // column default of 2 breaks a single-guest unit outright. The wizard
        // asks for one capacity and collects no extra-guest supplement, so the
        // truthful reading of the price entered is "covers everyone": standard
        // equals max, and nothing here invents a second tier of pricing.
        standard_guests: numbers.maxGuests,
        bedrooms: numbers.bedrooms,
        bathrooms: numbers.bathrooms,
        base_price_agorot: numbers.basePriceAgorot,
        deposit_agorot: numbers.depositAgorot,
        check_in_time: houseTimes.checkIn,
        check_out_time: houseTimes.checkOut,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, name')
      .single()

    if (error) {
      if (error.code === '23505') {
        const { data: existing } = await supabase
          .from('units')
          .select('id, name')
          .eq('property_id', targetPropertyId)
          .eq('code', code)
          .is('deleted_at', null)
          .maybeSingle()

        if (existing) {
          revalidatePath('/onboarding')
          return {
            ok: true,
            data: {
              unitId: existing.id as string,
              name: (existing.name as string) ?? normalized.name,
            },
          }
        }
      }
      throw error
    }

    revalidatePath('/onboarding')
    revalidatePath('/', 'layout')

    return {
      ok: true,
      data: {
        unitId: data.id as string,
        name: (data.name as string) ?? normalized.name,
      },
    }
  } catch (cause) {
    return failure(cause)
  }
}

/* ------------------------------------------------------------ step 4 · done -- */

/**
 * Leave `onboarding` behind.
 *
 * `organizations.status` starts at `onboarding` — the enum's own first value —
 * and becomes `active` only when there is genuinely something to operate: an
 * organization, a property and a sellable unit. Setting it at creation time
 * would have made the column decorative.
 *
 * Run as the caller under `organizations_update`, which requires
 * `organization.settings.edit`. The owner role holds it, so this needs no
 * privilege — and if the policy ever changes, this fails loudly instead of
 * silently succeeding.
 */
export async function completeOnboardingAction(): Promise<
  ActionResult<{ status: string }>
> {
  const context = await shellContext()
  if (!context) return SIGNED_OUT()
  if (context.status !== 'ready') {
    return refuse(
      'no_active_workspace',
      'אין לך מרחב עבודה פעיל.',
      'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
    )
  }

  try {
    const supabase = await createClient()
    const { error } = await supabase
      .from('organizations')
      .update({ status: 'active', updated_by: context.user.id })
      .eq('id', context.actor.organizationId)
      .eq('status', 'onboarding')

    if (error) throw error

    revalidatePath('/', 'layout')
    return { ok: true, data: { status: 'active' } }
  } catch (cause) {
    return failure(cause)
  }
}
