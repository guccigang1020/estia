/**
 * The demo's transcription of migration 0034, held to the migration's rules.
 *
 * ── Why this suite exists ─────────────────────────────────────────────────
 *
 * `src/lib/demo/functions-guest.ts` reimplements six SECURITY DEFINER
 * functions in TypeScript. A reimplementation is a second copy of a rule, and
 * a second copy drifts — which matters more here than usual, because the demo
 * is where somebody goes to *check* how the guest journey behaves. A demo that
 * shows a door code the real product would withhold does not merely fail; it
 * actively teaches the wrong thing, and it teaches it to whoever is deciding
 * whether the rule is implemented.
 *
 * So the three properties that would be expensive to get wrong are asserted
 * against the demo implementation directly:
 *
 *   · the arrival gate withholds, and then releases, for the right reasons
 *   · every write is idempotent on the fact the migration made unique
 *   · a stale confirmation is refused, carrying the live version
 *
 * It lives in `src/lib/guest-journey` rather than beside the demo file because
 * the ownership register claims that file by name, and a test alongside it
 * would be unowned. The subject is this module's own rule either way.
 */

import { describe, expect, it } from 'vitest'

import { DemoDatabase } from '../demo/client'
import { GUEST_JOURNEY_FUNCTIONS } from '../demo/functions-guest'

const TOKEN = 'a'.repeat(64)
const ORG = 'org-1'
const PROPERTY = 'prop-1'
const BOOKING = 'booking-1'

type Journey = {
  arrival: { released: boolean; accessCode: string | null; city: string | null }
  current: { bookingVersion: number }
  confirmation: unknown
  stay: { wifiPassword: string | null }
}

/**
 * A database with one booking, one property and a door code on file.
 *
 * `status` is a parameter because the arrival gate has an override for a guest
 * the business has already checked in, and half of these cases turn on it.
 */
function database(
  options: {
    status?: string
    checkIn?: string
    checkOut?: string
    settings?: Record<string, unknown>
  } = {},
) {
  return new DemoDatabase({
    organizationId: ORG,
    tables: {
      bookings: [
        {
          id: BOOKING,
          organization_id: ORG,
          property_id: PROPERTY,
          unit_id: 'unit-1',
          guest_id: 'guest-1',
          reference: 'BK-AAA',
          status: options.status ?? 'confirmed',
          check_in: options.checkIn ?? '2099-09-03',
          check_out: options.checkOut ?? '2099-09-07',
          adults: 2,
          children: 0,
          infants: 0,
          currency: 'ILS',
          total_agorot: 750_000,
          guest_token: TOKEN,
          version: 4,
          deleted_at: null,
          guest_link_revoked_at: null,
          guest_link_expires_at: null,
        },
      ],
      properties: [
        {
          id: PROPERTY,
          organization_id: ORG,
          name: 'הבית בגליל',
          city: 'ראש פינה',
          address_line1: 'דרך הרימונים 14',
          cancellation_policy_text: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
          default_check_in_time: '15:00',
          default_check_out_time: '11:00',
        },
      ],
      guest_journey_content: [
        {
          organization_id: ORG,
          property_id: PROPERTY,
          access_code: '4821',
          wifi_password: 'shalom123',
          wifi_network: 'Galil-Guest',
          directions: 'מהכביש הראשי, שמאלה אחרי הרמזור.',
        },
      ],
      guest_journey_settings: options.settings
        ? [{ organization_id: ORG, property_id: null, ...options.settings }]
        : [],
      tasks: [],
    },
  })
}

const journeyOf = (db: DemoDatabase) =>
  GUEST_JOURNEY_FUNCTIONS.guest_portal_journey(db, {
    p_token: TOKEN,
  }) as Journey

describe('the arrival gate', () => {
  it('withholds the address and the code before confirmation', () => {
    const db = database()
    const journey = journeyOf(db)

    expect(journey.arrival.released).toBe(false)
    // Null because the function did not return it — not because a template
    // chose not to render it. That distinction is the whole design.
    expect(journey.arrival.accessCode).toBeNull()
    // The city is deliberately NOT gated: it is on the confirmation the guest
    // already holds, so withholding it would be theatre.
    expect(journey.arrival.city).toBe('ראש פינה')
  })

  it('releases them once the guest has confirmed', () => {
    const db = database()
    GUEST_JOURNEY_FUNCTIONS.guest_portal_confirm(db, {
      p_token: TOKEN,
      p_booking_version: 4,
    })

    const journey = journeyOf(db)
    expect(journey.arrival.released).toBe(true)
    expect(journey.arrival.accessCode).toBe('4821')
  })

  it('releases them for a guest already in the house, unconfirmed or not', () => {
    // Withholding a door code from somebody the business has checked in is not
    // a policy, it is a support call at eleven at night.
    const journey = journeyOf(database({ status: 'in_house' }))
    expect(journey.arrival.released).toBe(true)
    expect(journey.arrival.accessCode).toBe('4821')
  })

  it('keeps the gate shut for a deposit policy nothing has satisfied', () => {
    // `after_deposit` reads a timestamp the payment module stamps. Null means
    // shut, which is the correct direction to fail.
    const journey = journeyOf(
      database({ settings: { arrival_release: 'after_deposit' } }),
    )
    expect(journey.arrival.released).toBe(false)
    expect(journey.arrival.accessCode).toBeNull()
  })
})

