/**
 * The four states, and the two failures that make them worth having.
 *
 * A countdown that keeps running after expiry, and a door code still on a
 * cancelled booking's screen. Both are asserted here with the actual values
 * rather than as "the state is correct".
 */

import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AccessCard } from '../../components/guest-stay/access-card'
import { CancelledPanel } from '../../components/guest-stay/cancelled-panel'
import { PaymentSchedule } from '../../components/guest-stay/payment-schedule'
import { StayGuide } from '../../components/guest-stay/stay-guide'
import { isHoldLive } from '../booking/holds'
import type { Hold } from '../booking/types'

import { NOTHING_REQUIRED_DECISION, journeyFixture } from './fixtures'
import {
  GUEST_PORTAL_PHASES,
  PAYMENT_UNKNOWN_NOTICE,
  UNDATED_GUEST_HOLD,
  buildStaySections,
  cancelledPortalView,
  formatHoldRemaining,
  guestAccessView,
  guestHoldRemainingMs,
  guestHoldState,
  guestHoldView,
  guestPaymentSchedule,
  guestPortalPhase,
  hebrewWeekday,
  paymentNotice,
  redactCancelledJourney,
  staySealedNotice,
  type GuestHold,
} from './stay'

const NOW = new Date('2026-09-05T12:00:00Z')

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs)
}

function hold(overrides: Partial<GuestHold> = {}): GuestHold {
  return { ...UNDATED_GUEST_HOLD, ...overrides }
}

// ── The phase ─────────────────────────────────────────────────────────────

describe('which screen this booking gets', () => {
  it('names all five and nothing else', () => {
    expect(GUEST_PORTAL_PHASES).toEqual([
      'hold',
      'pre_arrival',
      'in_stay',
      'post_stay',
      'cancelled',
    ])
  })

  it('sends an option to the hold screen', () => {
    const journey = journeyFixture({ current: { status: 'option' } })
    expect(guestPortalPhase(journey, NOW)).toBe('hold')
  })

  it('does not treat a quote as a hold', () => {
    // A price somebody was given is not a claim on the calendar. Telling that
    // guest their dates are saved is a promise the business never made.
    const journey = journeyFixture({ current: { status: 'quote' } })
    expect(guestPortalPhase(journey, NOW)).toBe('pre_arrival')
  })

  it('sends a cancelled booking to the cancelled screen', () => {
    const journey = journeyFixture({ current: { status: 'cancelled' } })
    expect(guestPortalPhase(journey, NOW)).toBe('cancelled')
  })

  it('sends a no-show to the cancelled screen too', () => {
    const journey = journeyFixture({ current: { status: 'no_show' } })
    expect(guestPortalPhase(journey, NOW)).toBe('cancelled')
  })

  it('reads the projection for an early check-in rather than the calendar', () => {
    // Arrives tomorrow by the dates, on the sofa today. SQL already said so.
    const journey = journeyFixture({
      current: {
        status: 'checked_in',
        checkIn: '2026-09-06',
        checkOut: '2026-09-09',
        inStay: true,
      },
    })
    expect(guestPortalPhase(journey, NOW)).toBe('in_stay')
  })

  it('lets an early departure beat the calendar', () => {
    // The failure this ordering exists for: checked out on night three of
    // five, `inStay` still true by date, and the wifi password on screen for
    // a house they have left.
    const journey = journeyFixture({
      current: {
        status: 'checked_out',
        checkIn: '2026-09-03',
        checkOut: '2026-09-08',
        inStay: true,
      },
    })
    expect(guestPortalPhase(journey, NOW)).toBe('post_stay')
  })

  it('treats the departure morning as after the stay', () => {
    // Half-open: the check-out date is not a night of the stay.
    const journey = journeyFixture({
      current: {
        status: 'confirmed',
        checkIn: '2026-09-01',
        checkOut: '2026-09-05',
        inStay: false,
      },
    })
    expect(guestPortalPhase(journey, NOW)).toBe('post_stay')
  })
})

// ── The hold ──────────────────────────────────────────────────────────────

