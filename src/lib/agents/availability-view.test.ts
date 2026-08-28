/**
 * The agent's availability view.
 *
 * The most dangerous read path in the product, so these tests are adversarial
 * rather than illustrative. The source below deliberately behaves like a
 * careless `select *`: every booking it returns carries a guest name, an
 * amount, a channel, an internal note and a reference. The availability engine
 * is explicit that it does not trust its source to have filtered anything, so
 * this is not a strawman — it is the shape a real Supabase implementation
 * arrives in on the first draft.
 *
 * The suite then proves that none of it reaches an agent, by three different
 * means: the exact key set of every object returned, a whole-payload search for
 * every secret string, and a check that the *reasons* for a refusal never
 * mention a booking either.
 */

import { describe, expect, it } from 'vitest'
import {
  agentAvailabilityCalendar,
  agentCanSell,
  describeAgentRefusal,
} from './availability-view'
import type {
  AvailabilitySource,
  OccupyingBooking,
  UnitAvailabilityRules,
} from '../booking/availability'
import type { Hold } from '../booking/types'
import type { Actor, Scope } from '../authz/can'
import { AuthorizationError } from '../authz/can'
import type { Grant } from '../authz/permissions'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { NotFoundError } from '../errors'
import { AGENT_PRESETS, grantsForAgentAccess } from './access'

// ── The secrets ───────────────────────────────────────────────────────────

/**
 * Everything an agent must never see, as literal strings.
 *
 * Kept in one list so the sweep below can look for all of them in anything the
 * module returns, and so adding a new secret to the fixture automatically adds
 * it to the assertion.
 */
const SECRETS = {
  guestName: 'משפחת כהן',
  guestPhone: '+972529998888',
  guestEmail: 'cohen@example.com',
  reference: 'BK-1043',
  bookingId: 'booking-secret-id',
  holdId: 'hold-secret-id',
  amountPaid: '640000',
  channel: 'booking_com',
  internalNote: 'VIP — owner is a friend, do not upsell',
  otherAgent: 'agent-rival-7',
} as const

const ORG = 'org-a'
const UNIT = 'unit-1'
const PROPERTY = 'property-1'

/**
 * A booking row as a careless query returns it.
 *
 * Structurally an `OccupyingBooking`, plus every field a `select *` would drag
 * along. The point of the extra fields is that nothing in the agent path is
 * allowed to copy an object wholesale — if anything did, these would ride out
 * with it.
 */
function leakyBooking(overrides: Partial<OccupyingBooking> = {}) {
  return {
    id: SECRETS.bookingId,
    reference: SECRETS.reference,
    status: 'confirmed' as const,
    checkIn: '2026-09-12',
    checkOut: '2026-09-15',
    // None of these belong to `OccupyingBooking`. They are here on purpose.
    guestName: SECRETS.guestName,
    guestPhone: SECRETS.guestPhone,
    guestEmail: SECRETS.guestEmail,
    totalAgorot: Number(SECRETS.amountPaid),
    source: SECRETS.channel,
    internalNotes: SECRETS.internalNote,
    soldByAgentUserId: SECRETS.otherAgent,
    ...overrides,
  } as OccupyingBooking
}

function leakyHold(overrides: Partial<Hold> = {}): Hold {
  return {
    id: SECRETS.holdId,
    organizationId: ORG,
    unitId: UNIT,
    checkIn: '2026-09-20',
    checkOut: '2026-09-22',
    reason: 'agent_quote',
    heldByUserId: SECRETS.otherAgent,
    expiresAt: '2999-01-01T00:00:00.000Z',
    releasedAt: null,
    convertedToBookingId: null,
    ...overrides,
  }
}

interface SourceOptions {
  bookings?: readonly OccupyingBooking[]
  holds?: readonly Hold[]
  rules?: UnitAvailabilityRules | null
}

function makeSource(options: SourceOptions = {}): AvailabilitySource {
  const rules: UnitAvailabilityRules | null =
    options.rules === undefined
      ? { unitId: UNIT, minimumNights: 1 }
      : options.rules

  return {
    async loadBookings() {
      return options.bookings ?? [leakyBooking()]
    },
    async loadHolds() {
      return options.holds ?? [leakyHold()]
    },
    async loadRules() {
      return rules
    },
  }
}

// ── Actors ────────────────────────────────────────────────────────────────

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function makeActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'agent-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: grantsForAgentAccess(AGENT_PRESETS.sales) as ReadonlySet<Grant>,
    scope: { kind: 'own_records' },
    scopeOverrides: {
      inventory: { kind: 'properties', propertyIds: [PROPERTY] } as Scope,
    },
    entitlements: EVERY_ENTITLEMENT,
    ...overrides,
  }
}

