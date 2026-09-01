/**
 * EXECUTION CONTEXT — SERVER ONLY. What the BUSINESS does to a guest link.
 *
 * The counterpart to `journey.ts`. That file carries what a guest may write,
 * through SECURITY DEFINER functions and with a token as the only credential.
 * This one carries what a member of staff may do — send the link, send it
 * again, rotate it, revoke it, release the arrival information by hand — and
 * every one of them goes through `defineOperation`, so authorization, the
 * audit event and idempotency are not things a route file has to remember.
 *
 * ── Why rotation and revocation demand a reason ───────────────────────────
 *
 * Neither `booking.update` nor `message.send` is in `SENSITIVE_ACTIONS`, so
 * the pipeline would not ask for one. Both are declared `requiresReason` here
 * anyway, because the audit line that matters six months later is not "the
 * link was rotated" but "the link was rotated because it had been forwarded to
 * the wrong WhatsApp group". A rotation with no reason is a support ticket
 * nobody can close.
 *
 * ── Why rotating clears the opened stamps ─────────────────────────────────
 *
 * `guest_link_first_opened_at` and `guest_link_last_opened_at` answer one
 * question — has the guest seen the link we sent them? After a rotation the
 * link that was seen no longer works, so carrying the old stamps forward would
 * make the journey tab report "opened" about a link nobody can open. They are
 * cleared, and `guest_link_rotated_at` plus the append-only `guest_link_sends`
 * log keep the history that clearing them would otherwise lose.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * Actually delivering a message. Nothing in this module talks to WhatsApp, an
 * SMS gateway or a mail server: `recordGuestLinkSend` records that a send
 * happened and the composed text comes from `link.ts`. Where an integration
 * exists, the integration sends and then calls this; where none does, the
 * operator pastes the message themselves and this is still the truthful record
 * of it. See the header of `link.ts` for why that is the whole design rather
 * than a stage on the way to something else.
 */

import { BusinessRuleError } from '../errors'
import {
  asString,
  asTimestampOrNull,
  clientFor,
  recordWrite,
  toRow,
  type Db,
} from '../persistence'
import { defineOperation, s, type Operation } from '../service'

import { maskRecipient } from './link'
import { GUEST_LINK_CHANNELS, type GuestLinkChannel } from './types'

/* ---------------------------------------------------------------- token -- */

/**
 * A fresh capability.
 *
 * Hex of 32 CSPRNG bytes, which is exactly what `bookings.guest_token`'s own
 * default produces — `encode(gen_random_bytes(32), 'hex')` in 0009. Matching
 * the format matters: `bookings_guest_token_length` requires at least 32
 * characters, and a token that looked different from every other one in the
 * table would be a tell about which bookings had been rotated.
 *
 * `crypto.getRandomValues`, never `Math.random`, for the reason
 * `src/lib/invitations/token.ts` sets out at length. Web Crypto rather than
 * `node:crypto` because nothing else in `src/lib` imports a Node builtin.
 *
 * Unlike an invitation token this is stored in the clear, and 0033 explains
 * why at length: a guest link is a bookmark opened on the day it is sent,
 * again the night before arrival, and once more from a different telephone.
 * A digest would make "copy the guest link" impossible without minting a new
 * one and breaking the guest's bookmark.
 */
export function mintGuestToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------- failures -- */

/** The link is revoked, so sending it again would send something dead. */
export class GuestLinkRevokedError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest_link.revoked',
      message: 'refused to send a revoked guest link',
      userMessage:
        'הקישור להזמנה הזו בוטל, ולכן אי אפשר לשלוח אותו. הנפק קישור חדש ואז שלח.',
    })
  }
}

/** Reviving a link nobody revoked. Refused so the audit trail stays truthful. */
export class GuestLinkNotRevokedError extends BusinessRuleError {
  constructor() {
    super({
      code: 'guest_link.not_revoked',
      message: 'refused to restore a link that was never revoked',
      userMessage: 'הקישור להזמנה הזו פעיל, ואין מה לשחזר.',
    })
  }
}

/* -------------------------------------------------------------- loading -- */

/** What every operation here needs to know about the booking it is acting on. */
type BookingLinkRow = {
  id: string
  organizationId: string
  propertyId: string
  reference: string
  revokedAt: string | null
  sendCount: number
}

