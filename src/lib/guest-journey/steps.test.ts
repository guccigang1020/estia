/**
 * The progress list, and the one thing to do first.
 *
 * The two rules `steps.ts` is organised around are the two this suite is
 * organised around: never an empty step, and exactly one dominant action. Both
 * are the kind of rule that decays quietly — a step that should have vanished
 * becomes a greyed-out row, a second button creeps in beside the first — so
 * they are asserted directly rather than inferred from a rendered screen.
 */

import { describe, expect, it } from 'vitest'

import { collectionFixture, journeyFixture } from './fixtures'
import { buildJourneyView } from './steps'

describe('never an empty step', () => {
  it('shows only confirmation for a business that requires nothing else', () => {
    // The quietest real configuration in this market, and the shipped default:
    // no contract, no details, no payment policy.
    const view = buildJourneyView(journeyFixture(), collectionFixture())

    expect(view.steps.map((step) => step.id)).toEqual(['confirm'])
  })

  it('omits the contract step entirely when the contract is disabled', () => {
    const view = buildJourneyView(
      journeyFixture({ settings: { contractMode: 'disabled' } }),
      collectionFixture(),
    )

    // Not present, not disabled, not marked "לא נדרש". Absent.
    expect(view.steps.find((step) => step.id === 'contract')).toBeUndefined()
  })

  it('omits the payment step when the policy collects nothing', () => {
    const view = buildJourneyView(journeyFixture(), collectionFixture())

    // `none` is a legitimate answer and must not render a payment step showing
    // ₪0 — a great many Israeli villas take the money on arrival.
    expect(view.steps.find((step) => step.id === 'payment')).toBeUndefined()
  })

  it('omits the details step when no field is required', () => {
    const view = buildJourneyView(
      journeyFixture({ settings: { requiredDetailFields: [] } }),
      collectionFixture(),
    )

    expect(view.steps.find((step) => step.id === 'details')).toBeUndefined()
  })

  it('shows no steps at all when the business asks for nothing', () => {
    const view = buildJourneyView(
      journeyFixture({ settings: { requireGuestConfirmation: false } }),
      collectionFixture(),
    )

    expect(view.steps).toEqual([])
    expect(view.complete).toBe(true)
  })

  it('adds each step only when its own switch is on', () => {
    const view = buildJourneyView(
      journeyFixture({
        settings: {
          contractMode: 'mandatory',
          requiredDetailFields: ['full_name', 'id_number'],
        },
      }),
      collectionFixture(
        {
          requirements: ['deposit_recorded'],
          outstanding: ['deposit_recorded'],
          confirmable: false,
        },
        { kind: 'manual_transfer', offerProofUpload: true },
      ),
    )

    expect(view.steps.map((step) => step.id)).toEqual([
      'confirm',
      'contract',
      'payment',
      'details',
    ])
  })
})

describe('the payment step is read, never recomputed', () => {
  it('is done when the decision reports nothing outstanding', () => {
    const view = buildJourneyView(
      journeyFixture(),
      collectionFixture({
        requirements: ['deposit_recorded'],
        outstanding: [],
        confirmable: true,
      }),
    )

    const payment = view.steps.find((step) => step.id === 'payment')
    expect(payment?.status).toBe('done')
  })

  it('is outstanding when the decision says it is', () => {
    // Confirmation switched off, so payment is the only step and therefore the
    // current one. Isolating it this way is deliberate: with a confirmation
    // step present and outstanding, payment would correctly be `upcoming`,
    // and the assertion would be about ordering rather than about the
    // decision being read.
    const view = buildJourneyView(
      journeyFixture({ settings: { requireGuestConfirmation: false } }),
      collectionFixture(
        {
          requirements: ['full_payment'],
          outstanding: ['full_payment'],
          confirmable: false,
        },
        { kind: 'manual_transfer' },
      ),
    )

    const payment = view.steps.find((step) => step.id === 'payment')
    expect(payment?.status).toBe('current')
    expect(payment?.required).toBe(true)
  })
})

describe('a policy the portal cannot satisfy is named, not looped', () => {
  it('blocks when a signature is required and no contract is configured', () => {
    const view = buildJourneyView(
      journeyFixture({ settings: { contractMode: 'disabled' } }),
      collectionFixture({
        requirements: ['contract_signed'],
        outstanding: ['contract_signed'],
        confirmable: false,
      }),
    )

    const contract = view.steps.find((step) => step.id === 'contract')
    // Named as a block rather than left as a step nobody can ever complete.
    expect(contract?.status).toBe('blocked')
    expect(contract?.path).toBeNull()
  })
})

