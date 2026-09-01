/**
 * EXECUTION CONTEXT — SERVER ONLY. The journey as a member of staff sees it.
 *
 * ── The question this exists to answer ────────────────────────────────────
 *
 * "Sent and never opened" against "opened three times and still not
 * confirmed". Those are different problems that lead to different actions —
 * the first is a wrong telephone number, the second is a guest with a
 * question they have not asked — and until 0033 added
 * `guest_link_first_opened_at` and `guest_link_last_opened_at` the product
 * could not tell them apart. This is the read that puts them on a screen.
 *
 * ── Every read here is an ordinary authenticated read ─────────────────────
 *
 * No SECURITY DEFINER, no token. A member of staff has a membership, so row
 * level security answers this the way it answers everything else: the policies
 * in §12 of migration 0034 gate each table on `booking.view` or `task.view`
 * within `my_organizations()`. That is the whole difference between this file
 * and `journey.ts`, and it is why they are two files.
 *
 * ── Degrading when 0034 is not applied ────────────────────────────────────
 *
 * Migration 0034 is written and handed to the coordinator to apply; it is not
 * in the database yet. A booking detail screen that threw because a table did
 * not exist would take out a page that works today, so a missing relation is
 * caught, reported once, and rendered as "not available yet" — while every
 * other failure propagates. Same narrow, named fallback as `collection.ts`,
 * and it disappears the moment the migration lands.
 */

import {
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
} from '../persistence'

import type { GuestLinkChannel, GuestRequestState } from './types'

export type GuestLinkSend = {
  id: string
  channel: GuestLinkChannel
  recipientMasked: string | null
  sentAt: string
  afterRotation: boolean
}

/**
 * Which steps this business actually requires of this guest.
 *
 * Resolved here rather than passed in by the caller, for the same reason the
 * guest's own progress list omits rather than disables: a booking screen
 * showing "חוזה: לא נחתם" for a business that has no contract is a permanent
 * false alarm, and the third time somebody chases it they stop reading the
 * card. Making the mount one line also means the caller cannot get it wrong.
 */
export type AdminJourneyRequires = {
  confirmation: boolean
  contract: boolean
  details: boolean
}

export type AdminJourneyView = {
  bookingId: string
  /** Present so the panel can build a copyable link. Never logged. */
  token: string
  reference: string
  guestName: string | null
  guestPhone: string | null
  guestEmail: string | null

  requires: AdminJourneyRequires

  sentAt: string | null
  sendCount: number
  firstOpenedAt: string | null
  lastOpenedAt: string | null
  revokedAt: string | null
  rotatedAt: string | null
  expiresAt: string | null

  sends: GuestLinkSend[]

  confirmedAt: string | null
  confirmedVersion: number | null
  contractSignedAt: string | null
  contractSignerName: string | null
  detailsSubmittedAt: string | null
  checkoutDeclaredAt: string | null
  manualReleasedAt: string | null

  openRequests: number
  totalRequests: number

  /** False when migration 0034 is not applied. The tab says so plainly. */
  journeyTablesReady: boolean
}

function isMissingRelation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  // Postgres `undefined_table`, and PostgREST's "not in the schema cache".
  if (code === '42P01' || code === 'PGRST205') return true

  // The demo's equivalent, for a table `dataset.ts` does not carry yet.
  // Matched on the name rather than with `instanceof` — see the note on the
  // same check in `collection.ts`.
  return (error as { name?: unknown }).name === 'MissingDemoTable'
}

let warnedAboutTables = false

function warnTablesMissing(): void {
  if (warnedAboutTables) return
  warnedAboutTables = true
  console.warn(
    '[guest-journey] the 0034 tables are not in this database, so the booking ' +
      "detail's guest journey tab is showing link telemetry only. Apply " +
      'supabase/migrations/0034_guest_journey.sql to complete it.',
  )
}

/**
 * Load the tab.
 *
 * Returns null when the booking is not readable, which for a member of staff
 * outside the tenant is indistinguishable from "does not exist" — and that is
 * the intended answer, for the reason the booking detail page already gives:
 * saying "you may not see this" confirms the booking exists.
 */