async function loadBookingLink(
  db: Db,
  bookingId: string,
): Promise<BookingLinkRow | null> {
  const { data, error } = await db
    .from('bookings')
    .select(
      'id, organization_id, property_id, reference, guest_link_revoked_at, guest_link_send_count',
    )
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = toRow(data)
  const count = row.guest_link_send_count
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    reference: asString(row, 'reference'),
    revokedAt: asTimestampOrNull(row, 'guest_link_revoked_at'),
    sendCount: typeof count === 'number' ? count : 0,
  }
}

/* ----------------------------------------------------------- send a link -- */

export type GuestLinkSendInput = {
  bookingId: string
  channel: GuestLinkChannel
  /**
   * The number or address it went to, unmasked. Masked before it is stored —
   * see `maskRecipient`. Null for `copy`, where there is no recipient to
   * record because the operator chose it themselves.
   */
  recipient: string | null
}

export type GuestLinkSendResult = {
  sendId: string
  sentAt: string
  /** How many times this link has now been sent, including this one. */
  sendCount: number
}

export type GuestLinkRotateInput = { bookingId: string }
export type GuestLinkRotateResult = { bookingId: string; token: string }

export type GuestLinkRevokeInput = { bookingId: string }
export type GuestLinkRevokeResult = { bookingId: string; revokedAt: string }

export type GuestArrivalReleaseInput = { bookingId: string }
export type GuestArrivalReleaseResult = {
  bookingId: string
  releasedAt: string
}

export type GuestJourneyOperations = {
  recordGuestLinkSend: Operation<
    GuestLinkSendInput,
    BookingLinkRow,
    GuestLinkSendResult
  >
  rotateGuestLink: Operation<
    GuestLinkRotateInput,
    BookingLinkRow,
    GuestLinkRotateResult
  >
  revokeGuestLink: Operation<
    GuestLinkRevokeInput,
    BookingLinkRow,
    GuestLinkRevokeResult
  >
  restoreGuestLink: Operation<
    GuestLinkRevokeInput,
    BookingLinkRow,
    GuestLinkRevokeResult
  >
  releaseArrivalInfo: Operation<
    GuestArrivalReleaseInput,
    BookingLinkRow,
    GuestArrivalReleaseResult
  >
}

const BOOKING_ONLY = s.object({ bookingId: s.uuid({ label: 'הזמנה' }) })