describe('is the claim still standing', () => {
  it('is live while the deadline is ahead', () => {
    expect(
      guestHoldState(hold({ expiresAt: at(30 * 60_000).toISOString() }), NOW),
    ).toBe('live')
  })

  it('lapses exactly at the deadline, not after it', () => {
    // Strict, matching `isHoldLive`. A hold expiring at 14:30:00 does not
    // hold at 14:30:00.
    expect(guestHoldState(hold({ expiresAt: NOW.toISOString() }), NOW)).toBe(
      'lapsed',
    )
  })

  it('lapses when somebody released it', () => {
    const released = hold({
      expiresAt: at(HOUR).toISOString(),
      releasedAt: '2026-09-05T11:00:00Z',
    })
    expect(guestHoldState(released, NOW)).toBe('lapsed')
  })

  it('lapses when it became a booking', () => {
    const converted = hold({
      expiresAt: at(HOUR).toISOString(),
      convertedToBookingId: 'b-1',
    })
    expect(guestHoldState(converted, NOW)).toBe('lapsed')
  })

  it('treats an unparseable deadline as lapsed, never as a NaN countdown', () => {
    expect(guestHoldState(hold({ expiresAt: 'tuesday' }), NOW)).toBe('lapsed')
  })

  it('is undated when no deadline is known, which is today', () => {
    expect(guestHoldState(UNDATED_GUEST_HOLD, NOW)).toBe('undated')
  })

  /**
   * Parity with the booking core, asserted rather than commented.
   *
   * `guestHoldState` restates `isHoldLive`'s three rules over a narrower
   * shape. This is the test that catches the two of them drifting apart —
   * which is the only reason restating them is acceptable at all.
   */
  it('agrees with isHoldLive on every combination', () => {
    const expiries = [
      at(-HOUR).toISOString(),
      NOW.toISOString(),
      at(HOUR).toISOString(),
    ]
    const releases = [null, '2026-09-05T11:00:00Z']
    const conversions = [null, 'booking-1']

    for (const expiresAt of expiries) {
      for (const releasedAt of releases) {
        for (const convertedToBookingId of conversions) {
          const narrow: GuestHold = {
            expiresAt,
            releasedAt,
            convertedToBookingId,
          }
          const full: Hold = {
            id: 'h-1',
            organizationId: 'o-1',
            unitId: 'u-1',
            checkIn: '2026-09-10',
            checkOut: '2026-09-13',
            reason: 'guest_checkout',
            heldByUserId: 'user-1',
            expiresAt,
            releasedAt,
            convertedToBookingId,
          }

          expect(guestHoldState(narrow, NOW) === 'live').toBe(
            isHoldLive(full, NOW),
          )
        }
      }
    }
  })
})

const HOUR = 3_600_000

describe('the countdown never runs past zero', () => {
  it('floors the remaining time at zero for a lapsed hold', () => {
    const lapsed = hold({ expiresAt: at(-2 * HOUR).toISOString() })
    expect(guestHoldRemainingMs(lapsed, NOW)).toBe(0)
  })

  it('reports zero for an undated hold rather than a made-up window', () => {
    expect(guestHoldRemainingMs(UNDATED_GUEST_HOLD, NOW)).toBe(0)
  })

  it('counts down as the clock moves and stops at the deadline', () => {
    const live = hold({ expiresAt: at(90 * 60_000).toISOString() })

    expect(guestHoldRemainingMs(live, NOW)).toBe(90 * 60_000)
    expect(guestHoldRemainingMs(live, at(60 * 60_000))).toBe(30 * 60_000)
    expect(guestHoldRemainingMs(live, at(90 * 60_000))).toBe(0)
    // One second past. The number the browser would render if it subtracted
    // without clamping is negative; this one is not.
    expect(guestHoldRemainingMs(live, at(90 * 60_000 + 1_000))).toBe(0)
  })
})

describe('the remaining time, in Hebrew', () => {
  it('uses the singular and the dual rather than a number', () => {
    expect(formatHoldRemaining(HOUR)).toBe('שעה')
    expect(formatHoldRemaining(2 * HOUR)).toBe('שעתיים')
    expect(formatHoldRemaining(3 * HOUR)).toBe('3 שעות')
    expect(formatHoldRemaining(60_000)).toBe('דקה')
    expect(formatHoldRemaining(120_000)).toBe('שתי דקות')
    expect(formatHoldRemaining(12 * 60_000)).toBe('12 דקות')
  })

  it('combines the two units', () => {
    expect(formatHoldRemaining(2 * HOUR + 12 * 60_000)).toBe('שעתיים ו-12 דקות')
  })

  it('counts days for a long hold', () => {
    expect(formatHoldRemaining(24 * HOUR)).toBe('יום')
    expect(formatHoldRemaining(48 * HOUR)).toBe('יומיים')
    expect(formatHoldRemaining(49 * HOUR)).toBe('יומיים ושעה')
  })

  it('never renders zero or a negative as a duration', () => {
    expect(formatHoldRemaining(0)).toBe('פחות מדקה')
    expect(formatHoldRemaining(-5_000)).toBe('פחות מדקה')
    expect(formatHoldRemaining(Number.NaN)).toBe('פחות מדקה')
  })
})