export async function loadAdminJourneyView(
  db: Db,
  bookingId: string,
): Promise<AdminJourneyView | null> {
  const { data, error } = await db
    .from('bookings')
    .select(
      'id, reference, organization_id, property_id, guest_token, ' +
        'guest_link_sent_at, guest_link_send_count, ' +
        'guest_link_first_opened_at, guest_link_last_opened_at, ' +
        'guest_link_revoked_at, guest_link_rotated_at, guest_link_expires_at, ' +
        'guests ( full_name, phone, phone_e164, email )',
    )
    .eq('id', bookingId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = toRow(data)
  const guest = toRow((row.guests as Record<string, unknown> | null) ?? {})

  const base: AdminJourneyView = {
    bookingId: asString(row, 'id'),
    token: asString(row, 'guest_token'),
    reference: asString(row, 'reference'),
    guestName: asStringOrNull(guest, 'full_name'),
    guestPhone:
      asStringOrNull(guest, 'phone_e164') ?? asStringOrNull(guest, 'phone'),
    guestEmail: asStringOrNull(guest, 'email'),

    // The shipped defaults, matching `guest_journey_effective_settings`'s own
    // fallback in §7 of the migration: confirmation only, no contract, no
    // details. Replaced below when a settings row exists.
    requires: { confirmation: true, contract: false, details: false },

    sentAt: asTimestampOrNull(row, 'guest_link_sent_at'),
    sendCount:
      typeof row.guest_link_send_count === 'number'
        ? row.guest_link_send_count
        : 0,
    firstOpenedAt: asTimestampOrNull(row, 'guest_link_first_opened_at'),
    lastOpenedAt: asTimestampOrNull(row, 'guest_link_last_opened_at'),
    revokedAt: asTimestampOrNull(row, 'guest_link_revoked_at'),
    rotatedAt: asTimestampOrNull(row, 'guest_link_rotated_at'),
    expiresAt: asTimestampOrNull(row, 'guest_link_expires_at'),

    sends: [],
    confirmedAt: null,
    confirmedVersion: null,
    contractSignedAt: null,
    contractSignerName: null,
    detailsSubmittedAt: null,
    checkoutDeclaredAt: null,
    manualReleasedAt: null,
    openRequests: 0,
    totalRequests: 0,
    journeyTablesReady: true,
  }

  try {
    const [
      sends,
      confirmation,
      signature,
      details,
      journey,
      requests,
      settings,
    ] = await Promise.all([
      db
        .from('guest_link_sends')
        .select('id, channel, recipient_masked, sent_at, after_rotation')
        .eq('booking_id', bookingId)
        .order('sent_at', { ascending: false })
        .limit(20),
      db
        .from('booking_guest_confirmations')
        .select('confirmed_at, booking_version')
        .eq('booking_id', bookingId)
        .is('superseded_at', null)
        .order('confirmed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from('booking_contract_signatures')
        .select('signed_at, signer_name')
        .eq('booking_id', bookingId)
        .is('superseded_at', null)
        .maybeSingle(),
      db
        .from('booking_guest_details')
        .select('submitted_at')
        .eq('booking_id', bookingId)
        .maybeSingle(),
      db
        .from('booking_guest_journey')
        .select('checkout_declared_at, manual_released_at')
        .eq('booking_id', bookingId)
        .maybeSingle(),
      db.from('guest_requests').select('id, state').eq('booking_id', bookingId),
      // Both scopes in one read. The property row wins where it exists and
      // the organization default is the fallback — the same precedence
      // `guest_journey_effective_settings` applies in SQL, resolved here in
      // one round trip rather than two sequential ones.
      db
        .from('guest_journey_settings')
        .select(
          'property_id, contract_mode, require_guest_confirmation, required_detail_fields',
        )
        .eq('organization_id', asString(row, 'organization_id'))
        .or(
          `property_id.eq.${asString(row, 'property_id')},property_id.is.null`,
        ),
    ])

    for (const result of [
      sends,
      confirmation,
      signature,
      details,
      journey,
      requests,
      settings,
    ]) {
      if (result.error) throw result.error
    }

    const settingsRows = toRows(settings.data ?? [])
    // Property-specific first, organization default second.
    const effective =
      settingsRows.find((entry) => entry.property_id !== null) ??
      settingsRows.find((entry) => entry.property_id === null)

    if (effective) {
      const fields = effective.required_detail_fields
      base.requires = {
        confirmation: effective.require_guest_confirmation === true,
        contract: asString(effective, 'contract_mode') !== 'disabled',
        details: Array.isArray(fields) && fields.length > 0,
      }
    }

    base.sends = toRows(sends.data ?? []).map((send) => ({
      id: asString(send, 'id'),
      channel: asString(send, 'channel') as GuestLinkChannel,
      recipientMasked: asStringOrNull(send, 'recipient_masked'),
      sentAt: asString(send, 'sent_at'),
      afterRotation: send.after_rotation === true,
    }))

    if (confirmation.data) {
      const found = toRow(confirmation.data)
      base.confirmedAt = asTimestampOrNull(found, 'confirmed_at')
      base.confirmedVersion =
        typeof found.booking_version === 'number' ? found.booking_version : null
    }

    if (signature.data) {
      const found = toRow(signature.data)
      base.contractSignedAt = asTimestampOrNull(found, 'signed_at')
      base.contractSignerName = asStringOrNull(found, 'signer_name')
    }

    if (details.data) {
      base.detailsSubmittedAt = asTimestampOrNull(
        toRow(details.data),
        'submitted_at',
      )
    }

    if (journey.data) {
      const found = toRow(journey.data)
      base.checkoutDeclaredAt = asTimestampOrNull(found, 'checkout_declared_at')
      base.manualReleasedAt = asTimestampOrNull(found, 'manual_released_at')
    }

    const rows = toRows(requests.data ?? [])
    base.totalRequests = rows.length
    base.openRequests = rows.filter((request) => {
      const state = asString(request, 'state') as GuestRequestState
      return state === 'received' || state === 'in_progress'
    }).length
  } catch (cause) {
    if (!isMissingRelation(cause)) throw cause
    warnTablesMissing()
    base.journeyTablesReady = false
  }

  return base
}