export function defineGuestJourneyOperations(options: {
  db: Db
}): GuestJourneyOperations {
  const { db } = options

  /** Shared by every operation here: the booking, and its authorization view. */
  const loadBooking = async ({ input }: { input: { bookingId: string } }) => {
    const entity = await loadBookingLink(db, input.bookingId)
    if (!entity) return null
    return {
      resource: {
        organizationId: entity.organizationId,
        propertyId: entity.propertyId,
        resourceId: entity.id,
      },
      entity,
    }
  }

  /* ------------------------------------------------------------- send -- */

  const recordGuestLinkSend = defineOperation<
    GuestLinkSendInput,
    BookingLinkRow,
    GuestLinkSendResult
  >({
    name: 'guest_journey.link_send',
    // Sending a link to a guest is sending a message. The catalogue already
    // separates that from editing the booking, and `guest_link_sends_insert`
    // requires exactly this grant — so the engine and the floor agree.
    permission: 'message.send',
    resourceType: 'booking',
    input: s.object({
      bookingId: s.uuid({ label: 'הזמנה' }),
      channel: s.enumOf(GUEST_LINK_CHANNELS, { label: 'ערוץ' }),
      recipient: s.nullable(s.string({ label: 'נמען', max: 320 })),
    }),
    loadResource: loadBooking,

    rule({ entity }) {
      // A revoked link resolves to a refusal for the guest, so sending it
      // would be posting somebody a door that does not open.
      if (entity.revokedAt !== null) throw new GuestLinkRevokedError()
    },

    async execute({ input, entity, context, tx, now }) {
      const client = clientFor(tx, db)

      const { data, error } = await client
        .from('guest_link_sends')
        .insert({
          organization_id: entity.organizationId,
          booking_id: entity.id,
          channel: input.channel,
          // Masked on the way in, never afterwards. See `link.ts`.
          recipient_masked: maskRecipient(input.recipient),
          sent_by: context.actor.userId,
          after_rotation: entity.sendCount === 0,
        })
        .select('id, sent_at')
        .single()

      if (error) throw error
      recordWrite(tx, 'guest_link_sends.insert')

      const sendCount = entity.sendCount + 1

      const { error: stampError } = await client
        .from('bookings')
        .update({
          guest_link_sent_at: now.toISOString(),
          guest_link_send_count: sendCount,
        })
        .eq('id', entity.id)

      if (stampError) throw stampError
      recordWrite(tx, 'bookings.guest_link_sent')

      const row = toRow(data)
      return {
        sendId: asString(row, 'id'),
        sentAt: asString(row, 'sent_at'),
        sendCount,
      }
    },

    audit({ input, entity, result }) {
      const channel = input.channel
      const ordinal =
        result.sendCount === 1 ? 'לראשונה' : `בפעם ה-${result.sendCount}`
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        after: {
          channel,
          sendCount: result.sendCount,
          recipient: maskRecipient(input.recipient),
        },
        summary: `קישור האורח להזמנה ${entity.reference} נשלח ${ordinal} בערוץ ${channel}`,
      }
    },

    events({ input, entity, result }) {
      // `payment.instructions_sent` has been in the frozen catalogue with no
      // emitter since the collection policy landed, and this is where it
      // belongs: in this product the guest link IS how payment instructions
      // reach a guest. The portal renders the organization's manual channels —
      // the bank details, the Bit number — behind that link, so the moment it
      // is sent is the moment the instructions were delivered.
      //
      // Raised on every send rather than only when money is outstanding. This
      // operation deliberately does not resolve the collection policy — that is
      // `resolveCollectionPolicy`'s job and duplicating it here to decide
      // whether to raise an event is exactly the second opinion the one-resolver
      // rule forbids. A subscriber that cares can resolve it itself.
      //
      // Still missing from the catalogue, and reported rather than invented:
      // `guest.link_sent`, `guest.link_revoked`, `guest.link_rotated`,
      // `guest.confirmed`, `guest.reconfirmation_required`,
      // `guest.details_submitted`. The audit events above are written
      // regardless, so every act is traceable today; what is absent is only the
      // hook an automation could hang off.
      return [
        {
          name: 'payment.instructions_sent' as const,
          propertyId: entity.propertyId,
          payload: {
            bookingId: entity.id,
            reference: entity.reference,
            channel: input.channel,
            sendCount: result.sendCount,
          },
        },
      ]
    },
  })

  /* ----------------------------------------------------------- rotate -- */

  const rotateGuestLink = defineOperation<
    GuestLinkRotateInput,
    BookingLinkRow,
    GuestLinkRotateResult
  >({
    name: 'guest_journey.link_rotate',
    permission: 'booking.update',
    resourceType: 'booking',
    input: BOOKING_ONLY,
    // See the header. `booking.update` is not a sensitive action, and this
    // particular use of it is.
    requiresReason: true,
    loadResource: loadBooking,

    async execute({ entity, tx, now }) {
      const client = clientFor(tx, db)
      const token = mintGuestToken()

      const { error } = await client
        .from('bookings')
        .update({
          guest_token: token,
          guest_link_rotated_at: now.toISOString(),
          // Rotation un-revokes: minting a new link is how somebody undoes a
          // revocation, and leaving the flag set would produce a fresh token
          // that refuses on first use.
          guest_link_revoked_at: null,
          guest_link_revoked_by: null,
          // Cleared, because they describe a link that no longer works. See
          // the header.
          guest_link_first_opened_at: null,
          guest_link_last_opened_at: null,
          guest_link_sent_at: null,
          guest_link_send_count: 0,
        })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'bookings.guest_link_rotated')

      return { bookingId: entity.id, token }
    },

    audit({ entity, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        // The token itself is NEVER in the audit row. An audit event is read
        // by more people than the booking is, and a credential in it is a
        // credential in a report.
        after: { rotated: true },
        reason: context.reason ?? null,
        summary: `קישור האורח להזמנה ${entity.reference} הונפק מחדש. כל העותקים הקודמים הפסיקו לעבוד`,
      }
    },
  })

  /* ----------------------------------------------------------- revoke -- */

  const revokeGuestLink = defineOperation<
    GuestLinkRevokeInput,
    BookingLinkRow,
    GuestLinkRevokeResult
  >({
    name: 'guest_journey.link_revoke',
    permission: 'booking.update',
    resourceType: 'booking',
    input: BOOKING_ONLY,
    requiresReason: true,
    loadResource: loadBooking,

    async execute({ entity, context, tx, now }) {
      const client = clientFor(tx, db)
      const revokedAt = now.toISOString()

      // Revocation is not deletion — 0033 is explicit that the row keeps its
      // token so an attempt to use it is a refusal somebody can see, rather
      // than a lookup that finds nothing and looks the same as a typo.
      const { error } = await client
        .from('bookings')
        .update({
          guest_link_revoked_at: revokedAt,
          guest_link_revoked_by: context.actor.userId,
        })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'bookings.guest_link_revoked')

      return { bookingId: entity.id, revokedAt }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        after: { revokedAt: result.revokedAt },
        reason: context.reason ?? null,
        summary: `קישור האורח להזמנה ${entity.reference} בוטל`,
      }
    },
  })

  const restoreGuestLink = defineOperation<
    GuestLinkRevokeInput,
    BookingLinkRow,
    GuestLinkRevokeResult
  >({
    name: 'guest_journey.link_restore',
    permission: 'booking.update',
    resourceType: 'booking',
    input: BOOKING_ONLY,
    requiresReason: true,
    loadResource: loadBooking,

    rule({ entity }) {
      // Refused rather than treated as a no-op: an audit row saying a link was
      // restored when it was never revoked is a false statement about the
      // record, and the person pressing it has misread the screen.
      if (entity.revokedAt === null) throw new GuestLinkNotRevokedError()
    },

    async execute({ entity, tx, now }) {
      const client = clientFor(tx, db)

      const { error } = await client
        .from('bookings')
        .update({ guest_link_revoked_at: null, guest_link_revoked_by: null })
        .eq('id', entity.id)

      if (error) throw error
      recordWrite(tx, 'bookings.guest_link_restored')

      return { bookingId: entity.id, revokedAt: now.toISOString() }
    },

    audit({ entity, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        after: { revokedAt: null },
        reason: context.reason ?? null,
        summary: `הביטול של קישור האורח להזמנה ${entity.reference} בוטל, והקישור פעיל שוב`,
      }
    },
  })

  /* -------------------------------------------- release arrival by hand -- */

  const releaseArrivalInfo = defineOperation<
    GuestArrivalReleaseInput,
    BookingLinkRow,
    GuestArrivalReleaseResult
  >({
    name: 'guest_journey.arrival_release',
    permission: 'booking.update',
    resourceType: 'booking',
    input: BOOKING_ONLY,
    // Disclosing an address and a door code early is a decision, and the
    // person making it should have to say why.
    requiresReason: true,
    loadResource: loadBooking,

    async execute({ entity, context, tx, now }) {
      const client = clientFor(tx, db)
      const releasedAt = now.toISOString()

      // Upsert: the journey row is created the first time anything is stamped
      // on it, and a manual release is often the first thing.
      const { error } = await client.from('booking_guest_journey').upsert(
        {
          booking_id: entity.id,
          organization_id: entity.organizationId,
          manual_released_at: releasedAt,
          manual_released_by: context.actor.userId,
          updated_at: releasedAt,
        },
        { onConflict: 'booking_id' },
      )

      if (error) throw error
      recordWrite(tx, 'booking_guest_journey.manual_release')

      return { bookingId: entity.id, releasedAt }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: entity.id,
        propertyId: entity.propertyId,
        after: { manualReleasedAt: result.releasedAt },
        reason: context.reason ?? null,
        summary: `פרטי ההגעה להזמנה ${entity.reference} שוחררו ידנית לאורח`,
      }
    },
  })

  return {
    recordGuestLinkSend,
    rotateGuestLink,
    revokeGuestLink,
    restoreGuestLink,
    releaseArrivalInfo,
  }
}
