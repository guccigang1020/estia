/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Free/busy for the month, and for a proposed stay.
 *
 * ── THERE IS NO AVAILABILITY LOGIC IN THIS FILE ───────────────────────────
 *
 * Not a `WHERE status IN (...)`, not an overlap comparison, not an expiry
 * check. Every answer here comes from `src/lib/booking/availability.ts` through
 * `SupabaseBookingRepository`, which is the `AvailabilitySource` the domain
 * already has. A screen that computed its own "is this free" would be a second
 * definition of occupancy, and the day the two disagreed the product would
 * either double-book a villa or refuse a sellable night. This module chooses
 * *which* engine function to call and hands the answer to a component.
 *
 * ── TWO CALLERS, TWO ANSWERS, ONE ENGINE ──────────────────────────────────
 *
 * `availabilityCalendar` reports `booked`, `held` and `blocked` separately.
 * That is the internal diary and it is not for everyone: telling an external
 * seller a night is *held* tells them a rival is mid-deal on it.
 * `agentAvailabilityCalendar` in `src/lib/agents/availability-view.ts` already
 * owns that collapse, is tested on the exact key set it returns, and asserts
 * the reader's inventory scope on the way in — so a reader without
 * `booking.view` is served by it rather than by a projection written here.
 * `inventory.ts` has already established that such a reader holds
 * `availability.view` and is in scope, so neither assertion can surprise us.
 *
 * ── THE N+1, STATED RATHER THAN HIDDEN ────────────────────────────────────
 *
 * `AvailabilitySource` is a per-unit port: rules, bookings and holds are three
 * reads per unit, and a month of twenty units is sixty round trips, issued in
 * parallel. A batching source that pre-loaded all three in three queries would
 * be faster and would mean a second copy of the rules mapping — including the
 * `status <> 'active'` rule that makes a unit unsellable, and the
 * `units.metadata` date lists — living beside the one in
 * `persistence/booking.ts`. That is the mapping most worth not duplicating, so
 * the real adapter is used and the cost is named here. The fix, when it is
 * needed, is a batching method on the port, not a query in this file.
 */

import {
  availabilityCalendar,
  checkAvailability,
  type AvailabilityBlocker,
  type AvailabilityOptions,
} from '@/lib/booking/availability'
import type { DateRange } from '@/lib/booking/types'
import {
  AGENT_BLOCKER_MESSAGE,
  agentAvailabilityCalendar,
  agentCanSell,
} from '@/lib/agents/availability-view'
import type { Actor } from '@/lib/authz/can'
import { SupabaseBookingRepository, type Db } from '@/lib/persistence'
import type { CalendarDayState } from '@/components/calendar/state-meta'

import type { CalendarUnit } from './inventory'

/* ------------------------------------------------------------- the month -- */

export interface UnitDay {
  date: string
  state: CalendarDayState
}

export interface UnitMonth {
  unit: CalendarUnit
  days: readonly UnitDay[]
}

export interface MonthAvailabilityArgs {
  db: Db
  actor: Actor
  organizationId: string
  units: readonly CalendarUnit[]
  range: DateRange
  now: Date
}

/** One row of the grid per unit, one cell per night. */
export async function loadMonthAvailability(
  args: MonthAvailabilityArgs,
): Promise<UnitMonth[]> {
  const { db, actor, organizationId, units, range, now } = args
  const source = new SupabaseBookingRepository(db)
  const options: AvailabilityOptions = { now }

  return Promise.all(
    units.map(async (unit): Promise<UnitMonth> => {
      const window = { organizationId, unitId: unit.id, range }

      if (unit.detailed) {
        const days = await availabilityCalendar(source, window, options)
        // Constructed field by field, never spread. `DayAvailability` also
        // carries `bookingId` and `holdId`, and the whole reason the agent
        // module refuses to copy objects is that a field added to it upstream
        // would otherwise travel outward on its own. Two reads, and nothing
        // else can ride along — today or after somebody widens that type.
        return { unit, days: days.map((day) => toUnitDay(day.date, day.state)) }
      }

      const days = await agentAvailabilityCalendar(
        actor,
        source,
        {
          unit: {
            organizationId,
            propertyId: unit.propertyId,
            unitId: unit.id,
          },
          range,
        },
        options,
      )
      return { unit, days: days.map((day) => toUnitDay(day.date, day.state)) }
    }),
  )
}

/** The only way a `UnitDay` is made: two values, and no object copied. */
function toUnitDay(date: string, state: CalendarDayState): UnitDay {
  return { date, state }
}

/** Every state actually drawn, for a legend that lists no mark it did not use. */
export function statesPresent(
  rows: readonly UnitMonth[],
): Set<CalendarDayState> {
  const present = new Set<CalendarDayState>()
  for (const row of rows) {
    for (const day of row.days) present.add(day.state)
  }
  return present
}

/* -------------------------------------------------------- a proposed stay -- */

export interface UnitSellability {
  unit: CalendarUnit
  available: boolean
  nights: number
  /**
   * Hebrew, from the domain. Never composed here.
   *
   * For a reader entitled to the internal diary these are the engine's own
   * blocker messages, which name the booking reference that is in the way. For
   * everyone else they are `AGENT_BLOCKER_MESSAGE`, which deliberately says
   * only "not available" — the reference belongs to somebody else's sale.
   */
  reasons: readonly string[]
}

export interface SellabilityArgs {
  db: Db
  actor: Actor
  organizationId: string
  units: readonly CalendarUnit[]
  range: DateRange
  now: Date
}

/** Can each unit be sold for this range? */
export async function loadSellability(
  args: SellabilityArgs,
): Promise<UnitSellability[]> {
  const { db, actor, organizationId, units, range, now } = args
  const source = new SupabaseBookingRepository(db)
  const options: AvailabilityOptions = { now }

  return Promise.all(
    units.map(async (unit): Promise<UnitSellability> => {
      if (unit.detailed) {
        const result = await checkAvailability(
          source,
          { organizationId, unitId: unit.id, range },
          options,
        )
        return {
          unit,
          available: result.available,
          nights: result.nights,
          reasons: dedupe(
            result.blockers.map(
              (blocker: AvailabilityBlocker) => blocker.message,
            ),
          ),
        }
      }

      const result = await agentCanSell(
        actor,
        source,
        {
          unit: {
            organizationId,
            propertyId: unit.propertyId,
            unitId: unit.id,
          },
          range,
        },
        options,
      )
      return {
        unit,
        available: result.sellable,
        nights: result.nights,
        reasons: result.reasons.map((reason) => AGENT_BLOCKER_MESSAGE[reason]),
      }
    }),
  )
}

/** Five occupied nights are one sentence, not five identical ones. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
