/**
 * The privacy test.
 *
 * A laundry provider is an outside company with no contractual relationship to
 * the guest. The order message is the only artefact this product sends them,
 * and it must carry the property, the deadline, the quantities, the notes and
 * an internal reference — and none of the guest's name, telephone number,
 * email, price, payment state or agent.
 *
 * ── Why this test drives the WHOLE path ───────────────────────────────────
 *
 * It would be easy, and worthless, to assert that a hand-built message view
 * with no guest fields renders no guest fields. What this does instead is
 * start from `SENSITIVE_BOOKING` — a booking carrying every one of those
 * fields, with distinctive values — walk it through the requirements engine,
 * consolidation, the order builder and the renderer, and assert that not one
 * of those strings survives to the other end.
 *
 * That is the only version of the test that would have caught the way this
 * actually goes wrong, which is never a field called `guestName` in the
 * renderer. It is somebody adding "so the provider knows which booking" to an
 * order note, or a helpful `${booking.guestName}` inside a template literal
 * three functions upstream.
 */

import { describe, expect, it } from 'vitest'

import { consolidate } from './consolidation'
import {
  FORBIDDEN_IN_PROVIDER_MESSAGE,
  containsProviderForbiddenField,
  renderOrderMessage,
  toMessageView,
} from './message'
import { buildOrder } from './orders'
import { applyAdjustment } from './override'
import { buildLaundryRequirements } from './requirements'
import {
  CARMEL,
  CARMEL_REQUIREMENTS,
  GALILEE,
  GALILEE_REQUIREMENTS,
  ORGANIZATION,
  PROFILES,
  PROVIDER_ROW,
  REQUIRED_BY,
  SENSITIVE_BOOKING,
  SETTINGS,
} from './testing/example-configuration'

const PROPERTY_NAMES = new Map([
  [GALILEE, 'אחוזת הגליל'],
  [CARMEL, 'בית הכרמל'],
])

/**
 * The whole path, from a booking that carries everything sensitive.
 *
 * `bookingId` is deliberately threaded through as `SENSITIVE_BOOKING.id`,
 * because `source_booking_id` is a real internal field on every order line and
 * the question worth answering is whether it escapes — not whether it is
 * absent.
 */
function renderFromSensitiveBooking(): {
  body: string
  view: ReturnType<typeof toMessageView>
} {
  const requirements = [
    ...buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: SENSITIVE_BOOKING.id,
    }).requirements,
    ...buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: CARMEL_REQUIREMENTS,
      propertyId: CARMEL,
      requiredBy: REQUIRED_BY,
      bookingId: SENSITIVE_BOOKING.id,
    }).requirements,
  ]

  const run = consolidate(requirements)[0]
  if (!run) throw new Error('no run')

  const order = buildOrder({
    run,
    settings: SETTINGS,
    organizationId: ORGANIZATION,
    orderId: 'order-sensitive',
    lineIds: [],
    // An internal note that must NOT be sent, saying exactly the kind of thing
    // somebody really writes.
    internalNotes: `${SENSITIVE_BOOKING.guestName} מגיעה מאוחר, אל תתקשרו אליה`,
    providerNotes: 'הכניסה מהחניה האחורית.',
  })

  const view = toMessageView({
    order,
    organizationName: 'אחוזות הצפון',
    propertyNames: PROPERTY_NAMES,
    contactName: PROVIDER_ROW.contactName,
    contactPhone: PROVIDER_ROW.phone,
    standingNotes: SETTINGS.standingNotes,
  })

  return { body: renderOrderMessage(view), view }
}

// ── The guarantee ─────────────────────────────────────────────────────────

