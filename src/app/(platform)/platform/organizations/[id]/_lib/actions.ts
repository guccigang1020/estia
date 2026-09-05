'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The console's three writes.
 *
 * ── Not one of these functions writes a row ───────────────────────────────
 *
 * Each hands the request to an operation from `definePlatformOperations`,
 * which is the only path with authorization, validation, the stated reason,
 * the transaction and the audit event wired in that order. What is left here
 * is the shape of the request: reading a form, refusing before anything is
 * read, and turning a failure into a sentence in the URL rather than a digest
 * and a blank screen.
 *
 * ── Why the guard is called again inside every action ─────────────────────
 *
 * A Server Action is reachable by a crafted POST whatever the screen rendered.
 * `requirePlatformGrant()` here is not the enforcement — the operation calls
 * `assertCan` on its own, the database function re-checks
 * `has_platform_permission`, and the row level security policy under that
 * checks it a third time. It is the refusal that happens FIRST, before a row
 * is read, which is the property the customer-side actions were written for
 * too.
 *
 * ── Feedback travels in the URL, and says which half happened ─────────────
 *
 * A thrown error inside a Server Action reaches the browser as a digest and an
 * empty page. So every path ends in a redirect back to the account, carrying
 * either `done` or `error`. `AppError.dataOutcome` is what decides the
 * wording: "לא בוצע" and "ייתכן שבוצע חלקית" are different sentences and the
 * second one is the one an operator needs when the audit write is the half
 * that failed.
 */

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import type { Entitlement } from '@/lib/plans/entitlements'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'

import { requirePlatformGrant } from '../../../../_lib/guard'
import {
  platformOperations,
  platformOperationContext,
  platformServices,
} from '../../../../_lib/wiring'
import type { PlatformGrant } from '@/lib/platform'

/* ------------------------------------------------------------- plumbing -- */

function accountPath(organizationId: string): string {
  return `/platform/organizations/${organizationId}`
}

/**
 * Run one console operation and come back with a sentence.
 *
 * `redirect()` throws `NEXT_REDIRECT`, so it is deliberately called OUTSIDE
 * the `try`. Calling it inside would let the catch treat a successful redirect
 * as a failed operation and report a write that actually happened as one that
 * did not — which is the single worst thing this file could get wrong.
 */
async function runConsoleAction(input: {
  grant: PlatformGrant
  organizationId: string
  reason: string | null
  succeeded: string
  run: (args: {
    operations: ReturnType<typeof platformOperations>
    services: ReturnType<typeof platformServices>['services']
    context: ReturnType<typeof platformOperationContext>
  }) => Promise<void>
}): Promise<never> {
  const session = await requirePlatformGrant(input.grant)
  const correlationId = crypto.randomUUID()

  let outcome: string

  try {
    const db = await createClient()
    const { services } = platformServices(db)

    await input.run({
      operations: platformOperations(db, session),
      services,
      context: platformOperationContext({
        session,
        organizationId: input.organizationId,
        reason: input.reason,
        correlationId,
      }),
    })

    revalidatePath(accountPath(input.organizationId))
    outcome = `done=${encodeURIComponent(input.succeeded)}`
  } catch (error) {
    const safe = toSafeResponse(error, correlationId)
    outcome =
      `error=${encodeURIComponent(safe.error.message)}` +
      `&data=${encodeURIComponent(safe.error.dataMessage)}` +
      `&cid=${encodeURIComponent(correlationId)}`
  }

  redirect(`${accountPath(input.organizationId)}?${outcome}`)
}