describe('the held screen', () => {
  const held = journeyFixture({
    current: {
      status: 'option',
      checkIn: '2026-09-20',
      checkOut: '2026-09-24',
    },
  })

  it('says the dates were saved, and counts down', () => {
    const view = guestHoldView(
      held,
      hold({ expiresAt: at(2 * HOUR).toISOString() }),
      NOW,
    )

    expect(view.state).toBe('live')
    expect(view.headline).toBe('התאריכים נשמרו עבורך')
    expect(view.remaining).toBe('שעתיים')
    expect(view.expiresAt).not.toBeNull()
    expect(view.action.id).toBe('confirm')
  })

  it('offers one action and only one', () => {
    const view = guestHoldView(
      held,
      hold({ expiresAt: at(HOUR).toISOString() }),
      NOW,
    )
    // `action` is a single object rather than a list. The type is the
    // guarantee; this asserts the shipped shape has not grown a second one.
    expect(Object.keys(view.action).sort()).toEqual(['id', 'label', 'path'])
  })

  it('holds the dates with no countdown when no deadline is known', () => {
    const view = guestHoldView(held, UNDATED_GUEST_HOLD, NOW)

    expect(view.state).toBe('undated')
    expect(view.headline).toBe('התאריכים נשמרו עבורך')
    // The whole point: no invented deadline, and nothing for a timer to tick.
    expect(view.remaining).toBeNull()
    expect(view.remainingMs).toBeNull()
    expect(view.expiresAt).toBeNull()
    expect(view.action.id).toBe('confirm')
  })

  it('never shows false availability once it has lapsed', () => {
    const view = guestHoldView(
      held,
      hold({ expiresAt: at(-HOUR).toISOString() }),
      NOW,
    )

    expect(view.state).toBe('lapsed')
    expect(view.headline).toBe('ההחזקה על התאריכים הסתיימה')
    // No countdown to keep running…
    expect(view.remaining).toBeNull()
    expect(view.remainingMs).toBeNull()
    expect(view.expiresAt).toBeNull()
    // …and no button that cannot succeed. `confirm` on a lapsed hold is a
    // booking attempt against dates that are back on sale.
    expect(view.action.id).toBe('contact')
    expect(view.body).not.toContain('נשמרו עבורך')
  })

  it('does not promise the dates are still free', () => {
    const view = guestHoldView(
      held,
      hold({ expiresAt: at(-HOUR).toISOString() }),
      NOW,
    )
    expect(view.body).toContain('חזרו למכירה')
    expect(view.body).toContain('איננו יכולים לדעת')
  })
})

// ── During the stay ───────────────────────────────────────────────────────

describe('the guide renders what the property configured, and nothing else', () => {
  it('emits no section for a property that configured none', () => {
    const journey = journeyFixture({
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: null,
        wifiPassword: null,
        propertyGuide: null,
        houseRules: null,
        emergencyContact: null,
      },
    })

    // Requests are on by the shipped default and are the only section left.
    expect(buildStaySections(journey).map((section) => section.id)).toEqual([
      'requests',
      'checkout',
    ])
  })

  it('puts the wifi first', () => {
    const journey = journeyFixture({
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: 'Estia-Guest',
        wifiPassword: 'shalom2026',
        propertyGuide: 'המזגן מופעל מהשלט הלבן. הג׳קוזי נסגר ב-22:00.',
        houseRules: 'שקט מ-23:00.',
        emergencyContact: '050-0000000',
      },
    })

    const sections = buildStaySections(journey)
    expect(sections[0]?.id).toBe('wifi')
    expect(sections[0]?.fields.map((field) => field.value)).toEqual([
      'Estia-Guest',
      'shalom2026',
    ])
  })

  it('renders a network with no password rather than inventing one', () => {
    const journey = journeyFixture({
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: 'Estia-Open',
        wifiPassword: null,
        propertyGuide: null,
        houseRules: null,
        emergencyContact: null,
      },
    })

    const wifi = buildStaySections(journey).find((s) => s.id === 'wifi')
    expect(wifi?.fields.map((f) => f.label)).toEqual(['שם הרשת'])
  })

  it('omits a topic the business switched off even when content exists', () => {
    const journey = journeyFixture({
      settings: { duringStayTopics: ['wifi'] },
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: 'Estia-Guest',
        wifiPassword: 'x',
        propertyGuide: 'מדריך שלם',
        houseRules: null,
        emergencyContact: null,
      },
    })

    const ids = buildStaySections(journey).map((s) => s.id)
    expect(ids).toContain('wifi')
    expect(ids).not.toContain('guide')
    expect(ids).not.toContain('checkout')
  })

  it('does not promise details will appear for a property with no guide topics', () => {
    const journey = journeyFixture({
      settings: { duringStayTopics: ['checkout'] },
    })
    expect(staySealedNotice(journey)).toBeNull()
  })

  it('explains an empty guide before the stay begins', () => {
    const journey = journeyFixture()
    expect(staySealedNotice(journey)).toContain('עם תחילת השהות')
  })

  it('says nothing once the stay has begun', () => {
    const journey = journeyFixture({
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: null,
        wifiPassword: null,
        propertyGuide: null,
        houseRules: null,
        emergencyContact: null,
      },
    })
    expect(staySealedNotice(journey)).toBeNull()
  })
})

