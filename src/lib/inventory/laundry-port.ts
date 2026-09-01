/**
 * What the forecast needs to know about the laundry, expressed as a port this
 * module owns.
 *
 * ── Why a port and not an import ──────────────────────────────────────────
 *
 * `src/lib/laundry/**` is being written by another worker in this same wave.
 * A module that is not on disk is a resolution error, and a resolution error
 * in a shared chunk takes down every page of the application for everybody —
 * that has already happened once in this repository, and a dynamic `import()`
 * does not protect against it because the failure is at build time, not at
 * call time.
 *
 * So the dependency runs the other way. This file declares the two facts the
 * forecast needs, the null implementation below answers them honestly with
 * "nothing known", and the laundry module — when it exists — satisfies the
 * interface. The forecast is correct either way; without an implementation it
 * simply projects no laundry returns, which understates availability and
 * therefore over-reports shortages. That is the safe direction: a forecast
 * that invents returning towels is one that promises a changeover it cannot
 * deliver.
 *
 * ── The two facts, and why they are two ───────────────────────────────────
 *
 * `expectedReturns` is about batches that have already gone: forty sets left
 * on Thursday, the provider says Saturday afternoon. `inLaundry` is a count
 * for the dashboard — "where are my towels right now" — and is not the same
 * question, because a batch with no promised return date is real stock that
 * is genuinely absent from the forecast.
 *
 * `turnaroundDays` is the fallback the engine uses to schedule the return of
 * stock it projects will be *consumed* in the future, which no laundry order
 * exists for yet. Null means the business has not said, and the engine then
 * schedules nothing — see `forecast.ts`.
 */

import type { ExpectedReturn } from './types'

/** A batch that is out, counted by item and property. */
export interface InLaundryCount {
  propertyId: string
  itemId: string
  quantity: number
  /**
   * When the provider or the internal room says it comes back. Null is a real
   * answer and a common one — an order sent by WhatsApp on a Thursday
   * afternoon often has no promised date, and inventing one is how a forecast
   * reports enough towels for a changeover that arrives without them.
   */
  expectedBack: string | null
}

export interface LaundryOutlook {
  /** Stock arriving on known days. Feeds the timeline directly. */
  expectedReturns: readonly ExpectedReturn[]
  /** Everything currently out, including what has no promised date. */
  inLaundry: readonly InLaundryCount[]
  /** The business's own washing cycle, in days. Null when unstated. */
  turnaroundDays: number | null
}

export interface LaundryOutlookQuery {
  organizationId: string
  /** Empty means every property the caller may see. */
  propertyIds: readonly string[]
  /** Inclusive ISO dates. */
  from: string
  to: string
}

/**
 * The contract the laundry module satisfies.
 *
 * One method. A port with five is a module boundary nobody can implement
 * without reading the consumer, and the whole point of declaring it here is
 * that the other worker can satisfy it without reading this directory.
 */
export interface InventoryLaundryPort {
  outlook(query: LaundryOutlookQuery): Promise<LaundryOutlook>
}

/**
 * The honest empty answer.
 *
 * Not a stub to be replaced and forgotten: this is what the port returns for
 * an organization whose laundry mode is `off`, which is most of them, and it
 * stays in the product permanently for that reason. `turnaroundDays: null`
 * rather than a number, because "we do not know" must not be spelled as a
 * guess the forecast then treats as fact.
 */
export const NULL_LAUNDRY_PORT: InventoryLaundryPort = {
  async outlook() {
    return { expectedReturns: [], inLaundry: [], turnaroundDays: null }
  },
}

/**
 * A port backed by rows somebody already has.
 *
 * Used by the screens, which read the outlook once for the whole page and then
 * hand it to the engine, and by the tests, which is how the canonical failing
 * case is expressed without a laundry module existing.
 */
export function fixedLaundryPort(
  outlook: LaundryOutlook,
): InventoryLaundryPort {
  return {
    async outlook() {
      return outlook
    },
  }
}