describe('a provider never learns who the guest is', () => {
  const { body, view } = renderFromSensitiveBooking()

  it.each([
    ['the guest name', SENSITIVE_BOOKING.guestName],
    ['the guest telephone', SENSITIVE_BOOKING.guestPhone],
    ['the guest email', SENSITIVE_BOOKING.guestEmail],
    ['the price', String(SENSITIVE_BOOKING.totalAgorot)],
    ['the payment state', SENSITIVE_BOOKING.paymentStatus],
    ['the agent', SENSITIVE_BOOKING.agentName],
    ['the agent id', SENSITIVE_BOOKING.agentId],
    ['the booking id', SENSITIVE_BOOKING.id],
  ])('does not put %s in the message', (_label, value) => {
    expect(body).not.toContain(value)
  })

  it('does not leak the internal note, however useful it looked', () => {
    // The note names the guest. It is written on the order because somebody at
    // the business needs it, and it is why `internalNotes` and `providerNotes`
    // are two columns rather than one.
    expect(body).not.toContain('אל תתקשרו אליה')
  })

  it('carries no field name a provider must not see', () => {
    expect(containsProviderForbiddenField(view)).toEqual([])
  })

  it('has a forbidden list that is not empty, so the check means something', () => {
    expect(FORBIDDEN_IN_PROVIDER_MESSAGE.length).toBeGreaterThan(0)
    // And the detector actually detects — a guard that never fires proves
    // nothing about the object it was pointed at.
    expect(
      containsProviderForbiddenField({ nested: { guestName: 'x' } }),
    ).toEqual(['nested.guestName'])
  })
})

// ── What it MUST contain ──────────────────────────────────────────────────

describe('and still says everything the provider needs', () => {
  const { body } = renderFromSensitiveBooking()

  it('names both properties by name', () => {
    expect(body).toContain('אחוזת הגליל')
    expect(body).toContain('בית הכרמל')
  })

  it('keeps the per-property breakdown, not a single total', () => {
    // Two property headings. A consolidated total tells a driver nothing.
    const headings = body
      .split('\n')
      .filter((line) => line.includes('—') && line.includes('עד'))

    expect(headings.length).toBeGreaterThanOrEqual(2)
  })

  it('gives an internal reference and a deadline', () => {
    expect(body).toContain('הזמנת כביסה')
    expect(body).toContain('נדרש עד')
  })

  it('carries the quantities and their item names', () => {
    expect(body).toContain('מגבות רחצה')
    expect(body).toContain('מערכות מצעים')
  })

  it('passes on the notes meant for them', () => {
    expect(body).toContain('הכניסה מהחניה האחורית.')
  })

  it('gives somebody at the business to call, never the guest', () => {
    expect(body).toContain(PROVIDER_ROW.contactName ?? '')
    expect(body).not.toContain(SENSITIVE_BOOKING.guestPhone)
  })
})

// ── The quantity that is sent ─────────────────────────────────────────────

describe('what quantity the provider is asked for', () => {
  it('is the final figure, not the engine`s and not the adjustment', () => {
    const requirements = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    }).requirements

    const run = consolidate(requirements)[0]
    if (!run) throw new Error('no run')

    const order = buildOrder({
      run,
      settings: SETTINGS,
      organizationId: ORGANIZATION,
      orderId: 'order-adjusted',
      lineIds: [],
    })

    const line = order.lines[0]
    if (!line) throw new Error('no line')

    const adjusted = {
      ...order,
      lines: [
        {
          ...line,
          quantity: applyAdjustment(line.quantity, {
            adjustment: 4,
            reason: 'אירוע גדול',
            adjustedByUserId: 'user-1',
            at: REQUIRED_BY,
          }),
        },
        ...order.lines.slice(1),
      ],
    }

    const body = renderOrderMessage(
      toMessageView({
        order: adjusted,
        organizationName: 'אחוזות הצפון',
        propertyNames: PROPERTY_NAMES,
        contactName: null,
        contactPhone: null,
        standingNotes: null,
      }),
    )

    expect(body).toContain(`${line.quantity.calculated + 4}`)
    // The reason for the adjustment is internal evidence. A provider washing
    // 32 towels does not need to know the engine said 28.
    expect(body).not.toContain('אירוע גדול')
  })
})

// ── Channels ──────────────────────────────────────────────────────────────

describe('the SMS form', () => {
  it('drops the courtesies and keeps every number', () => {
    const { view } = renderFromSensitiveBooking()

    const full = renderOrderMessage(view, 'whatsapp')
    const terse = renderOrderMessage(view, 'sms')

    expect(terse.length).toBeLessThan(full.length)
    expect(terse).not.toContain('תודה!')
    expect(terse).toContain('מגבות רחצה')
    expect(terse).toContain('אחוזת הגליל')
    // And it is still private.
    expect(terse).not.toContain(SENSITIVE_BOOKING.guestName)
  })
})
