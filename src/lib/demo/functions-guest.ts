/**
 * The guest journey's database functions, reproduced for the demo.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 *
 * `client.ts` holds the demo's own machinery — the query builder, the row
 * shapes, the two triggers it reproduces — and it belongs to the coordinator
 * because every screen reaches it. The guest journey's functions are a
 * different kind of thing: each one mirrors a specific `SECURITY DEFINER`
 * function in migration 0034, and getting one subtly wrong means a demo that
 * teaches the wrong behaviour to whoever reads it next.
 *
 * ── What a function in here must get right ────────────────────────────────
 *
 * Not the privilege — the demo has no row level security, and reproducing
 * `anon` would be theatre. Three things instead:
 *
 *   · **the projection.** Return exactly the keys the real function returns.
 *     A demo that hands back a whole row lets a screen read fields production
 *     withholds, and nobody finds out until it is live.
 *   · **the refusals, and their order.** Throw `DemoRpcError` with the same
 *     machine code and the same Hebrew hint the migration raises. A refusal
 *     path that cannot be reached in the demo is a refusal path nobody looks
 *     at, and these are the ones a guest meets: the revoked link, the expired
 *     one, the stale confirmation.
 *   · **the gating.** In production the address, the directions and the access
 *     code are withheld by `guest_arrival_released` in SQL, and the page has
 *     no `if` that could leak them because the value is not in the payload.
 *     That property has to survive into the demo, or the demo becomes the
 *     place somebody "checks" the rule and sees it pass for the wrong reason.
 *     So `arrivalReleased` below is a transcription of the SQL function,
 *     overrides and all, and every gated key is emitted as `null` rather than
 *     omitted — exactly as `case when … end` does.
 *
 * ── Where the rows live until the dataset carries them ────────────────────
 *
 * The nine tables migration 0034 creates are not in `dataset.ts` yet, so
 * `tableRows` below falls back to a per-database side store rather than
 * throwing `MissingDemoTable`. That fallback retires itself: the moment the
 * dataset carries a table, `db.has` is true and the side store is never
 * consulted for it. It is keyed on the `DemoDatabase` so the shared demo and
 * the fresh copies tests make never see each other's writes.
 */

import { DemoRpcError, type DemoDatabase, type DemoRpcFunction } from './client'
import type { DemoRow } from './types'

/* ------------------------------------------------------------- plumbing -- */

/**
 * A local `looseEquals`, because `client.ts` does not export its own.
 *
 * Ids in the demo are strings everywhere, but a value that has been through
 * JSON may come back a number, and `'1' === 1` is false in a way that produces
 * an empty screen rather than an error. Duplicated deliberately: `client.ts`
 * is the coordinator's, and a one-line predicate is cheaper to copy than a
 * cross-file change is to coordinate.
 */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left == null || right == null) return false
  return String(left) === String(right)
}

const sideTables = new WeakMap<DemoDatabase, Map<string, DemoRow[]>>()

/** The live array for a table, whether or not the dataset declares it yet. */
function tableRows(db: DemoDatabase, table: string): DemoRow[] {
  if (db.has(table)) return db.rows(table)

  let tables = sideTables.get(db)
  if (!tables) {
    tables = new Map()
    sideTables.set(db, tables)
  }

  let rows = tables.get(table)
  if (!rows) {
    rows = []
    tables.set(table, rows)
  }
  return rows
}

