/**
 * Reservation, and the oversell that must not happen.
 *
 * Two halves, and the second is the one that matters. The first proves the
 * guard produces the right sentence. The second proves the *adapter does not
 * do the arithmetic at all* — because a read-modify-write that passes every
 * unit test is still a race, and the only unit-testable claim about
 * concurrency is which mechanism the code reaches for.
 */

import { describe, expect, it } from 'vitest'

import { BusinessRuleError, ValidationError } from '../errors'
import { FakeSupabaseClient } from '../persistence/fake-client'
import { SupabaseInventoryRepository } from '../persistence/inventory'

import { capabilitiesFor, startingSettingsFor } from './settings'
import {
  assertReservationsEnabled,
  claimDateOf,
  coversDate,
  planReservation,
} from './reservation'
import type { Reservation } from './types'

const ITEM = {
  itemId: 'item-towel',
  label: 'מגבת גוף',
  quantity: 50,
  quantityReserved: 32,
}

const REQUEST = {
  itemId: 'item-towel',
  quantity: 10,
  neededFrom: '2026-09-04',
  neededTo: '2026-09-06',
  bookingId: 'booking-1',
}

describe('planReservation', () => {
  it('allows what is free and reports what is left', () => {
    const plan = planReservation(ITEM, REQUEST)

    expect(plan.freeBefore).toBe(18)
    expect(plan.freeAfter).toBe(8)
    expect(plan.replaces).toBe(false)
  })

  it('refuses more than is free, and names both numbers', () => {
    expect(() => planReservation(ITEM, { ...REQUEST, quantity: 25 })).toThrow(
      BusinessRuleError,
    )

    try {
      planReservation(ITEM, { ...REQUEST, quantity: 25 })
    } catch (error) {
      const failure = error as BusinessRuleError
      expect(failure.code).toBe('inventory_insufficient')
      // The Hebrew says eighteen and twenty-five, so a person can act on it
      // without opening the database.
      expect(failure.userMessage).toContain('25')
      expect(failure.userMessage).toContain('18')
    }
  })

  it('treats raising an existing reservation as a change, not a second promise', () => {
    // The booking already holds twenty-five of the thirty-two reserved. Raising
    // it to thirty needs five more, not thirty more — and without this a party
    // growing by two on a nearly-full cupboard is refused while the stock sits
    // in that booking's own reservation.
    const plan = planReservation(
      { ...ITEM, existingQuantity: 25 },
      { ...REQUEST, quantity: 30 },
    )

    expect(plan.freeBefore).toBe(43)
    expect(plan.replaces).toBe(true)
  })

  it('refuses a nonsense request before the database is touched', () => {
    expect(() => planReservation(ITEM, { ...REQUEST, quantity: 0 })).toThrow(
      ValidationError,
    )
    expect(() =>
      planReservation(ITEM, { ...REQUEST, neededTo: '2026-09-01' }),
    ).toThrow(ValidationError)
  })
})

describe('the capability gate is a different refusal', () => {
  it('says the module is off rather than that the cupboard is empty', () => {
    const off = capabilitiesFor(startingSettingsFor('org-1', 'basic'))

    expect(() => assertReservationsEnabled(off)).toThrow(BusinessRuleError)
    try {
      assertReservationsEnabled(off)
    } catch (error) {
      expect((error as BusinessRuleError).code).toBe(
        'inventory_reservations_disabled',
      )
    }
  })

  it('permits it under tracked', () => {
    const on = capabilitiesFor(startingSettingsFor('org-1', 'tracked'))
    expect(() => assertReservationsEnabled(on)).not.toThrow()
  })
})

describe('a reservation claims one day and covers a window', () => {
  const reservation: Reservation = {
    id: 'res-1',
    propertyId: 'property-a',
    itemId: 'item-towel',
    bookingId: 'booking-1',
    quantity: 25,
    status: 'reserved',
    neededFrom: '2026-09-04',
    neededTo: '2026-09-08',
    note: null,
  }

  it('claims stock on the first day only', () => {
    // Counting it on every night of a five-night stay would report five times
    // the requirement and produce a wall of shortages that do not exist.
    expect(claimDateOf(reservation)).toBe('2026-09-04')
  })

  it('covers every day of the window', () => {
    expect(coversDate(reservation, '2026-09-04')).toBe(true)
    expect(coversDate(reservation, '2026-09-06')).toBe(true)
    expect(coversDate(reservation, '2026-09-08')).toBe(true)
    expect(coversDate(reservation, '2026-09-09')).toBe(false)
  })

  it('covers nothing once released', () => {
    expect(
      coversDate({ ...reservation, status: 'released' }, '2026-09-06'),
    ).toBe(false)
  })
})

describe('the adapter does not do the arithmetic', () => {
  /**
   * The load-bearing assertion in this file.
   *
   * If `reserve` ever becomes a select followed by an update of
   * `quantity_reserved`, two concurrent reservations both read the same
   * starting number and the second write overwrites rather than adds. Nothing
   * about that is visible in a unit test of the result — both callers get
   * "success" — so the test is about the *mechanism*: it must be one call to
   * the database function, which locks the row, increments relatively, and is
   * backstopped by `inventory_items_reserved_within_quantity`.
   */
  it('reserves through the database function and never writes the column', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:reserve_inventory': {
          data: {
            reservationId: 'res-new',
            itemId: 'item-towel',
            organizationId: 'org-1',
            propertyId: 'property-a',
            quantity: 10,
            freeAfter: 8,
          },
        },
      },
    })

    const repository = new SupabaseInventoryRepository(fake.asDb())
    const result = await repository.reserve(REQUEST)

    expect(result.reservationId).toBe('res-new')
    expect(result.freeAfter).toBe(8)

    // One RPC, and no update of inventory_items anywhere in the transcript.
    expect(fake.queriesFor('rpc:reserve_inventory')).toHaveLength(1)
    expect(
      fake.queries.some(
        (query) =>
          query.table === 'inventory_items' &&
          (query.verb === 'update' || query.verb === 'upsert'),
      ),
    ).toBe(false)
  })

  it('releases through the database function too', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        'rpc:release_inventory_reservation': {
          data: { reservationId: 'res-1', released: true, status: 'released' },
        },
      },
    })

    const repository = new SupabaseInventoryRepository(fake.asDb())
    await repository.releaseReservation('res-1', 'ההזמנה בוטלה')

    expect(fake.queriesFor('rpc:release_inventory_reservation')).toHaveLength(1)
    expect(
      fake.queries.some(
        (query) => query.table === 'inventory_items' && query.verb === 'update',
      ),
    ).toBe(false)
  })
})