// ── Money in an unknown state ─────────────────────────────────────────────

describe('a payment nobody can account for', () => {
  it('uses the exact sentence and never the word failed', () => {
    const notice = paymentNotice('unknown')

    expect(notice?.message).toBe(PAYMENT_UNKNOWN_NOTICE)
    expect(notice?.message).toBe(
      'אנחנו בודקים את סטטוס התשלום. אין לבצע תשלום נוסף כרגע.',
    )
    expect(notice?.message).not.toContain('נכשל')
  })

  it('does not offer a retry, which is the double charge with an extra step', () => {
    expect(paymentNotice('unknown')?.mayRetry).toBe(false)
  })

  it('still offers a retry on a genuine failure', () => {
    expect(paymentNotice('failed')?.mayRetry).toBe(true)
  })

  it('says nothing at all when no status is known', () => {
    expect(paymentNotice(null)).toBeNull()
  })
})

// ── Cancelled ─────────────────────────────────────────────────────────────

/**
 * A cancelled booking whose database still hands over everything.
 *
 * This is not a contrived fixture. `guest_arrival_released` tests the release
 * policy, the manual override and a status list that contains neither
 * `cancelled` nor `no_show` — so a booking cancelled after the guest confirmed
 * comes back exactly like this.
 */
const CANCELLED_WITH_SECRETS = journeyFixture({
  current: { status: 'cancelled' },
  arrival: {
    released: true,
    checkInTime: '15:00:00',
    addressNote: 'השער השני מימין',
    addressLine1: 'הגלבוע 14',
    addressLine2: 'דירה 3',
    city: 'רמת הגולן',
    directions: 'מהכביש הראשי פנייה שמאלה',
    mapUrl: 'https://maps.example.com/x',
    parking: 'חניה מקורה מתחת לבניין',
    accessInstructions: 'הקלד את הקוד ולחץ על המפתח',
    accessCode: '4417#',
  },
  stay: {
    inStay: false,
    wifiNetwork: 'Estia-Guest',
    wifiPassword: 'shalom2026',
    propertyGuide: 'המזגן מופעל מהשלט הלבן',
    houseRules: 'שקט מ-23:00',
    emergencyContact: '050-0000000',
  },
  requests: [
    {
      id: 'r-1',
      category: 'towels',
      body: 'שתי מגבות נוספות',
      state: 'received',
      createdAt: '2026-09-01T08:00:00Z',
      completedAt: null,
    },
  ],
})

describe('a cancelled booking discloses nothing operational', () => {
  it('carries no access code and no address in its payload', () => {
    const view = cancelledPortalView(CANCELLED_WITH_SECRETS)
    const serialised = JSON.stringify(view)

    expect(serialised).not.toContain('4417#')
    expect(serialised).not.toContain('הגלבוע 14')
    expect(serialised).not.toContain('דירה 3')
    expect(serialised).not.toContain('השער השני מימין')
    expect(serialised).not.toContain('מהכביש הראשי')
    expect(serialised).not.toContain('maps.example.com')
    expect(serialised).not.toContain('חניה מקורה')
    expect(serialised).not.toContain('הקלד את הקוד')
    expect(serialised).not.toContain('shalom2026')
  })

  it('strips the same fields from the journey the screens read', () => {
    const redacted = redactCancelledJourney(CANCELLED_WITH_SECRETS)

    expect(redacted.arrival.accessCode).toBeNull()
    expect(redacted.arrival.accessInstructions).toBeNull()
    expect(redacted.arrival.addressLine1).toBeNull()
    expect(redacted.arrival.addressLine2).toBeNull()
    expect(redacted.arrival.addressNote).toBeNull()
    expect(redacted.arrival.directions).toBeNull()
    expect(redacted.arrival.mapUrl).toBeNull()
    expect(redacted.arrival.parking).toBeNull()
    expect(redacted.arrival.released).toBe(false)
    expect(redacted.stay.wifiPassword).toBeNull()
    expect(redacted.stay.wifiNetwork).toBeNull()
  })

  it('produces no during-stay section from a redacted journey', () => {
    const redacted = redactCancelledJourney(CANCELLED_WITH_SECRETS)
    const ids = buildStaySections(redacted).map((section) => section.id)

    expect(ids).not.toContain('wifi')
    expect(ids).not.toContain('access')
    expect(ids).not.toContain('guide')
    expect(ids).not.toContain('checkout')
  })

  it('drops the requests list with the stay', () => {
    expect(redactCancelledJourney(CANCELLED_WITH_SECRETS).requests).toEqual([])
  })

  it('keeps the city, which is not an address', () => {
    // Same position §9 of the migration takes: the city is on the confirmation
    // the guest already holds. Withholding it is theatre, not protection.
    expect(redactCancelledJourney(CANCELLED_WITH_SECRETS).arrival.city).toBe(
      'רמת הגולן',
    )
  })

  it('says so plainly and offers one way forward', () => {
    const view = cancelledPortalView(CANCELLED_WITH_SECRETS)

    expect(view.headline).toBe('ההזמנה בוטלה')
    expect(view.body).toContain('אינם זמינים עוד')
    expect(view.action.id).toBe('contact')
  })

  it('keeps a signed contract, which outlives the booking', () => {
    const withSignature = journeyFixture({
      current: { status: 'cancelled' },
      contract: {
        mode: 'mandatory',
        template: null,
        signature: {
          signedAt: '2026-08-01T10:00:00Z',
          signerName: 'דנה לוי',
          title: 'הסכם אירוח',
          body: 'תנאי האירוח…',
          bookingVersion: 3,
        },
      },
    })

    const view = cancelledPortalView(withSignature)
    expect(view.documents).toHaveLength(1)
    expect(view.documents[0]?.id).toBe('contract')
  })

  it('says nothing about a refund when nothing is known about one', () => {
    expect(cancelledPortalView(CANCELLED_WITH_SECRETS).refund).toBeNull()
  })

  it('never tells a guest a refund failed when the provider timed out', () => {
    const view = cancelledPortalView(CANCELLED_WITH_SECRETS, {
      status: 'unknown',
      amountAgorot: 250_000,
    })

    expect(view.refund?.message).toBe(PAYMENT_UNKNOWN_NOTICE)
    expect(view.refund?.mayRetry).toBe(false)
  })
})

