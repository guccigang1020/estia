'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. What a member of staff does to a guest
 * link.
 *
 * ── Why these live in `src/lib` and not beside the screen ─────────────────
 *
 * They belong in `src/app/(app)/bookings/_lib/actions.ts`, next to the booking
 * detail screen that calls them. That file belongs to another worker for this
 * wave, and two agents editing one actions file is the collision the ownership
 * register exists to prevent — so they are here, and the coordinator can move
 * them when the panel is mounted. The move is a file rename and an import
 * update; nothing in the logic depends on the location.
 *
 * The one real cost is the dependency direction: a module under `src/lib`
 * importing `shellContext` from `src/app` is inverted, and it is called out
 * here rather than left for somebody to discover. It resolves the moment these
 * move.
 *
 * ── Every one of these goes through `defineOperation` ─────────────────────
 *
 * Authorization, validation, the domain rule, the transaction, the audit event
 * and idempotency, in that order, none of them optional. `assertCan` is called
 * here as well, and that is not redundant: a Server Action is a public
 * endpoint reachable by a crafted POST whatever the screen chose to render, so
 * it refuses on its own terms before reading anything.
 *
 * ── Rotation returns the new token exactly once ───────────────────────────
 *
 * To the person who pressed the button, in the response, so they can copy the
 * new link. It is not in the audit row and not in the operation's persisted
 * result — an audit event is read by more people than the booking is, and
 * `idempotency_keys` stores results in the database, so putting a live
 * credential in either would be handing it back through the side door. The
 * same reasoning `src/lib/invitations/token.ts` gives for its own token.
 */

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { shellContext } from '@/app/(app)/_lib/context'
import { auditActorFor, transactionRunner } from '@/app/(app)/_lib/wiring'
import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { defineGuestJourneyOperations } from './operations'
import { guestLinkUrl } from './link'
import type { GuestLinkChannel } from './types'

export type AdminActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

/**
 * The origin a GUEST will open.
 *
 * Read from the request rather than from `env.siteUrl`, because behind a proxy,
 * on a preview deployment or on a self-hosted install the host the browser used
 * is the one that has to appear in the message — and a link built from a
 * configured value that disagrees with it is a link that 404s for the guest and
 * works for the person testing it.
 */
async function requestOrigin(): Promise<string> {
  const list = await headers()
  const host = list.get('x-forwarded-host') ?? list.get('host')
  const proto =
    list.get('x-forwarded-proto') ??
    (host?.startsWith('localhost') || host?.startsWith('127.0.0.1')
      ? 'http'
      : 'https')
  return host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_SITE_URL ?? '')
}

type Wiring = Awaited<ReturnType<typeof wire>>

async function wire() {
  const context = await shellContext()
  if (!context || context.status !== 'ready') return null

  const db = await createClient()
  const { transactions } = transactionRunner(db)

  return {
    context,
    db,
    operations: defineGuestJourneyOperations({ db }),
    services: {
      audit: new SupabaseAuditWriter(db),
      idempotency: new SupabaseIdempotencyStore(db),
      transactions,
      onEventError(error: unknown) {
        // A link that went out and whose event failed to deliver still went
        // out. Logged so the loss is not silent.
        console.error('[guest-journey] domain event delivery failed', error)
      },
    },
  }
}

function notReady(correlationId: string): SafeErrorBody {
  return {
    code: 'membership_not_active',
    message: 'אין לך מרחב עבודה פעיל, ולכן לא ניתן לבצע את הפעולה.',
    dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
    retryMessage: 'ניסיון חוזר לא יעזור עד שהחברות בארגון תופעל.',
    dataOutcome: 'not_saved',
    retryable: false,
    correlationId,
  }
}

function operationContext(
  wiring: Wiring,
  correlationId: string,
  reason?: string,
) {
  if (!wiring) throw new Error('unreachable')
  return {
    actor: wiring.context.actor,
    auditActor: auditActorFor(wiring.context.user),
    correlationId,
    reason: reason ?? null,
  }
}

function revalidateBooking(bookingId: string): void {
  revalidatePath(`/bookings/${bookingId}`)
  revalidatePath('/bookings')
}

/* ----------------------------------------------------------------- send -- */

