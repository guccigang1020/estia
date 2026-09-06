/**
 * EXECUTION CONTEXT — SERVER ONLY, AND PRIVILEGED. Who a held guest message
 * was for, read fresh at sweep time.
 *
 * ══ WHY THIS EXISTS AT ALL ══════════════════════════════════════════════════
 *
 * `releaseDueMessages` will not take a snapshot's word for who the guest is.
 * A `scheduled_for` written at 22:10 is a claim about a world eight hours old,
 * and in between the guest can withdraw marketing consent, lose their
 * telephone number from the card, or have their booking removed. So the runner
 * asks a `GuestMessageSource` for the guest AS THEY ARE NOW, and refuses to
 * release without one.
 *
 * `autopilot/runtime/handlers.ts` records in `UNWIRED_COMMANDS` that no
 * implementation of this interface exists anywhere in the codebase. That is
 * still true of the COMMAND path — this is not it. This is the sweep's own
 * reader, and it is deliberately the narrowest possible one.
 *
 * ══ A STUB HERE WOULD BE WORSE THAN NO SWEEP ═══════════════════════════════
 *
 * `null` from `load` is not "unknown". `release.ts` reads it as "the booking or
 * the guest is no longer readable" and writes the message off as `suppressed`.
 * A source that returned `null` because it had not been written yet would
 * therefore march through a tenant's held messages abandoning every one of
 * them, permanently, with a reason that is a lie. That is why this file reads
 * real rows and why it throws rather than shrugging when a read fails: an error
 * fails the pass and leaves the rows `deferred` for the next one, which is the
 * only safe way to be wrong here.
 *
 * ══ THE ADMIN CLIENT, AND THEREFORE THE FILTER ══════════════════════════════
 *
 * The sweep has no user, so it holds the admin client and no policy from
 * `0004_rls.sql` applies. Every query below filters `organization_id`
 * explicitly and that filter IS the tenant boundary here — a booking id from
 * one tenant's `guest_messages` row must never be able to read another
 * tenant's guest, and without the filter it could.
 *
 * ══ WHAT IS READ, AND WHAT IS NOT ═══════════════════════════════════════════
 *
 * The recipient — a first name, a telephone number, an e-mail address, a
 * consent flag — because the gates ask about exactly those. Nothing here is
 * logged, counted, or returned to the caller of the route: the sweep's summary
 * carries numbers, and `route.ts` says so.
 *
 * `GuestMessageSubject` is required by the interface and is NOT read by the
 * release path — nothing in a sweep re-renders a body, because `compose.ts`
 * froze it at 22:10 on purpose. It is assembled from the booking's own columns
 * rather than invented, so that the day a caller does read it, it is true.
 * `portalUrl` and `outstandingAgorot` are `null` because this pass genuinely
 * does not know them, and `null` is the interface's own word for that.
 */

import type {
  GuestMessageSource,
  GuestMessageSubject,
  GuestRecipient,
} from '@/lib/messaging'
import {
  asBoolean,
  asString,
  asStringOrNull,
  toRow,
  type Db,
  type Row,
} from '@/lib/persistence'

const BOOKING_COLUMNS =
  'id, organization_id, property_id, guest_id, reference, check_in, check_out'

const GUEST_COLUMNS =
  'id, first_name, phone, email, marketing_consent, language'

/**
 * One booking's guest, and what the message was about.
 *
 * Four small statements rather than one embedded select. `bookings` names
 * `guests`, `organizations` and `properties` through both a plain and a
 * composite foreign key, so a PostgREST embed would have to disambiguate the
 * relationship by name — a hint that is correct until somebody renames a
 * constraint, and wrong silently rather than loudly. The rows a sweep touches
 * are few by construction and the names are cached per pass, so the extra
 * round trips cost a sweep almost nothing and cost a reader no guessing.
 */
export class SweepGuestSource implements GuestMessageSource {
  private readonly organizationNames = new Map<string, string>()
  private readonly propertyNames = new Map<string, string | null>()

  constructor(private readonly db: Db) {}

  async load(
    organizationId: string,
    bookingId: string,
  ): Promise<{
    recipient: GuestRecipient
    subject: GuestMessageSubject
  } | null> {
    const booking = await this.readOne(
      'bookings',
      BOOKING_COLUMNS,
      organizationId,
      bookingId,
    )
    // Cancelled and cleared, or never visible to this tenant. Either way there
    // is nobody to send to, and `release.ts` records that rather than sending.
    if (booking === null) return null

    const guestId = asString(booking, 'guest_id')
    const guest = await this.readOne(
      'guests',
      GUEST_COLUMNS,
      organizationId,
      guestId,
    )
    if (guest === null) return null

    const propertyId = asStringOrNull(booking, 'property_id')

    return {
      recipient: {
        guestId,
        // First name only, matching what 0033 discloses to a guest's own
        // portal. A sweep has no reason to hold a full legal name.
        firstName: asStringOrNull(guest, 'first_name'),
        phone: asStringOrNull(guest, 'phone'),
        email: asStringOrNull(guest, 'email'),
        marketingConsent: asBoolean(guest, 'marketing_consent'),
        language: asString(guest, 'language'),
      },
      subject: {
        bookingId,
        propertyId,
        reference: asString(booking, 'reference'),
        organizationName: await this.organizationName(organizationId),
        propertyName: await this.propertyName(organizationId, propertyId),
        // The `date` columns as Postgres returns them. This module does not
        // own date wording and the sweep never renders one — see the header.
        checkIn: asString(booking, 'check_in'),
        checkOut: asString(booking, 'check_out'),
        // Not known here, and not guessed. The guest portal's host is not
        // something a background pass can claim to know, and the outstanding
        // balance is a figure only the payment module may state.
        portalUrl: null,
        outstandingAgorot: null,
      },
    }
  }

  /**
   * One row by id, within one tenant.
   *
   * `maybeSingle`, so "not there" is `null` rather than an error — the whole
   * point of this read is that the row may have gone. A real database error
   * still throws, which fails the pass and leaves the messages `deferred`.
   */
  private async readOne(
    table: string,
    columns: string,
    organizationId: string,
    id: string,
  ): Promise<Row | null> {
    const { data, error } = await this.db
      .from(table)
      .select(columns)
      // The tenant boundary. See the header.
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? toRow(data) : null
  }

  private async organizationName(organizationId: string): Promise<string> {
    const cached = this.organizationNames.get(organizationId)
    if (cached !== undefined) return cached

    const { data, error } = await this.db
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .maybeSingle()

    if (error) throw error

    const name = data ? asString(toRow(data), 'name') : ''
    this.organizationNames.set(organizationId, name)
    return name
  }

  private async propertyName(
    organizationId: string,
    propertyId: string | null,
  ): Promise<string | null> {
    if (propertyId === null) return null

    const cached = this.propertyNames.get(propertyId)
    if (cached !== undefined) return cached

    const row = await this.readOne(
      'properties',
      'id, organization_id, name',
      organizationId,
      propertyId,
    )
    const name = row === null ? null : asString(row, 'name')
    this.propertyNames.set(propertyId, name)
    return name
  }
}