// ── The markup, not just the payload ──────────────────────────────────────

/**
 * A view object with no door code in it is worth something. Markup with no
 * door code in it is the actual claim.
 *
 * The precedent is `src/components/ui/accessibility-wiring.test.ts`, which
 * makes the same argument for a different invisible failure:
 * `renderToStaticMarkup` returns a string, no DOM is involved, and it fits the
 * suite's `environment: 'node'` exactly as written. `createElement` rather
 * than JSX because the include pattern is `src/**\/*.test.ts`.
 */
describe('what a cancelled booking actually renders', () => {
  const html = renderToStaticMarkup(
    h(CancelledPanel, {
      token: 'a'.repeat(64),
      view: cancelledPortalView(CANCELLED_WITH_SECRETS),
    }),
  )

  it('puts no access code and no address on the screen', () => {
    expect(html).not.toContain('4417#')
    expect(html).not.toContain('הגלבוע 14')
    expect(html).not.toContain('דירה 3')
    expect(html).not.toContain('מהכביש הראשי')
    expect(html).not.toContain('maps.example.com')
    expect(html).not.toContain('חניה מקורה')
    expect(html).not.toContain('shalom2026')
    expect(html).not.toContain('Estia-Guest')
  })

  it('says the booking was cancelled, in the heading', () => {
    expect(html).toContain('ההזמנה בוטלה')
  })

  it('renders no contact button when no number was supplied', () => {
    // A `tel:` link built from a number nobody configured gets somebody a
    // wrong number at eleven at night.
    expect(html).not.toContain('tel:')
    expect(html).toContain('בערוץ שבו קיבלת את הקישור')
  })

  it('dials the number when there is one, with an accessible name', () => {
    const withContact = renderToStaticMarkup(
      h(CancelledPanel, {
        token: 'a'.repeat(64),
        view: cancelledPortalView(CANCELLED_WITH_SECRETS),
        contact: { phone: '04-696 0000', name: 'אכסניית הגולן' },
      }),
    )

    expect(withContact).toContain('href="tel:046960000"')
    expect(withContact).toContain('aria-label')
  })
})

describe('what the guide actually renders', () => {
  it('shows a password LTR and monospaced, so it can be typed', () => {
    const journey = journeyFixture({
      current: { inStay: true },
      stay: {
        inStay: true,
        wifiNetwork: 'Estia-Guest',
        wifiPassword: 'shalom2026',
        propertyGuide: null,
        houseRules: null,
        emergencyContact: null,
      },
    })

    const html = renderToStaticMarkup(
      h(StayGuide, { sections: buildStaySections(journey) }),
    )

    expect(html).toContain('shalom2026')
    // Bidirectional reordering of a mixed string loses a character, and a
    // proportional font makes `l1I` a guess.
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('font-mono')
  })

  it('renders no heading for a topic the property left empty', () => {
    const bare = journeyFixture({
      current: { inStay: true },
      settings: { requestsEnabled: false, duringStayTopics: ['wifi', 'guide'] },
      stay: {
        inStay: true,
        wifiNetwork: null,
        wifiPassword: null,
        propertyGuide: null,
        houseRules: null,
        emergencyContact: null,
      },
    })

    const html = renderToStaticMarkup(
      h(StayGuide, { sections: buildStaySections(bare) }),
    )

    expect(html).not.toContain('רשת אלחוטית')
    expect(html).not.toContain('מדריך הנכס')
  })
})

