'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. Correcting what the wizard recorded.
 *
 * ── No privilege here, and that is the point ──────────────────────────────
 *
 * `src/app/(app)/onboarding/_lib/signup.ts` needs the service layer because
 * the creator of a first organization is a member of nothing and no policy can
 * admit them. That reasoning expires the instant the membership exists. This
 * action runs as the signed-in user through `createClient()`, under
 * `organizations_update`, which requires `organization.settings.edit` — so a
 * member without that grant is refused by the database even if this file were
 * wrong about them.
 *
 * ── The slug is not editable ──────────────────────────────────────────────
 *
 * 0001 says it on the column: "Immutable in practice; changing it breaks
 * links." Offering a control that silently invalidates every URL a business
 * has already sent to a guest would be a worse feature than not having one.
 * Renaming a workspace is a settings change; re-addressing it is a migration.
 *
 * ── Optimistic locking ────────────────────────────────────────────────────
 *
 * The form carries the `version` it rendered from, and the update is
 * predicated on it. Two people editing the organization in two tabs is an
 * ordinary Tuesday; without this, the second save silently overwrites the
 * first and neither of them ever knows. `tg_touch_row` owns the column, so the
 * predicate matches the version that was READ, and a mismatch affects zero
 * rows rather than the wrong ones.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import {
  ConflictError,
  ValidationError,
  toSafeResponse,
  type SafeErrorBody,
} from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../../_lib/context'
import {
  ORGANIZATION_FIELD_LABEL,
  isBusinessType,
  validateOrganization,
} from '../../../onboarding/_lib/schema'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type OrganizationSettingsInput = {
  name: string
  businessType: string
  timezone: string
  /** The version the form was rendered from. */
  version: number
}

function failure(cause: unknown): { ok: false; error: SafeErrorBody } {
  return { ok: false, error: toSafeResponse(cause, crypto.randomUUID()).error }
}

export async function updateOrganizationAction(
  input: OrganizationSettingsInput,
): Promise<ActionResult<{ version: number }>> {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false,
      error: {
        code: 'no_active_workspace',
        message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לעדכן את פרטי הארגון.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
        dataOutcome: 'not_saved',
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  const organizationId = context.actor.organizationId

  try {
    // The independent check. The policy below decides again, and the screen
    // hiding a control is not authorization — a Server Action is reachable by
    // a crafted POST whatever the screen rendered.
    assertCan(context.actor, 'organization.settings.edit', { organizationId })

    // The slug is not submitted and is not changed. It is passed to the shared
    // validator only because that validator refuses a blank one, and the
    // stored slug is by definition valid.
    const issues = validateOrganization({
      name: input?.name ?? '',
      slug: context.workspace.slug,
      businessType: input?.businessType ?? '',
      timezone: input?.timezone ?? '',
    }).filter((issue) => issue.field !== 'slug')

    if (issues.length > 0) throw new ValidationError(issues)

    if (!isBusinessType(input.businessType)) {
      throw new ValidationError([
        {
          field: 'businessType',
          code: 'invalid',
          message: 'יש לבחור סוג עסק מהרשימה.',
          label: ORGANIZATION_FIELD_LABEL.businessType,
        },
      ])
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from('organizations')
      .update({
        name: input.name.trim(),
        business_type: input.businessType,
        timezone: input.timezone.trim(),
        updated_by: context.user.id,
      })
      .eq('id', organizationId)
      .eq('version', input.version)
      .select('version')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      // Zero rows. Either somebody else saved first, or the policy refused —
      // and the two are told apart by asking whether the row is still readable
      // at a different version, rather than by guessing.
      const { data: current } = await supabase
        .from('organizations')
        .select('version')
        .eq('id', organizationId)
        .maybeSingle()

      throw new ConflictError({
        resourceType: 'organization',
        resourceId: organizationId,
        expectedVersion: input.version,
        actualVersion: (current?.version as number | undefined) ?? null,
      })
    }

    revalidatePath('/', 'layout')
    revalidatePath('/settings/organization')

    return { ok: true, data: { version: data.version as number } }
  } catch (cause) {
    return failure(cause)
  }
}