function nowIso(): string {
  return new Date().toISOString()
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function findRow(
  db: DemoDatabase,
  table: string,
  predicate: (row: DemoRow) => boolean,
): DemoRow | undefined {
  return tableRows(db, table).find(predicate)
}

/* ----------------------------------------------------- resolving a token -- */

/**
 * `public.guest_link_booking`, transcribed.
 *
 * The same four refusals as 0033 and 0034, in the same order — malformed,
 * unknown or deleted, revoked, expired. The order matters: a guest told "not
 * found" retypes the link, and a guest told "revoked" telephones the business.
 */
function resolveBooking(db: DemoDatabase, token: string): DemoRow {
  if (token.trim().length < 32) {
    throw new DemoRpcError(
      'guest_link_not_found',
      'הקישור אינו תקין. בקש מבית האירוח לשלוח קישור חדש.',
    )
  }

  const booking = db.has('bookings')
    ? db.rows('bookings').find((row) => same(row.guest_token, token))
    : undefined

  if (!booking || booking.deleted_at != null) {
    throw new DemoRpcError(
      'guest_link_not_found',
      'לא מצאנו את ההזמנה. ייתכן שהקישור הועתק חלקית.',
    )
  }

  if (booking.guest_link_revoked_at != null) {
    throw new DemoRpcError(
      'guest_link_revoked',
      'הקישור בוטל. פנה לבית האירוח לקבלת קישור חדש.',
    )
  }

  const expiresAt = booking.guest_link_expires_at
  if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) {
    throw new DemoRpcError(
      'guest_link_expired',
      'תוקף הקישור פג. פנה לבית האירוח לקבלת קישור חדש.',
    )
  }

  return booking
}

/* -------------------------------------------------------------- settings -- */

type EffectiveSettings = {
  contractMode: string
  requireGuestConfirmation: boolean
  requiredDetailFields: string[]
  optionalDetailFields: string[]
  arrivalRelease: string
  arrivalReleaseHours: number
  duringStayTopics: string[]
  requestsEnabled: boolean
  requestCategories: string[]
  checkoutDeclarationEnabled: boolean
  reviewEnabled: boolean
  reviewUrl: string | null
  rebookEnabled: boolean
  reconfirmationTriggers: string[]
}

const REQUEST_CATEGORIES = [
  'towels',
  'linen',
  'cleaning',
  'maintenance',
  'equipment',
  'other',
]

/**
 * The shipped defaults, matching `guest_journey_effective_settings`'s own
 * fallback: the quietest journey the product can offer — confirmation only,
 * no contract, no details. A business that has never opened the settings
 * screen still gets a working portal and is shown nothing it did not ask for.
 */
const SHIPPED_DEFAULTS: EffectiveSettings = {
  contractMode: 'disabled',
  requireGuestConfirmation: true,
  requiredDetailFields: [],
  optionalDetailFields: [],
  arrivalRelease: 'after_confirmation',
  arrivalReleaseHours: 24,
  duringStayTopics: ['wifi', 'guide', 'access', 'checkout'],
  requestsEnabled: true,
  requestCategories: REQUEST_CATEGORIES,
  checkoutDeclarationEnabled: true,
  reviewEnabled: false,
  reviewUrl: null,
  rebookEnabled: false,
  reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
}