// ── Getting in, and for how long ──────────────────────────────────────────

describe('how this guest gets in', () => {
  const withCode = journeyFixture({
    current: { status: 'checked_in', checkOut: '2026-09-07', inStay: true },
    arrival: {
      released: true,
      checkInTime: '15:00:00',
      addressNote: null,
      addressLine1: null,
      addressLine2: null,
      city: 'רמת הגולן',
      directions: null,
      mapUrl: null,
      parking: null,
      accessInstructions: 'תיבת המפתחות משמאל לדלת',
      accessCode: '4417#',
    },
  })

  it('states the window, so nobody is locked out at 11:05 without warning', () => {
    const access = guestAccessView(withCode)

    expect(access?.code).toBe('4417#')
    // 2026-09-07 is a Monday.
    expect(access?.validity).toBe('מ-15:00 עד יום ב׳ 11:00')
    expect(access?.manualOnly).toBe(false)
  })

  it('claims no window when the property configured no times', () => {
    const noTimes = journeyFixture({
      ...withCode,
      checkout: {
        checkOutTime: null,
        instructions: null,
        declaredAt: null,
        enabled: true,
      },
    })
    expect(guestAccessView(noTimes)?.validity).toBeNull()
  })

  it('is manual-only when the answer is words rather than a code', () => {
    const manual = journeyFixture({
      ...withCode,
      arrival: { ...withCode.arrival, accessCode: null },
    })

    const access = guestAccessView(manual)
    expect(access?.manualOnly).toBe(true)
    expect(access?.code).toBeNull()
    expect(access?.instructions).toBe('תיבת המפתחות משמאל לדלת')
  })

  it('renders nothing at all for a property with no access answer', () => {
    expect(guestAccessView(journeyFixture())).toBeNull()
  })

  it('refuses a cancelled booking even when the projection hands over a code', () => {
    // 0038 closes this in SQL. This is the layer above it, and it is asserted
    // rather than trusted — the two must not drift.
    expect(guestAccessView(CANCELLED_WITH_SECRETS)).toBeNull()
  })

  it('refuses a no-show for the same reason', () => {
    const noShow = journeyFixture({
      ...CANCELLED_WITH_SECRETS,
      current: { ...CANCELLED_WITH_SECRETS.current, status: 'no_show' },
    })
    expect(guestAccessView(noShow)).toBeNull()
  })
})

describe('the weekday a code stops working', () => {
  it('names the day in Hebrew, in UTC', () => {
    expect(hebrewWeekday('2026-09-07')).toBe('יום ב׳')
    expect(hebrewWeekday('2026-09-05')).toBe('שבת')
  })

  it('returns null rather than a wrong day for an unparseable date', () => {
    expect(hebrewWeekday('not-a-date')).toBeNull()
  })
})

// ── Access, and the window nobody was told about ──────────────────────────

describe('how the guest gets in, and for how long', () => {
  const withCode = journeyFixture({
    current: { checkOut: '2026-09-07' },
    arrival: {
      released: true,
      checkInTime: '15:00:00',
      addressNote: null,
      addressLine1: null,
      addressLine2: null,
      city: 'רמת הגולן',
      directions: null,
      mapUrl: null,
      parking: null,
      accessInstructions: 'הקלד את הקוד ולחץ על המפתח',
      accessCode: '4417#',
    },
  })

  it('states the window from the two times the property configured', () => {
    // 2026-09-07 is a Monday. The whole point of the window: a guest never
    // told it assumes the code works until they leave, and finds out at 11:05
    // on the doorstep that the lock rotated at check-out.
    expect(guestAccessView(withCode)?.validity).toBe('מ-15:00 עד יום ב׳ 11:00')
  })

  it('names the weekday in UTC rather than in the reader time zone', () => {
    expect(hebrewWeekday('2026-09-06')).toBe('יום א׳')
    expect(hebrewWeekday('2026-09-07')).toBe('יום ב׳')
    expect(hebrewWeekday('not-a-date')).toBeNull()
  })

  it('claims no window when the property configured no times', () => {
    const noTimes = journeyFixture({
      arrival: { ...withCode.arrival },
      checkout: {
        checkOutTime: null,
        instructions: null,
        declaredAt: null,
        enabled: true,
      },
    })
    expect(guestAccessView(noTimes)?.validity).toBeNull()
  })

  it('is safe to render with nothing — no code, no instructions, no card', () => {
    // The rule the whole module turns on. A caller may render this
    // unconditionally and never produce an empty panel.
    expect(guestAccessView(journeyFixture())).toBeNull()
  })

  it('reports a manual entry as manual rather than as a missing code', () => {
    const manual = journeyFixture({
      arrival: { ...withCode.arrival, accessCode: null },
    })
    const view = guestAccessView(manual)

    expect(view?.manualOnly).toBe(true)
    expect(view?.code).toBeNull()
    expect(view?.instructions).toBe('הקלד את הקוד ולחץ על המפתח')
  })

  it('never hands over a door code on a cancelled booking', () => {
    // `guest_arrival_released` tests neither `cancelled` nor `no_show`, so the
    // projection will happily return a live code for a booking the business
    // has written off. This is the second place that removes it.
    for (const status of ['cancelled', 'no_show']) {
      const writtenOff = journeyFixture({
        current: { status },
        arrival: { ...withCode.arrival },
      })
      expect(guestAccessView(writtenOff)).toBeNull()
      expect(JSON.stringify(buildStaySections(writtenOff))).not.toContain(
        '4417#',
      )
    }
  })
})

