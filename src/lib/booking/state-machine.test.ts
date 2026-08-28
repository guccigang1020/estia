/**
 * The state machine.
 *
 * Two claims are being proved here, and only one of them is the cheerful one.
 *
 * The first is that every move the product promises is actually allowed —
 * walked exhaustively over the declared table rather than sampled, so a
 * transition that is quietly dropped in a refactor fails the build.
 *
 * The second, and the one that matters at four in the afternoon, is that
 * everything else is refused: after check-out nothing can be cancelled, a
 * terminal booking cannot be revived, a guest cannot be marked absent before
 * they were due, and a booking cannot be closed while the business is still
 * holding the guest's deposit. Each of those is a way a real business loses
 * money or an argument.
 */

import { describe, expect, it } from 'vitest'
import { AuthorizationError, type Actor } from '../authz/can'
import { PERMISSIONS, type Grant } from '../authz/permissions'
import { BusinessRuleError } from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import {
  BOOKING_STATUS_LABEL,
  BOOKING_TRANSITIONS,
  assertTransition,
  evaluateTransition,
  findTransition,
  legalNextStatuses,
  type BookingSnapshot,
} from './state-machine'
import { BOOKING_STATUSES, type BookingStatus } from './types'

// ── The world ─────────────────────────────────────────────────────────────

const ORG = 'org-a'
const CHECK_IN = '2026-09-03'
const CHECK_OUT = '2026-09-06'
/** Midday in Israel on the arrival date. */
const ON_ARRIVAL_DAY = new Date('2026-09-03T09:00:00.000Z')

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-dana',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
  }
}

const owner = actorWith(PERMISSIONS)

function bookingIn(
  status: BookingStatus,
  overrides: Partial<BookingSnapshot> = {},
): BookingSnapshot {
  return {
    id: 'bk-1',
    organizationId: ORG,
    propertyId: 'prop-1',
    unitId: 'unit-1',
    reference: '8892',
    status,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guestName: 'משה לוי',
    guestCount: 2,
    version: 3,
    depositRequiredAgorot: 0,
    depositHeldAgorot: 0,
    totalAgorot: 640000,
    lines: [],
    attribution: {
      source: 'direct_website',
      sourceChannel: null,
      agentUserId: null,
      agencyId: null,
      campaignId: null,
      referralId: null,
    },
    createdByUserId: 'user-dana',
    ...overrides,
  }
}

/** A booking shaped so the target transition's own conditions hold. */
function bookingFor(from: BookingStatus, to: BookingStatus): BookingSnapshot {
  return bookingIn(from, {
    // The only condition that wants money present rather than absent.
    depositHeldAgorot: to === 'deposit_release' ? 25000 : 0,
  })
}

// ── Every legal move ──────────────────────────────────────────────────────

