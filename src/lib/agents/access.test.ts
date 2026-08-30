/**
 * The permission ladders.
 *
 * Two kinds of test here, and the first kind is the important one.
 *
 * **The `@ts-expect-error` tests are the real proof.** Each one asserts that a
 * particular incoherent combination *does not compile*. If somebody widens
 * `AgentAccess` so that a referral agent can hold the net rate, the directive
 * becomes unused and `tsc` fails on that line — the gate breaks at build time,
 * in every environment, without anybody running this file. A validator can be
 * forgotten at a call site; a type cannot.
 *
 * The runtime tests then cover the one path the compiler cannot see: data
 * arriving from the database as `unknown`.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_PRESETS,
  AGENT_PRESET_NAMES,
  agentRoleAssignment,
  canBook,
  canHold,
  canSeeAvailability,
  grantsForAgentAccess,
  parseAgentAccess,
  type AgentAccess,
} from './access'
import type { Grant } from '../authz/permissions'

// ── Unrepresentable, not merely invalid ───────────────────────────────────

/**
 * `true` when `T` is **not** assignable to `AgentAccess`.
 *
 * Used instead of `@ts-expect-error`, which is a blunter instrument here for
 * two reasons. It suppresses whatever error happens to land on the following
 * line — including a typo in a property name — so it can pass for entirely the
 * wrong reason; and on a multi-line object literal the error is reported at the
 * offending *property*, not at the opening line, so the directive silently
 * misses.
 *
 * `Rejects<T>` asks the exact question instead: is this shape outside the
 * union? Widening `AgentAccess` so that any of the combinations below became
 * legal turns the answer to `false`, and `const _: false = true` does not
 * compile. The gate fails in `tsc`, on every machine, whether or not anybody
 * runs the test file.
 */
type Rejects<T> = [T] extends [AgentAccess] ? false : true

