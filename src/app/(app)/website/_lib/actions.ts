'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. Every write the studio performs.
 *
 * ── These write no rows ──────────────────────────────────────────────────
 *
 * Each one hands its request to `defineWebsiteOperations`, which is the only
 * path to a website row carrying authorization, validation, the domain rule,
 * the transaction, the audit event and idempotency in that order. An `insert`
 * from here would look identical to a person and skip all six — and for this
 * module the one that matters most is the publish gate, because an insert into
 * `site_versions` would put an unverified claim in front of customers.
 *
 * ── Why `assertCan` is called here as well ───────────────────────────────
 *
 * The operation asserts it, and row level security asserts it again at the
 * database. This is the independent third: a Server Action is a public
 * endpoint reachable by a crafted POST whatever the screen chose to render,
 * and it must refuse on its own terms before reading or writing anything.
 *
 * ── What a caller gets back ──────────────────────────────────────────────
 *
 * Never a thrown error. A throw inside a Server Action reaches the browser as
 * a digest and a blank screen, so every failure becomes the `SafeErrorBody`
 * `src/lib/errors` already produces: a Hebrew sentence, whether the data was
 * saved, whether retrying is safe, and a correlation id matching the log.
 */

import { revalidatePath } from 'next/cache'

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
  type Db,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'
import {
  defineWebsiteOperations,
  type CreatedSite,
  type GenerationResult,
  type PageDraft,
  type SectionDraft,
  type PublishedSite,
  type RolledBackSite,
} from '@/lib/website'

import { shellContext } from '../../_lib/context'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { domainEventBus } from '../../_lib/events'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The shell, resolved once, or a refusal shaped like every other one.
 *
 * Extracted because seven actions need the identical four lines, and seven
 * copies is seven chances for one of them to forget the `status !== 'ready'`
 * branch and act as a person with no active membership.
 */
async function resolveContext(correlationId: string) {
  const resolved = await shellContext()

  if (!resolved || resolved.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: resolved ? 'membership_not_active' : 'unauthenticated',
        message: resolved
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע את הפעולה.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: resolved
          ? 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.'
          : 'ניסיון חוזר לא יעזור עד שתתחבר מחדש.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId,
      },
    }
  }

  return { ok: true as const, shell: resolved }
}

function servicesFor(db: Db) {
  const { transactions } = transactionRunner(db)
  return {
    audit: new SupabaseAuditWriter(db),
    events: domainEventBus(db),
    idempotency: new SupabaseIdempotencyStore(db),
    transactions,
    onEventError(error: unknown) {
      // A published site whose event failed to deliver is still published.
      // Logged so the loss is not silent.
      console.error('[website] domain event delivery failed', error)
    },
  }
}

/* ------------------------------------------------------------ the site -- */

export async function createSiteAction(input: {
  name: string
  slug: string
  propertyId: string | null
}): Promise<ActionResult<CreatedSite>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.edit_content', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).createSite.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function savePageAction(
  input: PageDraft,
): Promise<ActionResult<{ id: string; title: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.edit_content', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).savePage.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/content')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function saveSectionAction(
  input: SectionDraft,
): Promise<ActionResult<{ id: string; claimCount: number }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.edit_content', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).saveSection.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/content')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ---------------------------------------------------------- design, seo -- */

export async function saveDesignAction(input: {
  siteId: string
  palette: string
  headingFont: string
  radius: string
  density: string
  logoMediaId: string | null
}): Promise<ActionResult<{ siteId: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    // A DIFFERENT GRANT FROM CONTENT. A copywriter reaching this endpoint by
    // hand is refused here, by the operation, and by the policy.
    assertCan(resolved.shell.actor, 'site.edit_design', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).saveDesign.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/design')
    revalidatePath('/website/preview')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function saveSeoAction(input: {
  siteId: string
  pageId: string
  metaTitle: string | null
  metaDescription: string | null
  canonicalUrl: string | null
  indexable: boolean
}): Promise<ActionResult<{ pageId: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.manage_seo', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).saveSeo.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/seo')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------ publish, rollback, down -- */

/**
 * PUT IT IN FRONT OF CUSTOMERS.
 *
 * The refusal path matters as much as the success one: when a claim cannot be
 * sourced, the operation throws `SiteClaimsUnsourcedError`, whose
 * `userMessage` names the offending claims. `toSafeResponse` carries that
 * sentence through unchanged, so the person sees which sentence is the problem
 * rather than "publish failed".
 */
export async function publishAction(input: {
  siteId: string
  label: string | null
}): Promise<ActionResult<PublishedSite>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.publish', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).publish.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website')
    revalidatePath('/website/versions')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function unpublishAction(input: {
  siteId: string
}): Promise<ActionResult<{ siteId: string }>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.publish', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).unpublish.run({
      request: { input: { ...input, label: null } },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/**
 * GO BACK, WITHOUT DESTROYING WHAT CAME AFTER.
 *
 * A separate grant from publishing because it is a separate act with a
 * separate blast radius: publishing puts a reviewed draft live, rolling back
 * replaces what is live with something older, at speed, usually because
 * something is wrong.
 */
export async function rollbackAction(input: {
  siteId: string
  versionId: string
}): Promise<ActionResult<RolledBackSite>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.rollback', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).rollback.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website')
    revalidatePath('/website/versions')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------------- domain -- */

export async function addDomainAction(input: {
  siteId: string
  hostname: string
}): Promise<
  ActionResult<{ id: string; hostname: string; verificationToken: string }>
> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    assertCan(resolved.shell.actor, 'site.manage_domain', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).addDomain.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/domain')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* ------------------------------------------------------------- generate -- */

/**
 * Ask for a draft.
 *
 * With the generator this codebase ships, the honest outcome is a refusal —
 * and it comes back as `ok: true` with `status: 'refused'`, not as an error.
 * That distinction is the whole point: the request succeeded, was recorded,
 * and the engine declined. Reporting it as a failure would make the studio
 * show a red box for a product working exactly as configured.
 */
export async function generateAction(input: {
  siteId: string
  sectionId: string
  instruction: string | null
  tone: 'warm' | 'plain' | 'upscale' | 'family'
}): Promise<ActionResult<GenerationResult>> {
  const correlationId = crypto.randomUUID()
  const resolved = await resolveContext(correlationId)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    // Carries `ai_content`, metered separately from `website`. A customer with
    // a site and no generation package is refused HERE, with the plan reason,
    // and every other studio screen keeps working.
    assertCan(resolved.shell.actor, 'site.ai_generate', {
      organizationId: resolved.shell.actor.organizationId,
    })

    const db = await createClient()
    const outcome = await defineWebsiteOperations({ db }).generate.run({
      request: { input },
      context: {
        actor: resolved.shell.actor,
        auditActor: auditActorFor(resolved.shell.user),
        correlationId,
      },
      services: servicesFor(db),
    })

    revalidatePath('/website/content')
    return { ok: true, data: outcome.data }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