describe('the declared transitions', () => {
  const legalPairs = BOOKING_TRANSITIONS.flatMap((transition) =>
    transition.from.map((from) => ({ from, to: transition.to })),
  )

  it('allows every declared move for an actor holding everything', () => {
    const refused = legalPairs.filter(({ from, to }) => {
      const check = evaluateTransition(owner, to, {
        booking: bookingFor(from, to),
        now: ON_ARRIVAL_DAY,
      })
      return !check.ok
    })

    expect(refused).toEqual([])
  })

  it('declares exactly the moves the product promises', () => {
    // A count, deliberately. Adding a transition is a product decision and
    // should require touching this number and saying why in the commit.
    expect(legalPairs).toHaveLength(45)
  })

  it('never declares the same move twice', () => {
    const seen = legalPairs.map(({ from, to }) => `${from}→${to}`)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('names every status in Hebrew, so no refusal shows a raw enum value', () => {
    for (const status of BOOKING_STATUSES) {
      expect(BOOKING_STATUS_LABEL[status]).toBeTruthy()
      expect(BOOKING_STATUS_LABEL[status]).not.toMatch(/[a-z_]/)
    }
  })

  it('leaves no non-terminal status without a way out', () => {
    const stranded = BOOKING_STATUSES.filter(
      (status) =>
        !['completed', 'cancelled', 'no_show'].includes(status) &&
        legalNextStatuses(owner, {
          booking: bookingIn(status, { depositHeldAgorot: 0 }),
          now: ON_ARRIVAL_DAY,
        }).length === 0,
    )

    expect(stranded).toEqual([])
  })
})

// ── The refusals ──────────────────────────────────────────────────────────

describe('illegal transitions', () => {
  const illegal: ReadonlyArray<[BookingStatus, BookingStatus, string]> = [
    [
      'checked_out',
      'cancelled',
      'a stay that already happened cannot be undone',
    ],
    ['completed', 'cancelled', 'terminal'],
    ['cancelled', 'confirmed', 'terminal'],
    ['no_show', 'checked_in', 'terminal'],
    ['inquiry', 'confirmed', 'an enquiry is not a sale'],
    ['inquiry', 'checked_in', 'nobody checks in from an enquiry'],
    ['confirmed', 'checked_in', 'housekeeping has not signed the unit off'],
    ['deposit_paid', 'checked_in', 'the arrival gate was skipped'],
    ['checked_in', 'no_show', 'the guest is standing in the room'],
    ['option', 'no_show', 'nothing was committed to be absent from'],
    ['checked_out', 'deposit_release', 'the unit has not been inspected'],
    ['quote', 'completed', 'no stay took place'],
    ['in_house', 'completed', 'the guest has not left'],
    ['review_requested', 'checked_in', 'the stay is over'],
  ]

  it.each(illegal)('refuses %s → %s (%s)', (from, to) => {
    const check = evaluateTransition(owner, to, {
      booking: bookingIn(from),
      now: ON_ARRIVAL_DAY,
    })

    expect(check.ok).toBe(false)
    expect(findTransition(from, to)).toBeNull()
  })

  it('refuses a move to the status the booking is already in', () => {
    const check = evaluateTransition(owner, 'confirmed', {
      booking: bookingIn('confirmed'),
      now: ON_ARRIVAL_DAY,
    })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusal.kind).toBe('illegal')
  })

  it('explains a refusal in Hebrew, naming both states', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'completed', {
        booking: bookingIn('quote'),
        now: ON_ARRIVAL_DAY,
      }),
    )

    expect(error.code).toBe('booking.illegal_transition')
    expect(error.userMessage).toContain('הצעת מחיר')
    expect(error.userMessage).toContain('הושלמה')
    // And offers what is actually possible instead of a dead end.
    expect(error.publicDetails.allowed).toContain('option')
  })

  it('says a terminal booking is finished rather than listing what is legal', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'confirmed', {
        booking: bookingIn('cancelled'),
        now: ON_ARRIVAL_DAY,
      }),
    )

    expect(error.code).toBe('booking.terminal_status')
    expect(error.userMessage).toContain('בוטלה')
  })

  it('refuses every move out of every terminal status', () => {
    const escapes = (['completed', 'cancelled', 'no_show'] as const).flatMap(
      (terminal) =>
        legalNextStatuses(owner, {
          booking: bookingIn(terminal),
          now: ON_ARRIVAL_DAY,
        }),
    )

    expect(escapes).toEqual([])
  })
})

// ── Permission ────────────────────────────────────────────────────────────

describe('permission', () => {
  it('refuses a deposit release to someone who may only change status', () => {
    // `booking.change_status` moves a booking through the workflow. Handing
    // back a guest's money is a different right, and holding the first must
    // never imply the second.
    const check = evaluateTransition(
      actorWith(['booking.change_status']),
      'deposit_release',
      {
        booking: bookingIn('inspection', { depositHeldAgorot: 25000 }),
        now: ON_ARRIVAL_DAY,
      },
    )

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusal.kind).toBe('not_permitted')
  })

  it('refuses a cancellation to someone who may only change status', () => {
    const check = evaluateTransition(
      actorWith(['booking.change_status']),
      'cancelled',
      {
        booking: bookingIn('confirmed'),
        now: ON_ARRIVAL_DAY,
      },
    )

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusal.kind).toBe('not_permitted')
  })

  it('throws the authorization error, not a domain error', () => {
    expect(() =>
      assertTransition(actorWith(['booking.view']), 'confirmed', {
        booking: bookingIn('deposit_paid'),
        now: ON_ARRIVAL_DAY,
      }),
    ).toThrow(AuthorizationError)
  })

  it('checks the permission before the condition, so no fact leaks', () => {
    // The condition would fail too — there is no deposit to release. Someone
    // without the right must not learn that from the refusal.
    const check = evaluateTransition(
      actorWith(['booking.change_status']),
      'deposit_release',
      {
        booking: bookingIn('inspection', { depositHeldAgorot: 0 }),
        now: ON_ARRIVAL_DAY,
      },
    )

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusal.kind).toBe('not_permitted')
  })

  it('refuses a suspended member every move', () => {
    const suspended: Actor = { ...owner, membershipStatus: 'suspended' }

    expect(
      legalNextStatuses(suspended, {
        booking: bookingIn('confirmed'),
        now: ON_ARRIVAL_DAY,
      }),
    ).toEqual([])
  })

  it('refuses a booking in another organization', () => {
    const check = evaluateTransition(owner, 'pre_arrival', {
      booking: bookingIn('confirmed', { organizationId: 'org-b' }),
      now: ON_ARRIVAL_DAY,
    })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.refusal.kind).toBe('not_permitted')
  })

  it('refuses a booking outside the actor’s property scope', () => {
    const scoped: Actor = {
      ...owner,
      scope: { kind: 'properties', propertyIds: ['prop-9'] },
    }

    const check = evaluateTransition(scoped, 'pre_arrival', {
      booking: bookingIn('confirmed'),
      now: ON_ARRIVAL_DAY,
    })

    expect(check.ok).toBe(false)
  })
})