function list(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Property row, else organization default, else the shipped defaults. */
function effectiveSettings(
  db: DemoDatabase,
  organizationId: unknown,
  propertyId: unknown,
): EffectiveSettings {
  const rows = tableRows(db, 'guest_journey_settings').filter((row) =>
    same(row.organization_id, organizationId),
  )

  const found =
    rows.find((row) => same(row.property_id, propertyId)) ??
    rows.find((row) => row.property_id == null)

  if (!found) return SHIPPED_DEFAULTS

  return {
    contractMode: text(found.contract_mode) ?? 'disabled',
    requireGuestConfirmation: found.require_guest_confirmation !== false,
    requiredDetailFields: list(found.required_detail_fields, []),
    optionalDetailFields: list(found.optional_detail_fields, []),
    arrivalRelease: text(found.arrival_release) ?? 'after_confirmation',
    arrivalReleaseHours: count(found.arrival_release_hours ?? 24),
    duringStayTopics: list(
      found.during_stay_topics,
      SHIPPED_DEFAULTS.duringStayTopics,
    ),
    requestsEnabled: found.requests_enabled !== false,
    requestCategories: list(found.request_categories, REQUEST_CATEGORIES),
    checkoutDeclarationEnabled: found.checkout_declaration_enabled !== false,
    reviewEnabled: found.review_enabled === true,
    reviewUrl: text(found.review_url),
    rebookEnabled: found.rebook_enabled === true,
    reconfirmationTriggers: list(
      found.reconfirmation_triggers,
      SHIPPED_DEFAULTS.reconfirmationTriggers,
    ),
  }
}

/* ------------------------------------------------------------- the gate -- */

/**
 * `public.guest_arrival_released`, transcribed including both overrides.
 *
 * This is the security decision in migration 0034 and the reason the access
 * code is decided in the database rather than in a template. Reproduced with
 * the same shape so the demo cannot show a door code the real product would
 * withhold — which is the one way a demo can actively mislead.
 */
function arrivalReleased(input: {
  status: string
  release: string
  hours: number
  journey: DemoRow | undefined
  confirmed: boolean
  signed: boolean
  checkInAt: number
}): boolean {
  const journey = input.journey
  const manual = journey?.manual_released_at != null

  // A guest the business has already checked in is past the argument.
  const inHouse = [
    'checked_in',
    'in_house',
    'checkout_pending',
    'checked_out',
    'inspection',
    'deposit_release',
    'completed',
    'review_requested',
  ].includes(input.status)

  if (manual || inHouse) return true

  switch (input.release) {
    case 'immediate':
      return true
    case 'after_confirmation':
      return input.confirmed
    case 'after_contract':
      return input.signed
    // PORT — the payment module stamps these two. Null means shut, which is
    // the correct direction: an address not shown is a telephone call, and an
    // address shown early is a stranger at the door.
    case 'after_deposit':
      return journey?.deposit_settled_at != null
    case 'after_full_payment':
      return journey?.payment_settled_at != null
    case 'hours_before':
      return Date.now() >= input.checkInAt - input.hours * 3_600_000
    case 'manual':
      return manual
    default:
      return false
  }
}

/* ------------------------------------------------------------- the read -- */

function propertyOf(db: DemoDatabase, booking: DemoRow): DemoRow | undefined {
  return db.has('properties')
    ? db.rows('properties').find((row) => same(row.id, booking.property_id))
    : undefined
}

/** The active template: property-specific first, then the organization's. */
function activeTemplate(
  db: DemoDatabase,
  booking: DemoRow,
): DemoRow | undefined {
  const rows = tableRows(db, 'guest_contract_templates').filter(
    (row) =>
      same(row.organization_id, booking.organization_id) && row.is_active,
  )
  return (
    rows.find((row) => same(row.property_id, booking.property_id)) ??
    rows.find((row) => row.property_id == null)
  )
}

function checkInMillis(
  booking: DemoRow,
  property: DemoRow | undefined,
): number {
  const time =
    text(booking.arrival_time) ??
    text(property?.default_check_in_time) ??
    '15:00'
  const parsed = Date.parse(`${String(booking.check_in)}T${time.slice(0, 8)}`)
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/**
 * The stay has begun by the calendar or by the status, whichever comes first.
 *
 * An early check-in is ordinary, and a guest sitting on the sofa should not be
 * told the wifi is not available yet.
 */
function withinStay(booking: DemoRow): boolean {
  if (
    ['checked_in', 'in_house', 'checkout_pending'].includes(
      String(booking.status),
    )
  ) {
    return true
  }
  const today = new Date().toISOString().slice(0, 10)
  return (
    today >= String(booking.check_in ?? '') &&
    today < String(booking.check_out ?? '')
  )
}

/**
 * The journey row, created on first use.
 *
 * A booking acquires one the first time anything is stamped on it, and until
 * then every field is null — which is exactly what an unstarted journey means.
 */
function ensureJourney(db: DemoDatabase, booking: DemoRow): DemoRow {
  const rows = tableRows(db, 'booking_guest_journey')
  const existing = rows.find((row) => same(row.booking_id, booking.id))
  if (existing) return existing

  const created: DemoRow = {
    booking_id: booking.id,
    organization_id: booking.organization_id,
    access_code: null,
    manual_released_at: null,
    manual_released_by: null,
    deposit_settled_at: null,
    payment_settled_at: null,
    checkout_declared_at: null,
    details_completed_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  rows.push(created)
  return created
}

/* -------------------------------------------------------------- the map -- */

export const GUEST_JOURNEY_FUNCTIONS: Record<string, DemoRpcFunction> = {
  /**
   * Everything the portal renders, with every secret gated.
   *
   * The key list is the migration's `jsonb_build_object`, in the same order.
   * Each gated field is emitted as `null` when the policy says no — present
   * and null, exactly as `case when … end` produces, so a screen reading
   * `arrival.accessCode` gets the same shape in both worlds.
   */
  guest_portal_journey(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))
    const settings = effectiveSettings(
      db,
      booking.organization_id,
      booking.property_id,
    )

    const property = propertyOf(db, booking)
    const content = findRow(
      db,
      'guest_journey_content',
      (row) =>
        same(row.organization_id, booking.organization_id) &&
        same(row.property_id, booking.property_id),
    )
    const journey = findRow(db, 'booking_guest_journey', (row) =>
      same(row.booking_id, booking.id),
    )

    const confirmation = tableRows(db, 'booking_guest_confirmations')
      .filter(
        (row) => same(row.booking_id, booking.id) && row.superseded_at == null,
      )
      .sort((a, b) =>
        String(b.confirmed_at ?? '').localeCompare(
          String(a.confirmed_at ?? ''),
        ),
      )[0]

    const signature = findRow(
      db,
      'booking_contract_signatures',
      (row) => same(row.booking_id, booking.id) && row.superseded_at == null,
    )

    const details = findRow(db, 'booking_guest_details', (row) =>
      same(row.booking_id, booking.id),
    )

    const confirmed = confirmation != null
    const signed = signature != null
    const inStay = withinStay(booking)

    const released = arrivalReleased({
      status: String(booking.status),
      release: settings.arrivalRelease,
      hours: settings.arrivalReleaseHours,
      journey,
      confirmed,
      signed,
      checkInAt: checkInMillis(booking, property),
    })

    // Offered only while there is something to sign. After signing, the frozen
    // text is the only contract that exists here.
    const template =
      settings.contractMode !== 'disabled' && !signed
        ? activeTemplate(db, booking)
        : undefined

    const requests = tableRows(db, 'guest_requests')
      .filter((row) => same(row.booking_id, booking.id))
      .sort((a, b) =>
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
      )
      .map((row) => ({
        id: row.id,
        category: row.category,
        body: row.body ?? null,
        state: row.state,
        createdAt: row.created_at,
        completedAt: row.completed_at ?? null,
      }))

    return {
      settings: {
        contractMode: settings.contractMode,
        requireGuestConfirmation: settings.requireGuestConfirmation,
        requiredDetailFields: settings.requiredDetailFields,
        optionalDetailFields: settings.optionalDetailFields,
        arrivalRelease: settings.arrivalRelease,
        arrivalReleaseHours: settings.arrivalReleaseHours,
        duringStayTopics: settings.duringStayTopics,
        requestsEnabled: settings.requestsEnabled,
        requestCategories: settings.requestCategories,
        checkoutDeclarationEnabled: settings.checkoutDeclarationEnabled,
        reviewEnabled: settings.reviewEnabled,
        reviewUrl: settings.reviewUrl,
        rebookEnabled: settings.rebookEnabled,
        reconfirmationTriggers: settings.reconfirmationTriggers,
      },

      current: {
        bookingVersion: count(booking.version ?? 1),
        status: booking.status,
        checkIn: booking.check_in,
        checkOut: booking.check_out,
        adults: count(booking.adults),
        children: count(booking.children),
        infants: count(booking.infants),
        totalAgorot: count(booking.total_agorot),
        currency: booking.currency ?? 'ILS',
        cancellationTerms: text(property?.cancellation_policy_text),
        inStay,
      },

      confirmation: confirmed
        ? {
            confirmedAt: confirmation.confirmed_at,
            bookingVersion: count(confirmation.booking_version),
            snapshot: confirmation.snapshot ?? {},
          }
        : null,

      contract: {
        mode: settings.contractMode,
        template: template
          ? { title: template.title, body: template.body }
          : null,
        signature: signed
          ? {
              signedAt: signature.signed_at,
              signerName: signature.signer_name,
              title: signature.contract_title,
              body: signature.contract_body,
              bookingVersion: count(signature.booking_version),
            }
          : null,
      },

      details: {
        submittedAt: details?.submitted_at ?? null,
        fields: details?.fields ?? {},
      },

      // Gated. Present and null when withheld — never omitted, and never a
      // flag beside a value a template could read anyway.
      arrival: {
        released,
        checkInTime:
          text(booking.arrival_time) ??
          text(property?.default_check_in_time) ??
          null,
        addressNote: released ? (content?.address_note ?? null) : null,
        addressLine1: released ? (property?.address_line1 ?? null) : null,
        addressLine2: released ? (property?.address_line2 ?? null) : null,
        // The city is not gated: it is on the confirmation the guest already
        // has and in the property's public listing, so withholding it would be
        // theatre rather than protection.
        city: property?.city ?? null,
        directions: released ? (content?.directions ?? null) : null,
        mapUrl: released ? (content?.map_url ?? null) : null,
        parking: released ? (content?.parking ?? null) : null,
        accessInstructions: released
          ? (content?.access_instructions ?? null)
          : null,
        accessCode: released
          ? (journey?.access_code ?? content?.access_code ?? null)
          : null,
      },

      stay: {
        inStay,
        wifiNetwork: inStay ? (content?.wifi_network ?? null) : null,
        wifiPassword: inStay ? (content?.wifi_password ?? null) : null,
        propertyGuide: inStay ? (content?.property_guide ?? null) : null,
        houseRules: property?.house_rules ?? null,
        emergencyContact: inStay ? (content?.emergency_contact ?? null) : null,
      },

      requests,

      checkout: {
        checkOutTime: property?.default_check_out_time ?? null,
        instructions:
          inStay ||
          ['checkout_pending', 'checked_out'].includes(String(booking.status))
            ? (content?.checkout_instructions ?? null)
            : null,
        declaredAt: journey?.checkout_declared_at ?? null,
        enabled: settings.checkoutDeclarationEnabled,
      },
    }
  },

  /**
   * The guest's approval, against the version they were shown.
   *
   * Idempotent on `(booking_id, booking_version)` exactly as the unique
   * constraint is: confirming version 4 twice is one confirmation of version
   * 4, and the second call returns the first one's row with `created: false`.
   */
  guest_portal_confirm(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))
    const settings = effectiveSettings(
      db,
      booking.organization_id,
      booking.property_id,
    )

    if (!settings.requireGuestConfirmation) {
      throw new DemoRpcError(
        'guest_confirmation_not_required',
        'ההזמנה הזו אינה דורשת אישור שלך.',
      )
    }

    if (['cancelled', 'no_show'].includes(String(booking.status))) {
      throw new DemoRpcError(
        'guest_booking_not_confirmable',
        'ההזמנה בוטלה ולא ניתן לאשר אותה. פנה לבית האירוח.',
      )
    }

    const live = count(booking.version ?? 1)

    // The stale refusal. `guest-journey/journey.ts` reads the live version out
    // of the error's `details` so it can show the delta, so the demo has to
    // carry it there too — a refusal the caller cannot act on teaches nothing.
    if (count(args.p_booking_version) !== live) {
      const refusal = new DemoRpcError(
        'guest_confirmation_stale',
        'ההזמנה עודכנה מאז שפתחת את הדף. רענן כדי לראות את השינוי ולאשר מחדש.',
      )
      Object.assign(refusal, { details: String(live) })
      throw refusal
    }

    const rows = tableRows(db, 'booking_guest_confirmations')
    const existing = rows.find(
      (row) =>
        same(row.booking_id, booking.id) && count(row.booking_version) === live,
    )

    if (existing) {
      return {
        confirmationId: existing.id,
        confirmedAt: existing.confirmed_at,
        bookingVersion: count(existing.booking_version),
        created: false,
      }
    }

    const property = propertyOf(db, booking)

    // Frozen here rather than by the caller: a snapshot the client composed is
    // a snapshot the client could compose differently.
    const snapshot = {
      checkIn: booking.check_in,
      checkOut: booking.check_out,
      adults: count(booking.adults),
      children: count(booking.children),
      infants: count(booking.infants),
      totalAgorot: count(booking.total_agorot),
      currency: booking.currency ?? 'ILS',
      cancellationTerms: text(property?.cancellation_policy_text),
    }

    // Everything confirmed before this act is superseded by it, so the live
    // confirmation is always exactly one row.
    for (const row of rows) {
      if (same(row.booking_id, booking.id) && row.superseded_at == null) {
        row.superseded_at = nowIso()
        row.superseded_reason = 'reconfirmed'
      }
    }

    const created: DemoRow = {
      id: crypto.randomUUID(),
      organization_id: booking.organization_id,
      booking_id: booking.id,
      confirmed_at: nowIso(),
      booking_version: live,
      snapshot,
      confirmed_ip: null,
      confirmed_user_agent: text(args.p_user_agent),
      superseded_at: null,
      superseded_reason: null,
    }
    rows.push(created)
    ensureJourney(db, booking)

    return {
      confirmationId: created.id,
      confirmedAt: created.confirmed_at,
      bookingVersion: live,
      created: true,
    }
  },

  /**
   * Signing, with the terms frozen onto the signature row.
   *
   * The copy is the whole point: a signature that pointed at a template would
   * mean the terms a guest agreed to in March are whatever the template says
   * today. Idempotent through the one-live-signature rule.
   */
  guest_portal_sign_contract(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))
    const settings = effectiveSettings(
      db,
      booking.organization_id,
      booking.property_id,
    )

    // Disabled means the step does not exist — not "exists and is refused".
    if (settings.contractMode === 'disabled') {
      throw new DemoRpcError(
        'guest_contract_disabled',
        'אין חוזה לחתימה בהזמנה הזו.',
      )
    }

    const signerName = text(args.p_signer_name)
    const signatureText = text(args.p_signature_text)
    if (!signerName || !signatureText) {
      throw new DemoRpcError(
        'guest_signature_incomplete',
        'יש להזין שם מלא וחתימה.',
      )
    }

    const rows = tableRows(db, 'booking_contract_signatures')
    const existing = rows.find(
      (row) => same(row.booking_id, booking.id) && row.superseded_at == null,
    )

    if (existing) {
      return {
        signatureId: existing.id,
        signedAt: existing.signed_at,
        created: false,
      }
    }

    const template = activeTemplate(db, booking)
    if (!template) {
      throw new DemoRpcError(
        'guest_contract_unavailable',
        'נוסח החוזה אינו זמין כרגע. פנה לבית האירוח.',
      )
    }

    const created: DemoRow = {
      id: crypto.randomUUID(),
      organization_id: booking.organization_id,
      booking_id: booking.id,
      template_id: template.id,
      template_revision: count(template.revision ?? 1),
      contract_title: template.title,
      contract_body: template.body,
      signer_name: signerName,
      signer_id_number: text(args.p_signer_id_number),
      signature_text: signatureText,
      signed_at: nowIso(),
      booking_version: count(booking.version ?? 1),
      signed_ip: null,
      signed_user_agent: text(args.p_user_agent),
      superseded_at: null,
      superseded_reason: null,
    }
    rows.push(created)
    ensureJourney(db, booking)

    return {
      signatureId: created.id,
      signedAt: created.signed_at,
      created: true,
    }
  },

  /**
   * The details, as an upsert keyed on the booking.
   *
   * `submitted_at` is coalesced rather than overwritten: a guest correcting a
   * telephone number after completing the form has not withdrawn the form.
   */
  guest_portal_save_details(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))

    const fields = args.p_fields
    if (
      typeof fields !== 'object' ||
      fields === null ||
      Array.isArray(fields)
    ) {
      throw new DemoRpcError(
        'guest_details_invalid',
        'הפרטים שנשלחו אינם תקינים.',
      )
    }

    if (JSON.stringify(fields).length > 20_000) {
      throw new DemoRpcError(
        'guest_details_too_large',
        'הפרטים ארוכים מדי. קצר את התשובות ונסה שוב.',
      )
    }

    const complete = args.p_complete !== false
    const rows = tableRows(db, 'booking_guest_details')
    const stamp = nowIso()
    let row = rows.find((entry) => same(entry.booking_id, booking.id))

    if (row) {
      row.fields = fields
      row.submitted_at = row.submitted_at ?? (complete ? stamp : null)
      row.updated_at = stamp
    } else {
      row = {
        booking_id: booking.id,
        organization_id: booking.organization_id,
        fields,
        submitted_at: complete ? stamp : null,
        updated_at: stamp,
      }
      rows.push(row)
    }

    const journey = ensureJourney(db, booking)
    journey.details_completed_at =
      journey.details_completed_at ?? row.submitted_at ?? null
    journey.updated_at = stamp

    return { submittedAt: row.submitted_at ?? null, updatedAt: row.updated_at }
  },

  /**
   * A request, which becomes a task.
   *
   * Idempotent on the client key the compose form minted when it opened — the
   * one place a client supplies a key, because two genuine requests for towels
   * an hour apart are two requests and no column can tell them apart. The task
   * is created only on the path that creates the request, so a duplicate
   * cannot leave an orphan job on the board.
   */
  guest_portal_submit_request(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))
    const settings = effectiveSettings(
      db,
      booking.organization_id,
      booking.property_id,
    )

    if (!settings.requestsEnabled) {
      throw new DemoRpcError(
        'guest_requests_disabled',
        'לא ניתן לשלוח בקשות בהזמנה הזו.',
      )
    }

    const clientKey = text(args.p_client_key)
    if (!clientKey) {
      throw new DemoRpcError(
        'guest_request_key_missing',
        'לא ניתן לשלוח את הבקשה. רענן את הדף ונסה שוב.',
      )
    }

    const category = String(args.p_category ?? '')
    if (!REQUEST_CATEGORIES.includes(category)) {
      throw new DemoRpcError(
        'guest_request_category_unknown',
        'סוג הבקשה אינו מוכר. בחר מהרשימה.',
      )
    }
    if (!settings.requestCategories.includes(category)) {
      throw new DemoRpcError(
        'guest_request_category_unavailable',
        'סוג הבקשה הזה אינו זמין בהזמנה הזו.',
      )
    }

    const rows = tableRows(db, 'guest_requests')
    const existing = rows.find(
      (row) => same(row.booking_id, booking.id) && row.client_key === clientKey,
    )

    if (existing) {
      return { requestId: existing.id, state: existing.state, created: false }
    }

    const TITLE: Record<string, string> = {
      towels: 'מגבות',
      linen: 'מצעים',
      cleaning: 'ניקיון',
      maintenance: 'תחזוקה',
      equipment: 'ציוד',
      other: 'אחר',
    }

    const body = text(args.p_body)
    const stamp = nowIso()

    // The canonical engine, using the `guest_request` task type 0011 defined.
    let taskId: string | null = null
    if (db.has('tasks')) {
      taskId = crypto.randomUUID()
      db.rows('tasks').push({
        id: taskId,
        organization_id: booking.organization_id,
        property_id: booking.property_id,
        unit_id: booking.unit_id,
        booking_id: booking.id,
        task_type: 'guest_request',
        status: 'new',
        priority: category === 'maintenance' ? 'high' : 'normal',
        title: `בקשת אורח · ${TITLE[category]}`,
        description: body,
        requires_photo: false,
        metadata: {},
        created_at: stamp,
        updated_at: stamp,
        version: 1,
      })
    }

    const created: DemoRow = {
      id: crypto.randomUUID(),
      organization_id: booking.organization_id,
      booking_id: booking.id,
      property_id: booking.property_id,
      category,
      body,
      state: 'received',
      task_id: taskId,
      client_key: clientKey,
      created_at: stamp,
      updated_at: stamp,
      completed_at: null,
    }
    rows.push(created)

    return { requestId: created.id, state: 'received', created: true }
  },

  /**
   * "יצאנו מהנכס".
   *
   * Idempotent through the coalesce, and deliberately does not touch
   * `bookings.status` — a guest declaration is a signal to housekeeping, and
   * letting it move the booking would hand the state machine to somebody with
   * no account.
   */
  guest_portal_declare_checkout(db, args) {
    const booking = resolveBooking(db, String(args.p_token ?? ''))
    const settings = effectiveSettings(
      db,
      booking.organization_id,
      booking.property_id,
    )

    if (!settings.checkoutDeclarationEnabled) {
      throw new DemoRpcError(
        'guest_checkout_declaration_disabled',
        'ההצהרה על עזיבה אינה פעילה בהזמנה הזו.',
      )
    }

    const journey = ensureJourney(db, booking)
    journey.checkout_declared_at = journey.checkout_declared_at ?? nowIso()
    journey.updated_at = nowIso()

    return { declaredAt: journey.checkout_declared_at }
  },
}

// Re-exported so an implementation in this file can name the type it receives
// without reaching back into `client.ts` for it twice.
export type { DemoDatabase }