// ── The payment schedule ──────────────────────────────────────────────────

/** A 30% deposit on ₪7,500, balance three days out. The brief's own example. */
const THIRTY_SEVENTY = {
  ...NOTHING_REQUIRED_DECISION,
  policy: 'deposit' as const,
  requirements: ['deposit_recorded' as const],
  dueNowAgorot: 225_000,
  shortfallAgorot: 225_000,
  balanceDueDaysBefore: 3,
  confirmable: false,
}

describe('what is paid and what is due', () => {
  const journey = journeyFixture({
    current: { checkIn: '2026-09-15', checkOut: '2026-09-19' },
  })

  it('splits the stay into a deposit and a balance with a real date', () => {
    const schedule = guestPaymentSchedule({
      journey,
      decision: THIRTY_SEVENTY,
      now: NOW,
    })

    expect(schedule?.policyLabel).toBe(
      '30% בעת ההזמנה · 70% עד 3 ימים לפני ההגעה',
    )
    expect(schedule?.instalments.map((line) => line.id)).toEqual([
      'deposit',
      'balance',
    ])

    const deposit = schedule?.instalments[0]
    const balance = schedule?.instalments[1]
    expect(deposit?.amountLabel).toBe('₪2,250')
    expect(deposit?.state).toBe('due')
    // Three days before the fifteenth.
    expect(balance?.dueDate).toBe('2026-09-12')
    expect(balance?.detail).toBe('לתשלום עד 12.9')
    expect(balance?.amountLabel).toBe('₪5,250')
  })

  it('marks the deposit paid once the shortfall is gone', () => {
    const schedule = guestPaymentSchedule({
      journey,
      decision: { ...THIRTY_SEVENTY, shortfallAgorot: 0 },
      now: NOW,
    })

    expect(schedule?.instalments[0].state).toBe('paid')
    expect(schedule?.instalments[0].detail).toBe('שולם')
    // And the balance is NOT claimed as paid on that inference.
    expect(schedule?.instalments[1].state).toBe('upcoming')
  })

  it('takes the resolver number verbatim rather than recomputing a percentage', () => {
    // A flat deposit that no percentage of the total would produce. If this
    // module did its own arithmetic the answer would not be ₪1,500, and the
    // desk and the guest would be reading two different numbers.
    const flat = guestPaymentSchedule({
      journey,
      decision: { ...THIRTY_SEVENTY, dueNowAgorot: 150_000 },
      now: NOW,
    })

    expect(flat?.instalments[0].amountAgorot).toBe(150_000)
    expect(flat?.policyLabel).toBe('20% בעת ההזמנה · 80% עד 3 ימים לפני ההגעה')
  })

  it('never accuses a guest who may have paid by transfer', () => {
    // The deadline has passed and nobody has recorded the money. The guest may
    // well have sent it on Tuesday. Stating the date is fair; the word is not.
    const late = guestPaymentSchedule({
      journey: journeyFixture({
        current: { checkIn: '2026-09-06', checkOut: '2026-09-09' },
      }),
      decision: THIRTY_SEVENTY,
      now: NOW,
    })

    const balance = late?.instalments[1]
    expect(balance?.state).toBe('overdue')
    expect(balance?.detail).toBe('מועד התשלום היה 3.9')
    expect(balance?.detail).not.toContain('באיחור')
  })

  it('shows one row for a pay-everything policy, not two', () => {
    const full = guestPaymentSchedule({
      journey,
      decision: {
        ...THIRTY_SEVENTY,
        policy: 'full' as const,
        dueNowAgorot: 750_000,
        shortfallAgorot: 750_000,
      },
      now: NOW,
    })

    expect(full?.instalments.map((line) => line.id)).toEqual(['total'])
    // No split, so no percentage sentence to mislead anybody.
    expect(full?.policyLabel).toBeNull()
  })

  it('renders nothing at all for a business that collects nothing', () => {
    // `policy: 'none'` is the most common real configuration in this market,
    // and a card reading ₪0 שולם is an empty card with extra steps.
    expect(
      guestPaymentSchedule({
        journey,
        decision: NOTHING_REQUIRED_DECISION,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('renders nothing for a booking whose price was never entered', () => {
    expect(
      guestPaymentSchedule({
        journey: journeyFixture({ current: { totalAgorot: 0 } }),
        decision: THIRTY_SEVENTY,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('prefers a settled figure the caller actually knows', () => {
    // The gap named in the module footer: given the real number, the balance
    // can say שולם for a guest who paid the lot by bank transfer.
    const schedule = guestPaymentSchedule({
      journey,
      decision: THIRTY_SEVENTY,
      now: NOW,
      settledAgorot: 750_000,
    })

    expect(schedule?.instalments.every((line) => line.state === 'paid')).toBe(
      true,
    )
    expect(schedule?.outstandingAgorot).toBe(0)
  })

  it('discloses no cost, margin or payout in its payload', () => {
    const serialised = JSON.stringify(
      guestPaymentSchedule({ journey, decision: THIRTY_SEVENTY, now: NOW }),
    )

    // Everything on this card is the guest's own money. What the stay costs
    // the business, what the owner is paid and what an agent earns are not in
    // the decision, and nothing may be added here that would put them there.
    for (const forbidden of ['cost', 'margin', 'payout', 'commission']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden)
    }
  })
})

// ── The two cards, rendered ───────────────────────────────────────────────

describe('the access card is safe to render with nothing', () => {
  const released = journeyFixture({
    current: { checkOut: '2026-09-07' },
    arrival: {
      released: true,
      checkInTime: '15:00:00',
      addressNote: null,
      addressLine1: null,
      addressLine2: null,
      city: 'רמת הגולן',
      directions: null,
      mapUrl: null,
      parking: null,
      accessInstructions: 'קופסת מפתחות ליד הדלת',
      accessCode: '4417#',
    },
  })

  it('prints the code and the window it is good for', () => {
    const html = renderToStaticMarkup(
      h(AccessCard, { access: guestAccessView(released) }),
    )

    expect(html).toContain('4417#')
    expect(html).toContain('מ-15:00 עד יום ב׳ 11:00')
    // LTR and monospace, or a digit is lost to bidirectional reordering and a
    // guest is left standing outside.
    expect(html).toContain('dir="ltr"')
  })

  it('renders nothing at all when the policy has withheld everything', () => {
    // The property that matters: the value is not in the object, so there is
    // no branch in the component that could be deleted to expose it.
    const withheld = journeyFixture()
    expect(guestAccessView(withheld)).toBeNull()
    expect(
      renderToStaticMarkup(
        h(AccessCard, { access: guestAccessView(withheld) }),
      ),
    ).toBe('')
  })

  it('puts no door code on a cancelled booking screen', () => {
    const cancelled = journeyFixture({
      current: { status: 'cancelled' },
      arrival: { ...released.arrival },
    })
    const html = renderToStaticMarkup(
      h(AccessCard, { access: guestAccessView(cancelled) }),
    )

    expect(html).toBe('')
    expect(html).not.toContain('4417#')
  })
})

describe('the payment schedule card', () => {
  const journey = journeyFixture({
    current: { checkIn: '2026-09-15', checkOut: '2026-09-19' },
  })

  it('states every row in words, not in colour alone', () => {
    const html = renderToStaticMarkup(
      h(PaymentSchedule, {
        schedule: guestPaymentSchedule({
          journey,
          decision: { ...THIRTY_SEVENTY, shortfallAgorot: 0 },
          now: NOW,
        }),
      }),
    )

    // The paid row says so; the tick beside it is decoration and is hidden
    // from the accessibility tree rather than read out in its place.
    expect(html).toContain('שולם')
    expect(html).toContain('לתשלום עד 12.9')
    expect(html).toContain('30% בעת ההזמנה · 70% עד 3 ימים לפני ההגעה')
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders nothing for a business that collects nothing in advance', () => {
    expect(
      renderToStaticMarkup(
        h(PaymentSchedule, {
          schedule: guestPaymentSchedule({
            journey,
            decision: NOTHING_REQUIRED_DECISION,
            now: NOW,
          }),
        }),
      ),
    ).toBe('')
  })

  it('formats every sum through the one rounding rule', () => {
    // No `/ 100` anywhere in the template. The amounts arrive as strings from
    // `formatAgorot`, so there is no second rounding rule to disagree with the
    // first on a booking whose total is not round.
    const html = renderToStaticMarkup(
      h(PaymentSchedule, {
        schedule: guestPaymentSchedule({
          journey: journeyFixture({
            current: { checkIn: '2026-09-15', totalAgorot: 749_950 },
          }),
          decision: THIRTY_SEVENTY,
          now: NOW,
        }),
      }),
    )

    expect(html).toContain('₪2,250')
    expect(html).not.toMatch(/\d+\.\d{3,}/u)
  })
})