// ── Conditions ────────────────────────────────────────────────────────────

describe('conditions', () => {
  it('refuses a no-show before the arrival date', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'no_show', {
        booking: bookingIn('confirmed'),
        now: new Date('2026-09-01T09:00:00.000Z'),
      }),
    )

    expect(error.code).toBe('booking.arrival_not_due')
  })

  it('allows a no-show on the arrival date itself', () => {
    expect(
      evaluateTransition(owner, 'no_show', {
        booking: bookingIn('confirmed'),
        now: ON_ARRIVAL_DAY,
      }).ok,
    ).toBe(true)
  })

  it('allows a no-show recorded the morning after', () => {
    expect(
      evaluateTransition(owner, 'no_show', {
        booking: bookingIn('confirmed'),
        now: new Date('2026-09-04T05:00:00.000Z'),
      }).ok,
    ).toBe(true)
  })

  it('judges the arrival date at the property, not in UTC', () => {
    // 22:30 UTC on the 2nd is already the 3rd in Israel — the arrival day.
    // Judged in UTC this would still be "too early".
    expect(
      evaluateTransition(owner, 'no_show', {
        booking: bookingIn('confirmed'),
        now: new Date('2026-09-02T22:30:00.000Z'),
      }).ok,
    ).toBe(true)
  })

  it('refuses closing a booking while the deposit is still held', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'completed', {
        booking: bookingIn('inspection', { depositHeldAgorot: 25000 }),
        now: ON_ARRIVAL_DAY,
      }),
    )

    expect(error.code).toBe('booking.deposit_still_held')
    expect(error.userMessage).toContain('פיקדון')
  })

  it('allows closing a stay that never took a deposit, straight from check-out', () => {
    expect(
      evaluateTransition(owner, 'completed', {
        booking: bookingIn('checked_out', { depositHeldAgorot: 0 }),
        now: ON_ARRIVAL_DAY,
      }).ok,
    ).toBe(true)
  })

  it('refuses releasing a deposit that is not held', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'deposit_release', {
        booking: bookingIn('inspection', { depositHeldAgorot: 0 }),
        now: ON_ARRIVAL_DAY,
      }),
    )

    expect(error.code).toBe('booking.no_deposit_held')
  })

  it('refuses confirming an option that still owes a deposit', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'confirmed', {
        booking: bookingIn('option', { depositRequiredAgorot: 150000 }),
        now: ON_ARRIVAL_DAY,
      }),
    )

    expect(error.code).toBe('booking.deposit_still_due')
  })

  it('allows confirming an option for a business that takes nothing up front', () => {
    expect(
      evaluateTransition(owner, 'confirmed', {
        booking: bookingIn('option', { depositRequiredAgorot: 0 }),
        now: ON_ARRIVAL_DAY,
      }).ok,
    ).toBe(true)
  })

  it('refuses a check-in after the stay has already ended', () => {
    const error = expectBusinessRule(() =>
      assertTransition(owner, 'checked_in', {
        booking: bookingIn('ready_for_check_in'),
        now: new Date('2026-09-20T09:00:00.000Z'),
      }),
    )

    expect(error.code).toBe('booking.stay_already_ended')
  })
})

// ── What the interface asks ───────────────────────────────────────────────

describe('legalNextStatuses', () => {
  it('offers a confirmed booking exactly what it can do', () => {
    const next = legalNextStatuses(owner, {
      booking: bookingIn('confirmed'),
      now: ON_ARRIVAL_DAY,
    })

    expect(new Set(next)).toEqual(
      new Set(['pre_arrival', 'ready_for_check_in', 'cancelled', 'no_show']),
    )
  })

  it('narrows to what this actor may actually do', () => {
    const next = legalNextStatuses(actorWith(['booking.change_status']), {
      booking: bookingIn('confirmed'),
      now: ON_ARRIVAL_DAY,
    })

    // No `booking.cancel` grant, so cancellation is not offered — the screen
    // and the server agree about the buttons.
    expect(next).not.toContain('cancelled')
    expect(next).toContain('pre_arrival')
  })

  it('drops a move whose condition does not hold', () => {
    const next = legalNextStatuses(owner, {
      booking: bookingIn('inspection', { depositHeldAgorot: 25000 }),
      now: ON_ARRIVAL_DAY,
    })

    expect(next).toContain('deposit_release')
    expect(next).not.toContain('completed')
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────

function expectBusinessRule(run: () => unknown): BusinessRuleError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleError)
    return error as BusinessRuleError
  }
  throw new Error('expected the transition to be refused, but it was allowed')
}