/** A form field, trimmed to `null` rather than to an empty string. */
function text(form: FormData, field: string): string | null {
  const value = form.get(field)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function requiredId(form: FormData, field: string): string {
  const value = text(form, field)
  if (!value) {
    // A form that arrived without the organization it is about is a crafted
    // request, not a user error. Refused with no message worth crafting.
    throw new Error(`missing ${field}`)
  }
  return value
}

/* -------------------------------------------------------------- actions -- */

export async function suspendOrganizationAction(form: FormData) {
  const organizationId = requiredId(form, 'organizationId')

  await runConsoleAction({
    grant: 'platform.organization.manage',
    organizationId,
    reason: text(form, 'reason'),
    succeeded:
      'החשבון הושהה. שום נתון לא נמחק, והפעולה נרשמה ביומן הביקורת של הלקוח.',
    run: ({ operations, services, context }) =>
      operations.suspendOrganization
        .run({ request: { input: { organizationId } }, context, services })
        .then(() => undefined),
  })
}

export async function restoreOrganizationAction(form: FormData) {
  const organizationId = requiredId(form, 'organizationId')

  await runConsoleAction({
    grant: 'platform.organization.manage',
    organizationId,
    reason: text(form, 'reason'),
    succeeded: 'החשבון הוחזר לפעילות. הפעולה נרשמה ביומן הביקורת של הלקוח.',
    run: ({ operations, services, context }) =>
      operations.restoreOrganization
        .run({ request: { input: { organizationId } }, context, services })
        .then(() => undefined),
  })
}

/**
 * The capability overrides.
 *
 * Read from three checkbox groups and four number fields. An empty number
 * field is an ABSENT key, not a zero and not an unlimited — absent means "use
 * the package's figure", which is the distinction `effectiveLimits()` was
 * corrected for once already.
 */
export async function setCapabilitiesAction(form: FormData) {
  const organizationId = requiredId(form, 'organizationId')

  const entitlementGrants = entitlements(form, 'grant')
  const entitlementRevocations = entitlements(form, 'revoke')
  const limitOverrides = limits(form)

  await runConsoleAction({
    grant: 'platform.feature_flag.manage',
    organizationId,
    reason: text(form, 'reason'),
    succeeded:
      'היכולות עודכנו. השינוי נכנס לתוקף מיד — הוא נקרא דרך אותן שלוש עמודות שהמוצר עצמו קורא.',
    run: ({ operations, services, context }) =>
      operations.setCapabilities
        .run({
          request: {
            input: {
              organizationId,
              entitlementGrants,
              entitlementRevocations,
              limitOverrides,
            },
          },
          context,
          services,
        })
        .then(() => undefined),
  })
}

export async function openSupportViewAction(form: FormData) {
  const organizationId = requiredId(form, 'organizationId')
  const minutes = Number(form.get('minutes') ?? 60)

  await runConsoleAction({
    grant: 'platform.impersonate',
    organizationId,
    reason: text(form, 'reason'),
    succeeded:
      'נפתחה צפייה בקריאה בלבד, תחומה בזמן. היא אינה מעניקה שום הרשאת כתיבה, והלקוח רואה אותה ביומן שלו.',
    run: ({ operations, services, context }) =>
      operations.openSupportView
        .run({
          request: {
            input: {
              organizationId,
              minutes: Number.isFinite(minutes) ? minutes : 60,
            },
          },
          context,
          services,
        })
        .then(() => undefined),
  })
}

export async function closeSupportViewAction(form: FormData) {
  const organizationId = requiredId(form, 'organizationId')
  const sessionId = requiredId(form, 'sessionId')

  await runConsoleAction({
    grant: 'platform.impersonate',
    organizationId,
    reason: null,
    succeeded: 'הצפייה נסגרה.',
    run: ({ operations, services, context }) =>
      operations.closeSupportView
        .run({
          request: { input: { organizationId, sessionId } },
          context,
          services,
        })
        .then(() => undefined),
  })
}

/* --------------------------------------------------------------- fields -- */

const KNOWN_ENTITLEMENTS: ReadonlySet<string> = new Set(ENTITLEMENTS)

/**
 * The ticked boxes in one group, narrowed to features the product has.
 *
 * The database's CHECK constraint refuses an unknown entitlement anyway. This
 * filter is here so the refusal is a validation issue about a form rather than
 * a constraint violation about a column.
 */
function entitlements(form: FormData, prefix: string): Entitlement[] {
  return form
    .getAll(`${prefix}`)
    .filter(
      (value): value is string =>
        typeof value === 'string' && KNOWN_ENTITLEMENTS.has(value),
    )
    .map((value) => value as Entitlement)
}

/**
 * The four limit fields.
 *
 * Three states, and they are all different: a number is an override, the word
 * `unlimited` is an explicit `null` meaning no ceiling, and an empty field is
 * an absent key that falls through to the package.
 */
function limits(form: FormData): {
  properties?: number | null
  units?: number | null
  members?: number | null
  storageGb?: number | null
} {
  const result: Record<string, number | null> = {}

  for (const key of ['properties', 'units', 'members', 'storageGb'] as const) {
    const raw = form.get(`limit.${key}`)
    if (typeof raw !== 'string') continue

    const value = raw.trim()
    if (value === '') continue
    if (value === 'unlimited') {
      result[key] = null
      continue
    }

    const parsed = Number(value)
    if (Number.isFinite(parsed)) result[key] = parsed
  }

  return result
}