describe('incoherent ladder combinations do not typecheck', () => {
  it('refuses a price for an agent who cannot see the calendar', () => {
    // A referral agent has no screen a price could appear on. Granting one is
    // a right waiting for somebody to build the screen that honours it.
    const proof: Rejects<{
      calendar: 'none'
      price: 'net'
      guestData: 'none'
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses a price at the free/busy rung', () => {
    // The price rung sits *above* the availability rung on the same ladder. A
    // business that wants prices chooses the rung that has them.
    const proof: Rejects<{
      calendar: 'availability'
      price: 'public'
      guestData: 'none'
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses guest data for an agent who cannot make a booking', () => {
    // There is no guest to see until this agent's own booking exists.
    const proof: Rejects<{
      calendar: 'availability_price'
      price: 'agent'
      guestData: 'name'
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses guest data at the hold rung', () => {
    // Holding dates is not seeing who is in them.
    const proof: Rejects<{
      calendar: 'availability_hold'
      price: 'agent'
      guestData: 'phone'
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses the pricing rung with no price at all', () => {
    // The rung exists to show a price. "Show a price, show no price" is not an
    // opinion, it is a record disagreeing with itself.
    const proof: Rejects<{
      calendar: 'availability_price'
      price: 'none'
      guestData: 'none'
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses amendment rights below the booking rung', () => {
    // Amending a booking this agent cannot make. `?: never` on the lower
    // variants is what makes this a refusal rather than an ignored key.
    const proof: Rejects<{
      calendar: 'availability_hold'
      price: 'agent'
      guestData: 'none'
      amendments: readonly ['dates']
    }> = true
    expect(proof).toBe(true)
  })

  it('refuses a payment link below the booking rung', () => {
    const proof: Rejects<{
      calendar: 'none'
      price: 'none'
      guestData: 'none'
      paymentLink: true
    }> = true
    expect(proof).toBe(true)
  })

  it('requires the booking rung to decide amendments, cancellation and links', () => {
    // Not optional properties. A business granting the booking rung decides all
    // three rather than inheriting a default nobody chose.
    const proof: Rejects<{
      calendar: 'availability_booking'
      price: 'agent'
      guestData: 'none'
    }> = true
    expect(proof).toBe(true)
  })

  it('still accepts the coherent combinations, so the guard is not vacuous', () => {
    // Without this, every test above would pass just as happily if `Rejects<T>`
    // were hard-wired to `true`.
    const referral: Rejects<{
      calendar: 'none'
      price: 'none'
      guestData: 'none'
    }> = false
    const pricing: Rejects<{
      calendar: 'availability_price'
      price: 'agent'
      guestData: 'none'
    }> = false
    expect([referral, pricing]).toEqual([false, false])
  })
})

// ── The ladders resolve cumulatively ──────────────────────────────────────

describe('a rung grants everything beneath it', () => {
  it('gives the net-rate agent the agent and public rates too', () => {
    const grants = grantsForAgentAccess({
      calendar: 'availability_booking',
      price: 'net',
      guestData: 'none',
      amendments: [],
      cancellation: { kind: 'never' },
      paymentLink: false,
    })
    expect(grants.has('rate.view_net')).toBe(true)
    expect(grants.has('rate.view_agent')).toBe(true)
    expect(grants.has('rate.view_public')).toBe(true)
  })

  it('gives the booking rung the hold and quote rights beneath it', () => {
    const grants = grantsForAgentAccess(AGENT_PRESETS.sales)
    expect(grants.has('availability.view')).toBe(true)
    expect(grants.has('quote.create')).toBe(true)
    expect(grants.has('hold.create')).toBe(true)
    expect(grants.has('booking.create')).toBe(true)
  })

  it('gives the email rung the name and phone beneath it', () => {
    const grants = grantsForAgentAccess({
      calendar: 'availability_booking',
      price: 'agent',
      guestData: 'email',
      amendments: [],
      cancellation: { kind: 'never' },
      paymentLink: false,
    })
    expect(grants.has('guest.view_name')).toBe(true)
    expect(grants.has('guest.view_phone')).toBe(true)
    expect(grants.has('guest.view_email')).toBe(true)
  })
})

// ── What each preset opens, and what it does not ──────────────────────────

describe('the four presets', () => {
  it('gives a referral agent leads and nothing else', () => {
    const grants = grantsForAgentAccess(AGENT_PRESETS.referral)
    expect(grants.has('lead.create')).toBe(true)
    expect(grants.has('commission.view')).toBe(true)

    // The denials that matter. A referral agent never sees the diary.
    expect(grants.has('availability.view')).toBe(false)
    expect(grants.has('hold.create')).toBe(false)
    expect(grants.has('booking.create')).toBe(false)
    expect(grants.has('rate.view_public')).toBe(false)
    expect(grants.has('quote.create')).toBe(false)
  })

  it('gives a sales agent the calendar and never a guest', () => {
    const grants = grantsForAgentAccess(AGENT_PRESETS.sales)
    expect(grants.has('availability.view')).toBe(true)
    expect(grants.has('rate.view_agent')).toBe(true)

    // None of these are needed to sell a night that is free.
    expect(grants.has('guest.view_name')).toBe(false)
    expect(grants.has('guest.view_phone')).toBe(false)
    expect(grants.has('guest.view_email')).toBe(false)
    expect(grants.has('booking.view_price')).toBe(false)
    expect(grants.has('booking.view_source')).toBe(false)
    expect(grants.has('rate.view_net')).toBe(false)
  })

  it('gives a senior agent amendments and a payment link, not the net rate', () => {
    const grants = grantsForAgentAccess(AGENT_PRESETS.senior)
    expect(grants.has('booking.amend_price')).toBe(true)
    expect(grants.has('guest.update')).toBe(true)
    expect(grants.has('payment.request_link')).toBe(true)
    expect(grants.has('booking.cancel')).toBe(true)
    expect(grants.has('rate.view_net')).toBe(false)
    // Never the raw payment detail — coarse status only, and not even that
    // unless the ladder was moved.
    expect(grants.has('payment.view')).toBe(false)
  })

  it('gives an agency manager the net rate and the guest phone, never the email', () => {
    const grants = grantsForAgentAccess(AGENT_PRESETS.agency)
    expect(grants.has('rate.view_net')).toBe(true)
    expect(grants.has('guest.view_phone')).toBe(true)
    expect(grants.has('guest.view_email')).toBe(false)
    // The email is the business's channel for the next stay.
  })

  it('never grants any preset a right over another agent or the business', () => {
    const forbidden: readonly Grant[] = [
      'agent.scope.manage',
      'agent_agreement.manage',
      'agent_limits.manage',
      'commission.approve',
      'commission.payout',
      'booking.export',
      'guest.export',
      'report.financial.view',
      'booking.view_profitability',
      'guest.view_document_id',
      'booking.note.internal',
      'permission.edit',
      'user.invite',
      'audit.view',
    ]
    for (const name of AGENT_PRESET_NAMES) {
      const grants = grantsForAgentAccess(AGENT_PRESETS[name])
      for (const grant of forbidden) {
        expect(
          grants.has(grant),
          `preset "${name}" must not hold "${grant}"`,
        ).toBe(false)
      }
    }
  })
})

// ── A preset is not a type ────────────────────────────────────────────────

describe('presets are seed values, not stored kinds', () => {
  it('produces a custom role assignment, so stored ladders stay authoritative', () => {
    // A *system* role would be re-resolved from the catalogue on every request
    // and would silently overwrite every edit an owner made.
    const assignment = agentRoleAssignment(AGENT_PRESETS.sales)
    expect(assignment.kind).toBe('custom')
    expect(assignment.grants.length).toBeGreaterThan(0)
  })

  it('gives an edited preset different grants from the preset it came from', () => {
    const edited: AgentAccess = {
      ...AGENT_PRESETS.sales,
      price: 'public',
    }
    const before = grantsForAgentAccess(AGENT_PRESETS.sales)
    const after = grantsForAgentAccess(edited)
    expect(before.has('rate.view_agent')).toBe(true)
    expect(after.has('rate.view_agent')).toBe(false)
    expect(after.has('rate.view_public')).toBe(true)
  })

  it('keeps a seeded preset’s non-ladder rights and drops nothing else', () => {
    // `lead.update` is on `sales_agent` and on no rung of any ladder, so no
    // screen can take it away. Everything the ladders *can* decide is answered
    // by the stored row instead — here a sales agent narrowed to leads only.
    const narrowed = agentRoleAssignment(
      { calendar: 'none', price: 'none', guestData: 'none' },
      ['sales_agent'],
    )
    const grants = new Set(narrowed.grants)

    expect(grants.has('lead.update')).toBe(true)
    expect(grants.has('approval.request')).toBe(true)
    expect(grants.has('availability.view')).toBe(false)
    expect(grants.has('booking.create')).toBe(false)
    expect(grants.has('rate.view_agent')).toBe(false)
  })

  it('resolves the senior preset to its stored amendments, not the role’s', () => {
    // A deliberate narrowing rather than a regression, and the clearest single
    // example of the defect being closed. `senior_agent` in roles.ts carries
    // the whole `AMENDMENT_GRANTS` set including `booking.amend_dates`, while
    // `AGENT_PRESETS.senior` lists four amendments and not `dates`. The screen
    // has always shown dates as off; until resolution projected the stored
    // row, the engine let a senior agent move them anyway.
    const grants = new Set(
      agentRoleAssignment(AGENT_PRESETS.senior, ['senior_agent']).grants,
    )

    expect(grants.has('booking.amend_price')).toBe(true)
    expect(grants.has('booking.amend_dates')).toBe(false)
    // And the non-ladder half of the same role is untouched.
    expect(grants.has('booking.view_payment_status')).toBe(true)
  })
})

// ── Predicates ────────────────────────────────────────────────────────────

describe('the shape questions', () => {
  it('answers what each rung can do', () => {
    expect(canSeeAvailability(AGENT_PRESETS.referral)).toBe(false)
    expect(canSeeAvailability(AGENT_PRESETS.sales)).toBe(true)
    expect(canHold(AGENT_PRESETS.referral)).toBe(false)
    expect(canHold(AGENT_PRESETS.sales)).toBe(true)
    expect(canBook(AGENT_PRESETS.referral)).toBe(false)
    expect(canBook(AGENT_PRESETS.sales)).toBe(true)
  })
})

// ── The one door from untyped data ────────────────────────────────────────

describe('parsing a row from the database', () => {
  it('accepts every preset round-tripped through JSON', () => {
    for (const name of AGENT_PRESET_NAMES) {
      const raw: unknown = JSON.parse(JSON.stringify(AGENT_PRESETS[name]))
      expect(parseAgentAccess(raw), name).toEqual(AGENT_PRESETS[name])
    }
  })

  it.each([
    [
      'a price without a calendar',
      { calendar: 'none', price: 'net', guestData: 'none' },
    ],
    [
      'a price at the free/busy rung',
      { calendar: 'availability', price: 'public', guestData: 'none' },
    ],
    [
      'guest data below the booking rung',
      { calendar: 'availability_hold', price: 'agent', guestData: 'name' },
    ],
    [
      'the pricing rung with no price',
      { calendar: 'availability_price', price: 'none', guestData: 'none' },
    ],
    [
      'an unknown calendar level',
      { calendar: 'everything', price: 'net', guestData: 'none' },
    ],
    [
      'an unknown price level',
      { calendar: 'availability_price', price: 'cost', guestData: 'none' },
    ],
    [
      'an unknown guest level',
      { calendar: 'availability_booking', price: 'net', guestData: 'passport' },
    ],
    ['null', null],
    ['a string', 'sales'],
    ['an array', []],
    ['an empty object', {}],
  ])('refuses %s', (_label, raw) => {
    expect(parseAgentAccess(raw)).toBeNull()
  })

  it('refuses a booking rung missing its required decisions', () => {
    expect(
      parseAgentAccess({
        calendar: 'availability_booking',
        price: 'agent',
        guestData: 'none',
        // no amendments, no cancellation, no paymentLink
      }),
    ).toBeNull()
  })

  it('refuses an unknown amendment rather than dropping it', () => {
    expect(
      parseAgentAccess({
        calendar: 'availability_booking',
        price: 'agent',
        guestData: 'none',
        amendments: ['dates', 'delete_the_booking'],
        cancellation: { kind: 'never' },
        paymentLink: false,
      }),
    ).toBeNull()
  })

  it('drops a duplicated amendment rather than refusing the whole agent', () => {
    // A repeated grant is the same grant. Locking somebody out over a cosmetic
    // flaw in their row helps nobody.
    const parsed = parseAgentAccess({
      calendar: 'availability_booking',
      price: 'agent',
      guestData: 'none',
      amendments: ['dates', 'dates'],
      cancellation: { kind: 'never' },
      paymentLink: false,
    })
    expect(parsed && canBook(parsed) && parsed.amendments).toEqual(['dates'])
  })

  it('refuses a negative cancellation window', () => {
    expect(
      parseAgentAccess({
        calendar: 'availability_booking',
        price: 'agent',
        guestData: 'none',
        amendments: [],
        cancellation: { kind: 'hours_before_arrival', hours: -4 },
        paymentLink: false,
      }),
    ).toBeNull()
  })

  it('rebuilds rather than casts, so unknown extra keys do not survive', () => {
    // A row repaired by hand in a console must not smuggle a field through.
    const parsed = parseAgentAccess({
      calendar: 'availability',
      price: 'none',
      guestData: 'none',
      secretlyAllowEverything: true,
    })
    expect(parsed).toEqual({
      calendar: 'availability',
      price: 'none',
      guestData: 'none',
    })
    expect(Object.keys(parsed ?? {})).toEqual([
      'calendar',
      'price',
      'guestData',
    ])
  })
})