describe('the wifi password follows the stay, not the booking', () => {
  it('is withheld before the stay begins', () => {
    expect(journeyOf(database()).stay.wifiPassword).toBeNull()
  })

  it('is available to a guest who has checked in early', () => {
    expect(
      journeyOf(database({ status: 'checked_in' })).stay.wifiPassword,
    ).toBe('shalom123')
  })
})

describe('idempotency', () => {
  it('confirms once however many times the button is tapped', () => {
    const db = database()
    const call = () =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_confirm(db, {
        p_token: TOKEN,
        p_booking_version: 4,
      }) as { confirmationId: string; created: boolean }

    const first = call()
    const second = call()

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    // The same row, not a second one that happens to look alike.
    expect(second.confirmationId).toBe(first.confirmationId)
  })

  it('creates one request and one task for a repeated client key', () => {
    const db = database()
    const call = () =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_submit_request(db, {
        p_token: TOKEN,
        p_category: 'towels',
        p_body: 'עוד שתי מגבות',
        p_client_key: 'key-1',
      }) as { requestId: string; created: boolean }

    const first = call()
    const second = call()

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.requestId).toBe(first.requestId)
    // The duplicate must not leave an orphan job on somebody's board.
    expect(db.rows('tasks')).toHaveLength(1)
  })

  it('takes a new client key as a genuinely new request', () => {
    const db = database()
    for (const key of ['key-1', 'key-2']) {
      GUEST_JOURNEY_FUNCTIONS.guest_portal_submit_request(db, {
        p_token: TOKEN,
        p_category: 'towels',
        p_body: null,
        p_client_key: key,
      })
    }
    expect(db.rows('tasks')).toHaveLength(2)
  })

  it('does not un-submit details when one field is corrected', () => {
    const db = database()
    const save = (fields: Record<string, string>) =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_save_details(db, {
        p_token: TOKEN,
        p_fields: fields,
      }) as { submittedAt: string | null }

    const first = save({ full_name: 'דנה כהן' })
    const second = save({ full_name: 'דנה כהן', phone: '0501234567' })

    expect(first.submittedAt).not.toBeNull()
    expect(second.submittedAt).toBe(first.submittedAt)
  })

  it('records one checkout declaration', () => {
    const db = database({ status: 'in_house' })
    const call = () =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_declare_checkout(db, {
        p_token: TOKEN,
      }) as { declaredAt: string }

    expect(call().declaredAt).toBe(call().declaredAt)
  })
})

describe('refusals', () => {
  it('refuses a confirmation against a version the guest never saw', () => {
    const db = database()

    // The reconfirmation law. Recording approval of terms nobody displayed is
    // worse than recording none, because it looks like consent.
    let raised: unknown
    try {
      GUEST_JOURNEY_FUNCTIONS.guest_portal_confirm(db, {
        p_token: TOKEN,
        p_booking_version: 999,
      })
    } catch (cause) {
      raised = cause
    }

    expect((raised as Error).message).toBe('guest_confirmation_stale')
    // The live version travels in `details`, so the caller can re-read and
    // show the delta rather than merely reporting a conflict.
    expect((raised as { details?: string }).details).toBe('4')
  })

  it('refuses to sign when the business has no contract', () => {
    const db = database()
    expect(() =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_sign_contract(db, {
        p_token: TOKEN,
        p_signer_name: 'דנה כהן',
        p_signature_text: 'דנה כהן',
      }),
    ).toThrow('guest_contract_disabled')
  })

  it('refuses a revoked link before it refuses anything else', () => {
    const db = database()
    db.rows('bookings')[0].guest_link_revoked_at = new Date().toISOString()

    // Order matters: a guest told "not found" retypes the link, and a guest
    // told "revoked" telephones the business.
    expect(() => journeyOf(db)).toThrow('guest_link_revoked')
  })

  it('refuses an expired link', () => {
    const db = database()
    db.rows('bookings')[0].guest_link_expires_at = '2020-01-01T00:00:00.000Z'
    expect(() => journeyOf(db)).toThrow('guest_link_expired')
  })

  it('refuses a token that is too short to be one', () => {
    expect(() =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_journey(database(), {
        p_token: 'abc123',
      }),
    ).toThrow('guest_link_not_found')
  })

  it('refuses a category the business switched off', () => {
    const db = database({ settings: { request_categories: ['towels'] } })
    expect(() =>
      GUEST_JOURNEY_FUNCTIONS.guest_portal_submit_request(db, {
        p_token: TOKEN,
        p_category: 'maintenance',
        p_body: null,
        p_client_key: 'key-1',
      }),
    ).toThrow('guest_request_category_unavailable')
  })
})

describe('the projection withholds what production withholds', () => {
  it('returns no internal notes, attribution or tax treatment', () => {
    const db = database()
    db.rows('bookings')[0].internal_notes = 'אורח חוזר — לתת שדרוג'
    db.rows('bookings')[0].agent_user_id = 'agent-9'
    db.rows('bookings')[0].tax_rate_bps = 1700

    const serialised = JSON.stringify(journeyOf(db))

    // A demo that handed back a whole row would let a screen read fields the
    // real projection omits, and nobody would find out until it was live.
    expect(serialised).not.toContain('אורח חוזר')
    expect(serialised).not.toContain('agent-9')
    expect(serialised).not.toContain('1700')
  })
})