const salesAgent = () => makeActor()

const referralAgent = () =>
  makeActor({
    grants: grantsForAgentAccess(AGENT_PRESETS.referral) as ReadonlySet<Grant>,
  })

const TARGET = { organizationId: ORG, propertyId: PROPERTY, unitId: UNIT }
const WINDOW = { checkIn: '2026-09-10', checkOut: '2026-09-25' }
const NOW = { now: new Date('2026-09-01T10:00:00.000Z') }

// ── The shape of the answer ───────────────────────────────────────────────

describe('what an agent receives', () => {
  it('returns exactly two keys on every day, and never a third', () => {
    // The structural guarantee. A field added to `DayAvailability` upstream
    // cannot appear here, because nothing in the projection copies objects.
    return agentAvailabilityCalendar(
      salesAgent(),
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    ).then((days) => {
      expect(days.length).toBe(15)
      for (const day of days) {
        expect(Object.keys(day).sort()).toEqual(['date', 'state'])
      }
    })
  })

  it('says only free or unavailable', async () => {
    const days = await agentAvailabilityCalendar(
      salesAgent(),
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    const states = new Set(days.map((day) => day.state))
    for (const state of states) {
      expect(['free', 'unavailable']).toContain(state)
    }
  })

  it('never lets an agent tell a booking from another agent’s hold', async () => {
    // The open question §15 leaves; 5.0 §4.4-א settles it. Telling an agent a
    // date is *held* tells them a rival is mid-deal on it.
    const days = await agentAvailabilityCalendar(
      salesAgent(),
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    const booked = days.find((day) => day.date === '2026-09-13')
    const held = days.find((day) => day.date === '2026-09-20')
    const blocked = days.find((day) => day.date === '2026-09-10')

    expect(booked?.state).toBe('unavailable')
    expect(held?.state).toBe('unavailable')
    // Indistinguishable, which is the whole point.
    expect(booked?.state).toBe(held?.state)
    expect(blocked?.state).toBe('free')
  })

  it('still reports free days as free, so the view is useful', async () => {
    const days = await agentAvailabilityCalendar(
      salesAgent(),
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    expect(days.filter((day) => day.state === 'free').length).toBeGreaterThan(0)
    expect(
      days.filter((day) => day.state === 'unavailable').length,
    ).toBeGreaterThan(0)
  })
})

// ── The sweep ─────────────────────────────────────────────────────────────

describe('no forbidden value survives the projection', () => {
  /**
   * Serialise everything the module hands back and search it for every secret.
   *
   * A field-by-field assertion tests the fields somebody thought of. This tests
   * the ones they did not — including a field added to the booking row three
   * years from now, because the fixture and the assertion share one list.
   */
  it('the calendar payload contains none of them', async () => {
    const days = await agentAvailabilityCalendar(
      salesAgent(),
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    const payload = JSON.stringify(days)

    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(payload, `leaked ${label}`).not.toContain(secret)
    }
  })

  it('the sellability answer contains none of them', async () => {
    const answer = await agentCanSell(
      salesAgent(),
      makeSource(),
      {
        unit: TARGET,
        range: { checkIn: '2026-09-12', checkOut: '2026-09-14' },
      },
      NOW,
    )
    const payload = JSON.stringify(answer) + describeAgentRefusal(answer)

    expect(answer.sellable).toBe(false)
    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(payload, `leaked ${label}`).not.toContain(secret)
    }
  })

  it('the refusal reason never names the booking that caused it', async () => {
    // The concrete leak this closes: the internal blocker's own message reads
    // "התאריכים תפוסים על ידי הזמנה BK-1043", which hands an agent a reference
    // belonging to somebody else's sale. Forwarding blockers verbatim would
    // have shipped it.
    const answer = await agentCanSell(
      salesAgent(),
      makeSource(),
      {
        unit: TARGET,
        range: { checkIn: '2026-09-12', checkOut: '2026-09-14' },
      },
      NOW,
    )
    expect(answer.reasons).toEqual(['unavailable'])
    expect(describeAgentRefusal(answer)).toBe('התאריכים אינם פנויים.')
    expect(describeAgentRefusal(answer)).not.toContain(SECRETS.reference)
  })

  it('collapses a booking and a hold into one indistinguishable reason', async () => {
    const answer = await agentCanSell(
      salesAgent(),
      makeSource({
        bookings: [leakyBooking()],
        holds: [leakyHold({ checkIn: '2026-09-12', checkOut: '2026-09-14' })],
      }),
      {
        unit: TARGET,
        range: { checkIn: '2026-09-12', checkOut: '2026-09-14' },
      },
      NOW,
    )
    // Two different causes, one reason, de-duplicated.
    expect(answer.reasons).toEqual(['unavailable'])
  })
})

// ── What an agent may legitimately be told ────────────────────────────────

describe('the unit’s own rules are not secrets', () => {
  it('reports a minimum stay, because an agent needs it to sell at all', async () => {
    const answer = await agentCanSell(
      salesAgent(),
      makeSource({
        bookings: [],
        holds: [],
        rules: { unitId: UNIT, minimumNights: 3 },
      }),
      {
        unit: TARGET,
        range: { checkIn: '2026-10-01', checkOut: '2026-10-02' },
      },
      NOW,
    )
    expect(answer.sellable).toBe(false)
    expect(answer.reasons).toContain('minimum_nights')
    expect(answer.nights).toBe(1)
  })

  it('reports a closed arrival date', async () => {
    const answer = await agentCanSell(
      salesAgent(),
      makeSource({
        bookings: [],
        holds: [],
        rules: {
          unitId: UNIT,
          minimumNights: 1,
          noArrivalDates: ['2026-10-01'],
        },
      }),
      {
        unit: TARGET,
        range: { checkIn: '2026-10-01', checkOut: '2026-10-03' },
      },
      NOW,
    )
    expect(answer.reasons).toContain('no_arrival')
  })

  it('refuses a unit that is not configured for sale, without explaining why', async () => {
    const answer = await agentCanSell(
      salesAgent(),
      makeSource({ rules: null }),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    expect(answer.sellable).toBe(false)
    expect(answer.reasons).toEqual(['unknown_unit'])
  })
})

// ── The denials ───────────────────────────────────────────────────────────

describe('who is refused, and how', () => {
  it('refuses a referral agent the calendar entirely', async () => {
    // Their calendar rung is `none`, so the ladder never granted
    // `availability.view`. The refusal happens before a single row is read.
    await expect(
      agentAvailabilityCalendar(
        referralAgent(),
        makeSource(),
        { unit: TARGET, range: WINDOW },
        NOW,
      ),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses a referral agent the sellability answer too', async () => {
    await expect(
      agentCanSell(
        referralAgent(),
        makeSource(),
        { unit: TARGET, range: WINDOW },
        NOW,
      ),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses a suspended agent, whatever their ladder says', async () => {
    const suspended = makeActor({ membershipStatus: 'suspended' })
    await expect(
      agentAvailabilityCalendar(
        suspended,
        makeSource(),
        { unit: TARGET, range: WINDOW },
        NOW,
      ),
    ).rejects.toThrow(AuthorizationError)
  })

  it('refuses a unit outside the agent’s properties as not found', async () => {
    // `NotFoundError`, not "not allowed". Saying "you may not see Villa
    // Sunrise" confirms that Villa Sunrise is on this business's books — to
    // somebody who also sells for four rivals.
    await expect(
      agentAvailabilityCalendar(
        salesAgent(),
        makeSource(),
        {
          unit: {
            organizationId: ORG,
            propertyId: 'property-9',
            unitId: 'unit-9',
          },
          range: WINDOW,
        },
        NOW,
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('refuses a unit in another organization as not found', async () => {
    // The cross-tenant case. Indistinguishable from "does not exist", so
    // probing another organization's ids confirms nothing.
    await expect(
      agentAvailabilityCalendar(
        salesAgent(),
        makeSource(),
        {
          unit: {
            organizationId: 'org-b',
            propertyId: PROPERTY,
            unitId: UNIT,
          },
          range: WINDOW,
        },
        NOW,
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('refuses an agent whose organization has not bought the network', async () => {
    // Degrading cleanly for a Basic organization without the add-on. The
    // ladder still lists `rate.view_agent`, and `holdsGrant` withholds it
    // because the plan does not include `agent_network`.
    const withoutFeature = makeActor({
      entitlements: new Set(
        [...ENTITLEMENTS].filter((e) => e !== 'agent_network'),
      ),
    })
    // Availability itself is not gated — a single-cabin owner sells on the
    // telephone — so the calendar still answers.
    const days = await agentAvailabilityCalendar(
      withoutFeature,
      makeSource(),
      { unit: TARGET, range: WINDOW },
      NOW,
    )
    expect(days.length).toBe(15)
  })
})