describe('exactly one step is current', () => {
  it('marks the first outstanding step current and the rest upcoming', () => {
    const view = buildJourneyView(
      journeyFixture({
        settings: {
          contractMode: 'mandatory',
          requiredDetailFields: ['full_name'],
        },
      }),
      collectionFixture(),
    )

    const statuses = view.steps.map((step) => [step.id, step.status])
    expect(statuses).toEqual([
      ['confirm', 'current'],
      ['contract', 'upcoming'],
      ['details', 'upcoming'],
    ])
  })

  it('moves current along as steps are completed', () => {
    const view = buildJourneyView(
      journeyFixture({
        settings: {
          contractMode: 'mandatory',
          requiredDetailFields: ['full_name'],
        },
        confirmation: {
          confirmedAt: '2026-09-01T10:00:00Z',
          bookingVersion: 4,
          snapshot: {
            checkIn: '2026-09-03',
            checkOut: '2026-09-07',
            adults: 2,
            children: 0,
            infants: 0,
            totalAgorot: 750_000,
            currency: 'ILS',
            cancellationTerms: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
          },
        },
      }),
      collectionFixture(),
    )

    const statuses = view.steps.map((step) => [step.id, step.status])
    expect(statuses).toEqual([
      ['confirm', 'done'],
      ['contract', 'current'],
      ['details', 'upcoming'],
    ])
  })
})

describe('one dominant action', () => {
  const confirmed = {
    confirmedAt: '2026-09-01T10:00:00Z',
    bookingVersion: 4,
    snapshot: {
      checkIn: '2026-09-03',
      checkOut: '2026-09-07',
      adults: 2,
      children: 0,
      infants: 0,
      totalAgorot: 750_000,
      currency: 'ILS',
      cancellationTerms: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
    },
  }

  it('defers to the collection panel while the policy wants something', () => {
    const view = buildJourneyView(
      journeyFixture(),
      collectionFixture(
        {
          requirements: ['guest_confirmation'],
          outstanding: ['guest_confirmation'],
          confirmable: false,
        },
        { kind: 'confirm_booking' },
      ),
    )

    // The panel already chose between confirm, sign, pay, transfer and wait.
    // Choosing again here is how two controls end up disagreeing on one screen.
    expect(view.next.id).toBe('collection')
  })

  it('puts reconfirmation above everything, including the policy', () => {
    const view = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        // The price moved after they agreed.
        current: { totalAgorot: 800_000, bookingVersion: 5 },
      }),
      collectionFixture(
        {
          requirements: ['guest_confirmation'],
          outstanding: [],
          confirmable: true,
        },
        { kind: 'nothing_required' },
      ),
    )

    // A stale confirmation is still a confirmation as far as CollectionFacts is
    // concerned, so this is the one thing the payment module cannot know.
    expect(view.next.id).toBe('reconfirm')
    expect(view.reconfirmation.required).toBe(true)
  })

  it('asks for details once the policy is satisfied', () => {
    const view = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        settings: { requiredDetailFields: ['full_name'] },
      }),
      collectionFixture(),
    )

    expect(view.next.id).toBe('details')
  })

  it('offers the stay guide once the guest is in the house', () => {
    const view = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        current: { inStay: true, status: 'in_house' },
      }),
      collectionFixture(),
    )

    expect(view.next.id).toBe('stay')
  })

  it('offers arrival details only once they are released', () => {
    const locked = buildJourneyView(
      journeyFixture({ confirmation: confirmed }),
      collectionFixture(),
    )
    expect(locked.next.id).toBe('none')

    const released = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        arrival: {
          released: true,
          checkInTime: '15:00:00',
          addressNote: null,
          addressLine1: 'הגליל 4',
          addressLine2: null,
          city: 'רמת הגולן',
          directions: null,
          mapUrl: null,
          parking: null,
          accessInstructions: null,
          accessCode: '4821',
        },
      }),
      collectionFixture(),
    )
    expect(released.next.id).toBe('arrival')
  })

  it('says plainly that there is nothing to do rather than inventing a button', () => {
    const view = buildJourneyView(
      journeyFixture({ confirmation: confirmed }),
      collectionFixture(),
    )

    expect(view.next.id).toBe('none')
    expect(view.next.path).toBeNull()
    expect(view.complete).toBe(true)
  })

  it('thanks a guest who has declared they left', () => {
    const view = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        current: { status: 'checked_out' },
        checkout: {
          checkOutTime: '11:00:00',
          instructions: null,
          declaredAt: '2026-09-07T09:12:00Z',
          enabled: true,
        },
      }),
      collectionFixture(),
    )

    expect(view.next.id).toBe('none')
    expect(view.next.label).toBe('תודה ששהיתם אצלנו')
  })

  it('asks for a review only when one is configured with somewhere to go', () => {
    const view = buildJourneyView(
      journeyFixture({
        confirmation: confirmed,
        settings: {
          reviewEnabled: true,
          reviewUrl: 'https://maps.example/review',
        },
        current: { status: 'checked_out' },
        checkout: {
          checkOutTime: '11:00:00',
          instructions: null,
          declaredAt: '2026-09-07T09:12:00Z',
          enabled: true,
        },
      }),
      collectionFixture(),
    )

    expect(view.next.id).toBe('review')
  })
})
