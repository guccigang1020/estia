/**
 * Token A must never resolve booking B.
 *
 * ── What an IDOR would look like in this module, concretely ───────────────
 *
 * The classic shape is a function that takes both a credential and an object
 * id — `confirm(token, bookingId)` — and checks the first while trusting the
 * second. Every real-world variant is that: the id comes from a hidden form
 * field, or a query string, or a JSON body, the server validates the session
 * and then reads the row the client named, and somebody increments a number.
 *
 * **This module is built so that shape cannot be written.** Not one function in
 * `journey.ts` accepts a booking identifier. The token is the only argument
 * that selects anything, and the SECURITY DEFINER functions in migration 0034
 * re-resolve it themselves rather than trusting that a layout or a page did.
 *
 * So these tests assert two different things, and both are needed:
 *
 *   1. **Behavioural** — two tokens, two bookings, and each token returns its
 *      own. That is the property a reader expects an IDOR test to check.
 *
 *   2. **Structural** — the arguments actually sent to the database contain no
 *      booking identifier at all, under any name. This is the one that keeps
 *      working: it fails the day somebody "optimises" a call by passing an id
 *      alongside the token, which is exactly how the vulnerability gets
 *      reintroduced, and it fails before that id is ever trusted.
 *
 * The database's own half of this is asserted in the migration's §14 rehearsal
 * block — `anon` may not read `bookings`, may not read any of 0034's tables,
 * and may not call `guest_link_booking`, which is the only function that
 * returns a whole booking row.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../persistence/fake-client'

import {
  confirmBooking,
  declareCheckout,
  guestJourney,
  saveDetails,
  signContract,
  submitRequest,
} from './journey'

/** 64 hex characters, matching `encode(gen_random_bytes(32), 'hex')` from 0009. */
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

const BOOKING_A = '11111111-1111-4111-8111-111111111111'
const BOOKING_B = '22222222-2222-4222-8222-222222222222'

/** What `guest_portal_journey` returns for one of the two bookings. */
function journeyPayload(options: {
  checkIn: string
  checkOut: string
  totalAgorot: number
  city: string
}) {
  return {
    settings: {
      contractMode: 'disabled',
      requireGuestConfirmation: true,
      requiredDetailFields: [],
      optionalDetailFields: [],
      arrivalRelease: 'after_confirmation',
      arrivalReleaseHours: 24,
      duringStayTopics: [],
      requestsEnabled: true,
      requestCategories: ['towels'],
      checkoutDeclarationEnabled: true,
      reviewEnabled: false,
      reviewUrl: null,
      rebookEnabled: false,
      reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
    },
    current: {
      bookingVersion: 3,
      status: 'confirmed',
      checkIn: options.checkIn,
      checkOut: options.checkOut,
      adults: 2,
      children: 0,
      infants: 0,
      totalAgorot: options.totalAgorot,
      currency: 'ILS',
      cancellationTerms: null,
      inStay: false,
    },
    confirmation: null,
    contract: { mode: 'disabled', template: null, signature: null },
    details: { submittedAt: null, fields: {} },
    arrival: { released: false, city: options.city },
    stay: { inStay: false },
    requests: [],
    checkout: { checkOutTime: '11:00:00', enabled: true },
  }
}

const STAY_A = journeyPayload({
  checkIn: '2026-09-03',
  checkOut: '2026-09-07',
  totalAgorot: 750_000,
  city: 'רמת הגולן',
})

const STAY_B = journeyPayload({
  checkIn: '2026-11-20',
  checkOut: '2026-11-22',
  totalAgorot: 320_000,
  city: 'אילת',
})

describe('the token is the only selector', () => {
  it('returns the booking its own token names, and never the other one', async () => {
    // One fake, two calls, answered in order — standing in for the SECURITY
    // DEFINER function resolving each token to its own row.
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:guest_portal_journey': [{ data: STAY_A }, { data: STAY_B }],
      },
    })

    const first = await guestJourney(fake.asDb(), TOKEN_A)
    const second = await guestJourney(fake.asDb(), TOKEN_B)

    expect(first.current.checkIn).toBe('2026-09-03')
    expect(first.current.totalAgorot).toBe(750_000)
    expect(first.arrival.city).toBe('רמת הגולן')

    expect(second.current.checkIn).toBe('2026-11-20')
    expect(second.current.totalAgorot).toBe(320_000)
    expect(second.arrival.city).toBe('אילת')

    // Each call carried its own token and nothing else.
    expect(fake.queries).toHaveLength(2)
    expect(fake.queries[0].payload).toEqual({ p_token: TOKEN_A })
    expect(fake.queries[1].payload).toEqual({ p_token: TOKEN_B })
  })

  it('refuses an unknown token rather than falling back to any booking', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:guest_portal_journey': {
          error: {
            code: 'P0002',
            message: 'guest_link_not_found',
            hint: 'לא מצאנו את ההזמנה.',
          },
        },
      },
    })

    await expect(
      guestJourney(fake.asDb(), 'c'.repeat(64)),
    ).rejects.toMatchObject({ code: 'guest_link_not_found' })
  })

  it('refuses an empty token without asking the database at all', async () => {
    const fake = new FakeSupabaseClient()

    await expect(guestJourney(fake.asDb(), '   ')).rejects.toMatchObject({
      code: 'guest_link_not_found',
    })

    // The refusal is local. A blank token must not become a query.
    expect(fake.queries).toHaveLength(0)
  })
})

