/**
 * 🔒 The freeze.
 *
 * ══ THE RULE THIS FILE EXISTS FOR ═══════════════════════════════════════════
 *
 * **A booking's price is frozen the moment it is taken, and no later change to
 * any rate source moves it by one agora.**
 *
 * A guest who booked in March at March's rate still owes March's price when
 * somebody opens the booking in August, after the season, the modifiers, the
 * plan's floor and the property's VAT rate have all moved. Re-computing on
 * read is how a business accidentally re-prices a stay somebody already paid
 * for, and nobody notices, because the new number looks exactly as plausible
 * as the old one.
 *
 * ══ HOW IT IS ACTUALLY PREVENTED ════════════════════════════════════════════
 *
 * Not by discipline. By there being no function that could do it:
 *
 *   1. **This module exports nothing that turns a snapshot into money.**
 *      `describeSnapshot` returns the stored per-night account for display.
 *      `resolveStay` takes a full `PricingContext` and returns a request. There
 *      is no third shape — nothing accepts a booking id and returns a total,
 *      because that function is the whole hazard.
 *
 *   2. **The money is somewhere else entirely.** `booking_price_lines` holds
 *      the amounts and `bookings.total_agorot` is a database-maintained sum of
 *      them (0009). This module never writes either, and
 *      `booking_price_snapshots` stores no total at all — so a snapshot cannot
 *      be mistaken for the price even by a careless reader.
 *
 *   3. **The database refuses.** `booking_price_snapshots` grants INSERT and
 *      UPDATE to nobody; the only writer is
 *      `public.capture_booking_price_snapshot`, and a trigger refuses every
 *      UPDATE except marking one row superseded, once, from null.
 *
 *   4. **What was true is copied, not referenced.** `cancellationPolicy`, the
 *      tax rate and the rate plan's version travel INTO the snapshot. A
 *      pointer to `rate_plans` survives only until somebody edits that plan,
 *      and editing the plan is exactly the event a snapshot exists to survive.
 *      This is the same argument `src/lib/finance/snapshot.ts` makes about
 *      `FinanceSnapshot.lines` being a copy, and it is deliberate duplication
 *      rather than an oversight in either place.
 *
 * ══ THE RELATIONSHIP TO `FinanceSnapshot` (spec §3.7.1) ═════════════════════
 *
 * Two stages of one line, not two copies of one thing:
 *
 *   · `booking_price_snapshots` freezes **why** the price came out this way —
 *     the winning rule per night, the additions, the clamp. Captured when the
 *     stay is priced. It PRODUCES the lines, through `priceStay`.
 *   · `FinanceSnapshot` freezes **what** is derived from the price —
 *     commission, the owner's share, expense rules. Captured when the booking
 *     becomes financially real. It COPIES the lines and computes none.
 *
 * The direction is one-way and enforced by imports: nothing in this directory
 * imports from `src/lib/finance`, and `captureFinanceSnapshot` is handed lines
 * and has no access to a rate card. Pricing never reads finance; finance never
 * prices.
 */

import { fingerprint } from '../service'
import {
  PRICING_ENGINE_VERSION,
  type BookingPriceSnapshot,
  type NightResolution,
  type PricingContext,
  type PricingResolution,
} from './types'
import type { ResolvedStay } from './resolve'

/**
 * What is written into `booking_price_snapshots.inputs`.
 *
 * The full request as it was handed to `priceStay`, plus the identity of what
 * was being priced. Everything a person would need to understand the quote
 * without the rate card in front of them — which is the situation they will
 * actually be in, months later, in an argument.
 *
 * The promotion and coupon CODES that were presented belong here too, as
 * recorded strings with no foreign key. That is the seam the promotions
 * migration needs: a snapshot has to survive a promotion being deleted, and a
 * foreign key would make it false at exactly the moment it mattered.
 */
export interface SnapshotInputs {
  organizationId: string
  propertyId: string
  unitId: string
  checkIn: string
  checkOut: string
  guests: number
  eventType: string | null
  source: string
  effectiveOn: string
  baseUnitNightlyAgorot: number
  unitStandardGuests: number
  extraGuestNightlyAgorot: number | null
  cleaningFeeAgorot: number | null
  depositAgorot: number | null
  taxRatePercent: number | null
  nightlyOverrides: Readonly<Record<string, number>>
  /** Codes as presented. Strings, never ids — see above. */
  promotionCodes: readonly string[]
  couponCode: string | null
}

export interface SnapshotResolution {
  ratePlanId: string
  ratePlanCode: string
  derivedFromPlanIds: readonly string[]
  minimumNights: number
  floorAgorot: number | null
  ceilingAgorot: number | null
  nights: readonly NightResolution[]
}

export interface SnapshotDraft {
  hash: string
  engineVersion: string
  effectiveOn: string
  ratePlanId: string
  ratePlanVersion: number
  inputs: SnapshotInputs
  resolution: SnapshotResolution
  cancellationPolicy: Readonly<Record<string, unknown>>
}

