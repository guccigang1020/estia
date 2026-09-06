'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTION. The Autopilot console's one write.
 *
 * One action, and it is the only one. There is no separate "grant the
 * entitlement" action and no separate "end the trial" action, because either
 * of those would be a way to move one half of a pair that must move together
 * — see the header of `src/lib/platform/autopilot.ts`.
 *
 * ── This function writes nothing ──────────────────────────────────────────
 *
 * It reads a form and hands it to `setAutopilotCapability`, which is the only
 * path with authorization, validation, the stated reason, the transaction and
 * the audit event wired in that order. The same shape as
 * `(platform)/platform/organizations/[id]/_lib/actions.ts`, and deliberately
 * not a shared helper with it: the two directories are separate on purpose.
 *
 * ── Why the guard runs here as well ───────────────────────────────────────
 *
 * A Server Action is reachable by a crafted POST whatever the screen rendered.
 * This is not the enforcement — the operation calls `assertCan` itself, the
 * definer function re-checks `has_platform_permission`, and the policy under
 * it checks a third time. It is the refusal that happens FIRST, before a row
 * is read.
 *
 * ── Feedback travels in the URL ───────────────────────────────────────────
 *
 * A thrown error inside a Server Action reaches the browser as a digest and a
 * blank page. So every path ends in a redirect carrying `done` or `error`, and
 * `AppError.dataOutcome` decides the wording: "לא בוצע" and "ייתכן שבוצע
 * חלקית" are different sentences, and on this screen the second one means the
 * record and the entitlement may now disagree — which is exactly what the
 * reader needs to be told to go and check.
 */

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import { toSafeResponse } from '@/lib/errors'
import { AUTOPILOT_CAPABILITY_STATES } from '@/lib/contracts/states'
import type { AutopilotCapabilityState } from '@/lib/contracts/states'
import {
  defineAutopilotOperations,
  SupabaseAutopilotStore,
} from '@/lib/platform/autopilot'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../../_lib/guard'
import { platformOperationContext, platformServices } from '../../../_lib/wiring'

function organizationPath(organizationId: string): string {
  return `/platform/autopilot/${organizationId}`
}

/**
 * Set the capability state, and the entitlement with it.
 *
 * `redirect()` throws `NEXT_REDIRECT`, so it is called OUTSIDE the `try`.
 * Inside, the catch would treat a successful redirect as a failed operation
 * and report a write that happened as one that did not — which on this screen
 * would send somebody to re-grant an entitlement that is already granted.
 */
export async function setAutopilotCapabilityAction(
  form: FormData,
): Promise<never> {
  const organizationId = requiredId(form, 'organizationId')
  const state = capabilityState(form)
  const correlationId = crypto.randomUUID()

  let outcome: string

  try {
    const session = await requirePlatformGrant('platform.organization.manage')
    const db = await createClient()
    const { services } = platformServices(db)
    const operations = defineAutopilotOperations(new SupabaseAutopilotStore(db))

    await operations.setAutopilotCapability.run({
      request: {
        input: {
          organizationId,
          state,
          trialEndsAt: trialEnd(form),
          actionLimit: actionLimit(form),
          note: text(form, 'note'),
        },
      },
      context: platformOperationContext({
        session,
        organizationId,
        reason: text(form, 'reason'),
        correlationId,
      }),
      services,
    })

    revalidatePath(organizationPath(organizationId))
    revalidatePath('/platform/autopilot')
    outcome = `done=${encodeURIComponent(
      'מצב היכולת וההרשאה במנוי עודכנו יחד, בפעולה אחת. השינוי נרשם ביומן ' +
        'הביקורת של הלקוח.',
    )}`
  } catch (error) {
    const safe = toSafeResponse(error, correlationId)
    outcome =
      `error=${encodeURIComponent(safe.error.message)}` +
      `&data=${encodeURIComponent(safe.error.dataMessage)}` +
      `&cid=${encodeURIComponent(correlationId)}`
  }

  redirect(`${organizationPath(organizationId)}?${outcome}`)
}

/* --------------------------------------------------------------- fields -- */

/** A form field, trimmed to `null` rather than to an empty string. */
function text(form: FormData, field: string): string | null {
  const value = form.get(field)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredId(form: FormData, field: string): string {
  const value = text(form, field)
  // A form that arrived without the organization it is about is a crafted
  // request, not a user error. Refused with no message worth crafting.
  if (!value) throw new Error(`missing ${field}`)
  return value
}

/**
 * The chosen state.
 *
 * Narrowed against the union before it reaches the operation, so an unexpected
 * value is a refusal about a form rather than an enum cast that the database
 * rejects three layers later.
 */
function capabilityState(form: FormData): AutopilotCapabilityState {
  const value = text(form, 'state')
  const known = AUTOPILOT_CAPABILITY_STATES as readonly string[]
  if (!value || !known.includes(value)) throw new Error('unknown state')
  return value as AutopilotCapabilityState
}

/**
 * The trial end date, as an ISO instant.
 *
 * The field is a `date`, so the browser sends `YYYY-MM-DD` and the day is over
 * at its END rather than at midnight when it starts — a trial marked as ending
 * on the fourteenth that stopped counting at 00:00 on the fourteenth would be
 * a day short, and it is the customer's day.
 */
function trialEnd(form: FormData): string | null {
  const value = text(form, 'trialEndsAt')
  if (!value) return null
  const parsed = new Date(`${value}T23:59:59.999Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

/** An empty field is "no ceiling", which is `null` and not zero. */
function actionLimit(form: FormData): number | null {
  const value = text(form, 'actionLimit')
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