export async function recordGuestLinkSendAction(input: {
  bookingId: string
  channel: GuestLinkChannel
  recipient: string | null
  idempotencyKey: string
}): Promise<AdminActionResult<{ sentAt: string; sendCount: number }>> {
  const correlationId = crypto.randomUUID()
  const wiring = await wire()
  if (!wiring) return { ok: false, error: notReady(correlationId) }

  try {
    assertCan(wiring.context.actor, 'message.send', {
      organizationId: wiring.context.actor.organizationId,
    })

    const outcome = await wiring.operations.recordGuestLinkSend.run({
      request: {
        input: {
          bookingId: input.bookingId,
          channel: input.channel,
          recipient: input.recipient,
        },
        resourceId: input.bookingId,
        idempotencyKey: input.idempotencyKey,
      },
      context: operationContext(wiring, correlationId),
      services: wiring.services,
    })

    revalidateBooking(input.bookingId)
    return {
      ok: true,
      data: { sentAt: outcome.data.sentAt, sendCount: outcome.data.sendCount },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------------------- rotate -- */

export async function rotateGuestLinkAction(input: {
  bookingId: string
  reason: string
  idempotencyKey: string
}): Promise<AdminActionResult<{ url: string }>> {
  const correlationId = crypto.randomUUID()
  const wiring = await wire()
  if (!wiring) return { ok: false, error: notReady(correlationId) }

  try {
    assertCan(wiring.context.actor, 'booking.update', {
      organizationId: wiring.context.actor.organizationId,
    })

    const outcome = await wiring.operations.rotateGuestLink.run({
      request: {
        input: { bookingId: input.bookingId },
        resourceId: input.bookingId,
        idempotencyKey: input.idempotencyKey,
      },
      context: operationContext(wiring, correlationId, input.reason),
      services: wiring.services,
    })

    revalidateBooking(input.bookingId)
    // The one place the new token is disclosed: to the person who asked for
    // it, once. See the header.
    return {
      ok: true,
      data: { url: guestLinkUrl(await requestOrigin(), outcome.data.token) },
    }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* --------------------------------------------------- revoke and restore -- */

export async function revokeGuestLinkAction(input: {
  bookingId: string
  reason: string
  idempotencyKey: string
}): Promise<AdminActionResult<{ revokedAt: string }>> {
  const correlationId = crypto.randomUUID()
  const wiring = await wire()
  if (!wiring) return { ok: false, error: notReady(correlationId) }

  try {
    assertCan(wiring.context.actor, 'booking.update', {
      organizationId: wiring.context.actor.organizationId,
    })

    const outcome = await wiring.operations.revokeGuestLink.run({
      request: {
        input: { bookingId: input.bookingId },
        resourceId: input.bookingId,
        idempotencyKey: input.idempotencyKey,
      },
      context: operationContext(wiring, correlationId, input.reason),
      services: wiring.services,
    })

    revalidateBooking(input.bookingId)
    return { ok: true, data: { revokedAt: outcome.data.revokedAt } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

export async function restoreGuestLinkAction(input: {
  bookingId: string
  reason: string
  idempotencyKey: string
}): Promise<AdminActionResult<{ restored: true }>> {
  const correlationId = crypto.randomUUID()
  const wiring = await wire()
  if (!wiring) return { ok: false, error: notReady(correlationId) }

  try {
    assertCan(wiring.context.actor, 'booking.update', {
      organizationId: wiring.context.actor.organizationId,
    })

    await wiring.operations.restoreGuestLink.run({
      request: {
        input: { bookingId: input.bookingId },
        resourceId: input.bookingId,
        idempotencyKey: input.idempotencyKey,
      },
      context: operationContext(wiring, correlationId, input.reason),
      services: wiring.services,
    })

    revalidateBooking(input.bookingId)
    return { ok: true, data: { restored: true } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}

/* -------------------------------------------------------- release early -- */

export async function releaseArrivalInfoAction(input: {
  bookingId: string
  reason: string
  idempotencyKey: string
}): Promise<AdminActionResult<{ releasedAt: string }>> {
  const correlationId = crypto.randomUUID()
  const wiring = await wire()
  if (!wiring) return { ok: false, error: notReady(correlationId) }

  try {
    assertCan(wiring.context.actor, 'booking.update', {
      organizationId: wiring.context.actor.organizationId,
    })

    const outcome = await wiring.operations.releaseArrivalInfo.run({
      request: {
        input: { bookingId: input.bookingId },
        resourceId: input.bookingId,
        idempotencyKey: input.idempotencyKey,
      },
      context: operationContext(wiring, correlationId, input.reason),
      services: wiring.services,
    })

    revalidateBooking(input.bookingId)
    return { ok: true, data: { releasedAt: outcome.data.releasedAt } }
  } catch (cause) {
    return { ok: false, error: toSafeResponse(cause, correlationId).error }
  }
}
