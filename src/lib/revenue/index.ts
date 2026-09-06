/**
 * Revenue intelligence from the data this product actually holds.
 *
 * PURE. Nothing here queries and nothing here writes, which is what lets every
 * figure be tested against handmade bookings rather than a seeded database.
 * There is no migration behind this module: like `listing-quality`, the
 * numbers are derived on read, because a stored occupancy figure drifts from
 * the bookings it describes the moment one of them is cancelled.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is compare a business to its market. That
 * needs a source of competitor prices and no such source exists in this
 * product or behind it — so `marketPosition` is always absent, with the reason
 * shown to the reader. `listing-quality` refuses the identical question in the
 * identical way.
 */

export {
  isBackdated,
  isDemand,
  isLost,
  isOccupying,
  leadTimeDays,
  nightsBetween,
  nightsInWindow,
  shareInWindow,
} from './stays'

export { demandCount, revenueReport, type RevenueInput } from './metrics'

export {
  METRIC_LABEL,
  METRIC_NOTE,
  SOURCE_LABEL,
  UNMEASURABLE_LABEL,
  shekels,
} from './labels'

export {
  known,
  unknown,
  type BookingSourceName,
  type BookingStatusName,
  type ChannelShare,
  type Measure,
  type RevenueBooking,
  type RevenueReport,
  type Unmeasurable,
  type Window,
} from './types'

export {
  WINDOW_LABEL,
  WINDOW_NIGHTS,
  isWindowName,
  windowFor,
  type WindowName,
} from './windows'