describe('no write names a booking', () => {
  /**
   * Every guest-facing write, driven once, so the arguments can be inspected.
   *
   * Written as a list rather than as six separate tests because the assertion
   * is the same for all of them and the value is in the completeness: a new
   * write added to `journey.ts` and not added here is the gap this suite
   * exists to catch, and a reviewer can see the list is the whole module.
   */
  async function driveEveryWrite() {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:guest_portal_confirm': {
          data: {
            confirmationId: 'c1',
            confirmedAt: '2026-09-01T10:00:00Z',
            bookingVersion: 3,
            created: true,
          },
        },
        'rpc:guest_portal_sign_contract': {
          data: {
            signatureId: 's1',
            signedAt: '2026-09-01T10:00:00Z',
            created: true,
          },
        },
        'rpc:guest_portal_save_details': {
          data: { submittedAt: '2026-09-01T10:00:00Z' },
        },
        'rpc:guest_portal_submit_request': {
          data: { requestId: 'r1', state: 'received', created: true },
        },
        'rpc:guest_portal_declare_checkout': {
          data: { declaredAt: '2026-09-07T09:00:00Z' },
        },
      },
    })

    const db = fake.asDb()

    await confirmBooking(db, TOKEN_A, 3, { ip: '203.0.113.9', userAgent: 'x' })
    await signContract(db, TOKEN_A, {
      signerName: 'דנה כהן',
      signatureText: 'דנה כהן',
    })
    await saveDetails(db, TOKEN_A, { full_name: 'דנה כהן' })
    await submitRequest(db, TOKEN_A, {
      category: 'towels',
      body: 'עוד שתי מגבות',
      clientKey: 'key-1',
    })
    await declareCheckout(db, TOKEN_A)

    return fake
  }

  it('sends the token and never a booking id, under any argument name', async () => {
    const fake = await driveEveryWrite()

    expect(fake.queries).toHaveLength(5)

    for (const query of fake.queries) {
      const payload = query.payload as Record<string, unknown>

      // The credential is present on every single call.
      expect(payload.p_token).toBe(TOKEN_A)

      // And nothing that could name a row is. This is the assertion that keeps
      // working: it fails the moment somebody adds `p_booking_id` to "save a
      // lookup", whatever they call it.
      for (const key of Object.keys(payload)) {
        expect(key).not.toMatch(/booking_?id/iu)
      }

      // Belt and braces — no argument's VALUE is a booking id either, which
      // catches an id smuggled through a generically named parameter.
      const serialised = JSON.stringify(payload)
      expect(serialised).not.toContain(BOOKING_A)
      expect(serialised).not.toContain(BOOKING_B)
    }
  })

  it('sends a booking VERSION on confirm, which is not an identifier', async () => {
    const fake = await driveEveryWrite()
    const confirm = fake.queriesFor('rpc:guest_portal_confirm')[0]
    const payload = confirm.payload as Record<string, unknown>

    // `p_booking_version` is the optimistic-locking check, not a selector: the
    // database compares it with the row the TOKEN found and refuses on a
    // mismatch. Asserted explicitly so the regex above is not read as banning
    // it by accident.
    expect(payload.p_booking_version).toBe(3)
    expect(payload.p_token).toBe(TOKEN_A)
  })

  it('drops detail keys outside the closed list before sending them', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:guest_portal_save_details': { data: { submittedAt: null } },
      },
    })

    await saveDetails(fake.asDb(), TOKEN_A, {
      full_name: 'דנה כהן',
      // Not a member of GUEST_DETAIL_FIELDS. A crafted submission must not be
      // able to write an arbitrary key into a jsonb column that a staff screen
      // later renders.
      booking_id: BOOKING_B,
      internal_notes: 'שווה לשדרג',
    } as Record<string, string>)

    const payload = fake.queries[0].payload as {
      p_fields: Record<string, string>
    }
    expect(payload.p_fields).toEqual({ full_name: 'דנה כהן' })
    expect(JSON.stringify(payload)).not.toContain(BOOKING_B)
  })
})

describe('the token never reaches an error', () => {
  it('refuses without echoing the credential', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:guest_portal_confirm': {
          error: {
            code: 'P0008',
            message: 'guest_confirmation_stale',
            hint: 'ההזמנה עודכנה.',
            details: '7',
          },
        },
      },
    })

    // A refusal carries a code, a Hebrew sentence and — here — the live
    // version, so the caller can show the delta. It must never carry the
    // token: an error is logged, and a log line outlives the stay.
    const failure = await confirmBooking(fake.asDb(), TOKEN_A, 3).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toMatchObject({
      code: 'guest_confirmation_stale',
      liveVersion: 7,
    })
    expect(JSON.stringify(failure)).not.toContain(TOKEN_A)
    expect(String((failure as Error).message)).not.toContain(TOKEN_A)
  })
})