/**
 * Freeze a resolved stay into the document that explains it.
 *
 * Deliberately takes the resolution rather than the quote. Handing this
 * function a `StayQuote` would mean the snapshot carried a total, and a
 * snapshot carrying a total is one somebody eventually reads the total out of
 * instead of reading `booking_price_lines` — which is the drift this whole
 * design exists to make impossible.
 */
export function buildSnapshot(
  context: PricingContext,
  resolved: ResolvedStay,
  options: {
    promotionCodes?: readonly string[]
    couponCode?: string | null
  } = {},
): SnapshotDraft {
  const { resolution } = resolved

  const inputs: SnapshotInputs = {
    organizationId: context.organizationId,
    propertyId: context.propertyId,
    unitId: context.unitId,
    checkIn: context.range.checkIn,
    checkOut: context.range.checkOut,
    guests: context.guests,
    eventType: context.eventType,
    source: context.source,
    effectiveOn: context.effectiveOn,
    baseUnitNightlyAgorot: context.baseUnitNightlyAgorot,
    unitStandardGuests: context.unitStandardGuests,
    extraGuestNightlyAgorot: context.extraGuestNightlyAgorot ?? null,
    cleaningFeeAgorot: context.cleaningFeeAgorot ?? null,
    depositAgorot: context.depositAgorot ?? null,
    taxRatePercent: context.taxRatePercent ?? null,
    nightlyOverrides: { ...resolved.request.nightlyOverrides },
    promotionCodes: options.promotionCodes ?? [],
    couponCode: options.couponCode ?? null,
  }

  const snapshotResolution: SnapshotResolution = {
    ratePlanId: resolution.ratePlan.id,
    ratePlanCode: resolution.ratePlan.code,
    derivedFromPlanIds: resolution.derivedFromPlanIds,
    minimumNights: resolution.minimumNights,
    floorAgorot: resolution.floorAgorot,
    ceilingAgorot: resolution.ceilingAgorot,
    nights: resolution.nights,
  }

  return {
    // `fingerprint` sorts object keys before hashing, so two runs that built
    // the same document in a different property order produce the same hash.
    // A hash that depends on insertion order would report a change on every
    // re-quote and be ignored within a week.
    hash: fingerprint({ inputs, resolution: snapshotResolution }),
    engineVersion: PRICING_ENGINE_VERSION,
    effectiveOn: context.effectiveOn,
    ratePlanId: resolution.ratePlan.id,
    ratePlanVersion: resolution.ratePlan.version,
    inputs,
    resolution: snapshotResolution,
    cancellationPolicy: resolution.ratePlan.cancellationPolicy,
  }
}

/**
 * Has anything about this configuration changed since the quote was made?
 *
 * Spec §17: a quote carries the hash of the snapshot it was built from, and
 * creating a booking from a quote whose hash is no longer current shows the
 * difference and asks. It does NOT silently re-price, and it does not silently
 * honour the stale figure either — the first surprises the guest and the
 * second surprises the business.
 */
export function snapshotHasDrifted(
  quotedHash: string,
  current: SnapshotDraft,
): boolean {
  return quotedHash !== current.hash
}

/**
 * Read a stored snapshot back, for display.
 *
 * 🔒 Note what this returns: the STORED per-night account, exactly as it was
 * written. Nothing here consults `context.rules`, `context.calendar` or a rate
 * plan, and nothing here can — the parameter is a row, not a context. A future
 * change that made this function take a `PricingContext` would be the change
 * that broke the freeze, which is why the signature is worth defending in
 * review.
 */
export function describeSnapshot(snapshot: BookingPriceSnapshot): {
  sequence: number
  isLive: boolean
  engineVersion: string
  effectiveOn: string
  nights: readonly NightResolution[]
} {
  const resolution = snapshot.resolution as Partial<SnapshotResolution>
  return {
    sequence: snapshot.sequence,
    isLive: snapshot.supersededBy === null,
    engineVersion: snapshot.engineVersion,
    effectiveOn: snapshot.effectiveOn,
    nights: resolution.nights ?? [],
  }
}

/**
 * The per-night figures a screen shows beside a booking.
 *
 * Sums nothing. The caller that wants a total reads `booking_price_lines`,
 * which is the only place one exists.
 */
export function nightlyFiguresOf(
  resolution: PricingResolution,
): readonly { date: string; agorot: number; why: string }[] {
  return resolution.nights.map((night) => ({
    date: night.date,
    agorot: night.nightlyAgorot,
    why: [
      night.baseLabel,
      night.calendarAdd > 0 ? 'תוספת לוח שנה' : null,
      night.demandAdd > 0 ? 'תוספת ביקוש' : null,
      night.clampedTo === 'floor' ? 'הוגבל לרצפה' : null,
      night.clampedTo === 'ceiling' ? 'הוגבל לתקרה' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  }))
}
