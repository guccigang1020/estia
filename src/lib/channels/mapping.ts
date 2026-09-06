/**
 * Which listing is which unit.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 *
 * **A reservation for a listing nothing is mapped to is a channel exception.
 * It is never a guessed match, and it is never dropped.**
 *
 * Both alternatives are worse than they look. Matching on the listing's *name*
 * — "Villa Carmel Suite" against a unit called "סוויטה" — works for the first
 * fifty reservations and then puts a family in somebody else's bedroom;
 * nothing about that failure is visible until two parties arrive. Dropping the
 * reservation is quieter and worse still: the guest holds a confirmation from
 * Booking.com, ESTIA believes the unit is free, and the next direct booking
 * sells the same nights. So the reservation stops here, loudly, as a row a
 * person works — see `exceptions.ts`.
 *
 * ── The key is not the listing ────────────────────────────────────────────
 *
 * It is `(channelCode, externalListingId, externalVariantId)`. One Booking.com
 * listing routinely sells three room types, and a mapping keyed on the listing
 * alone collapses all three into one unit — which is a double booking that
 * looks like a working integration right up until the second room sells.
 *
 * ── Five shapes, all of them real ─────────────────────────────────────────
 *
 *   1. **One property, one listing.** A whole villa. One mapping, no variant.
 *   2. **One property, many units.** A guesthouse with four cabins listed
 *      separately. Four mappings, four listings, one property.
 *   3. **Listing variants.** One listing, three room types. Three mappings
 *      sharing an `externalListingId` and differing on `externalVariantId`.
 *   4. **Unmapped.** Discovered, deliberately or accidentally unmatched. A
 *      reservation for it is an exception.
 *   5. **Duplicate.** Two active mappings claiming the same key. Resolution
 *      refuses rather than picking one, because picking one is picking a
 *      bedroom by coin toss.
 */

import {
  CHANNEL_LABEL,
  type ChannelCode,
  type Listing,
  type ListingMapping,
} from './types'
import { draftException, type ChannelExceptionDraft } from './exceptions'

/* ------------------------------------------------------------------- key -- */

/**
 * The identity of a sellable thing on a channel.
 *
 * `null` and the empty string are not the same variant, so the absent variant
 * is spelled `-` rather than interpolated — `listing:` and `listing:` for a
 * whole-property listing and a variant literally named the empty string would
 * otherwise be one key.
 */
export interface ListingRef {
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
}

export function listingKey(ref: ListingRef): string {
  return `${ref.channelCode}|${ref.externalListingId}|${
    ref.externalVariantId ?? '-'
  }`
}

export function refOf(mapping: ListingMapping): ListingRef {
  return {
    channelCode: mapping.channelCode,
    externalListingId: mapping.externalListingId,
    externalVariantId: mapping.externalVariantId,
  }
}

export function refOfListing(listing: Listing): ListingRef {
  return {
    channelCode: listing.channelCode,
    externalListingId: listing.externalListingId,
    externalVariantId: listing.externalVariantId,
  }
}

/* -------------------------------------------------------------- resolving -- */

export type MappingResolution =
  | { kind: 'mapped'; mapping: ListingMapping }
  /** Nothing claims this listing. */
  | { kind: 'unmapped'; ref: ListingRef }
  /**
   * A mapping exists and is not live — drafted, validated but never
   * activated, or suspended. Distinct from `unmapped` because the fix is
   * different and much smaller: somebody already decided which unit this is.
   */
  | { kind: 'inactive'; mapping: ListingMapping }
  /** Two or more active mappings. Refused; see the header. */
  | { kind: 'ambiguous'; ref: ListingRef; mappings: readonly ListingMapping[] }

/**
 * Which unit does this listing mean?
 *
 * Only `active` mappings route a reservation. A `validated` mapping is a
 * decision that has been checked and not yet switched on, and honouring it
 * would make the activate step in the setup flow decorative — the whole point
 * of a preview-then-activate sequence is that nothing moves until somebody
 * presses the button.
 */
export function resolveListing(
  mappings: readonly ListingMapping[],
  ref: ListingRef,
): MappingResolution {
  const key = listingKey(ref)
  const matches = mappings.filter(
    (mapping) => listingKey(refOf(mapping)) === key,
  )

  const active = matches.filter((mapping) => mapping.state === 'active')

  if (active.length === 1) return { kind: 'mapped', mapping: active[0] }
  if (active.length > 1) return { kind: 'ambiguous', ref, mappings: active }
  if (matches.length > 0) return { kind: 'inactive', mapping: matches[0] }

  return { kind: 'unmapped', ref }
}

/**
 * Every listing this unit is sold through.
 *
 * The reverse direction, and it is what an outbound push iterates: a night
 * that becomes unavailable has to be closed on *all* of them, and a push that
 * walks one channel because that is the one the booking came from leaves the
 * other two selling it.
 */
export function listingsForUnit(
  mappings: readonly ListingMapping[],
  unitId: string,
): readonly ListingMapping[] {
  return mappings.filter(
    (mapping) => mapping.unitId === unitId && mapping.state === 'active',
  )
}

/* ------------------------------------------------------------- exceptions -- */

export interface UnmappedContext {
  organizationId: string
  connectorId: string | null
  occurredAt: Date
  externalReservationId?: string | null
  /** The listing's published name, when discovery has seen it. */
  listingName?: string | null
}

/**
 * The exception an unmapped listing produces.
 *
 * Keyed on the listing rather than on the reservation: a listing nobody has
 * mapped produces a reservation every time somebody books it, and forty rows
 * saying the same thing is an exception centre nobody opens.
 */
export function unmappedListingException(
  ref: ListingRef,
  context: UnmappedContext,
): ChannelExceptionDraft {
  const name = context.listingName
    ? `״${context.listingName}״`
    : ref.externalListingId

  return draftException('mapping_missing', {
    organizationId: context.organizationId,
    connectorId: context.connectorId,
    channelCode: ref.channelCode,
    occurredAt: context.occurredAt,
    subject: listingKey(ref),
    externalListingId: ref.externalListingId,
    externalReservationId: context.externalReservationId ?? null,
    detail:
      `הגיעה הזמנה מ-${CHANNEL_LABEL[ref.channelCode]} עבור המודעה ${name}, ` +
      'ואף יחידה במערכת אינה ממופה אליה. ההזמנה לא נוצרה ולא נזרקה — היא ' +
      'ממתינה כאן. עד שתמופה, התאריכים אינם חסומים אצלך.',
  })
}

export function ambiguousMappingException(
  ref: ListingRef,
  mappings: readonly ListingMapping[],
  context: UnmappedContext,
): ChannelExceptionDraft {
  return draftException('duplicate_mapping', {
    organizationId: context.organizationId,
    connectorId: context.connectorId,
    channelCode: ref.channelCode,
    occurredAt: context.occurredAt,
    subject: listingKey(ref),
    externalListingId: ref.externalListingId,
    externalReservationId: context.externalReservationId ?? null,
    detail:
      `${mappings.length} התאמות פעילות מצביעות על אותה מודעה ` +
      `(${ref.externalListingId}), וכל אחת מהן מובילה ליחידה אחרת. המערכת ` +
      'לא בחרה ביניהן — בחירה כזו היא הגרלה של חדר שינה. השהה את המיותרת.',
  })
}

export function inactiveMappingException(
  mapping: ListingMapping,
  context: UnmappedContext,
): ChannelExceptionDraft {
  return draftException('mapping_missing', {
    organizationId: context.organizationId,
    connectorId: context.connectorId,
    channelCode: mapping.channelCode,
    occurredAt: context.occurredAt,
    subject: listingKey(refOf(mapping)),
    externalListingId: mapping.externalListingId,
    externalReservationId: context.externalReservationId ?? null,
    unitId: mapping.unitId,
    propertyId: mapping.propertyId,
    detail:
      'קיימת התאמה למודעה הזו אך היא אינה פעילה (' +
      `${mapping.state}). ההזמנה לא נוצרה. הפעל את ההתאמה והרץ מחדש.`,
  })
}

/* ------------------------------------------------------------- validating -- */

/**
 * A match a person has made, before it is written.
 *
 * `mappedByUserId` is deliberately part of the draft: a mapping is a decision
 * somebody takes responsibility for, and a mapping with no author is one
 * nobody can be asked about six months later.
 */
export interface MappingDraft {
  channelCode: ChannelCode
  externalListingId: string
  externalVariantId: string | null
  propertyId: string
  unitId: string
}

/** What the validator needs to know about ESTIA's own side. */
export interface UnitFact {
  unitId: string
  propertyId: string
  name: string
  /** A unit with no availability rules row cannot be sold — see the engine. */
  sellable: boolean
}

export const MAPPING_PROBLEM_KINDS = [
  'unknown_unit',
  'unit_wrong_property',
  'unit_not_sellable',
  'unknown_listing',
  'listing_inactive',
  'duplicate_listing',
  'unit_already_listed',
] as const

export type MappingProblemKind = (typeof MAPPING_PROBLEM_KINDS)[number]

export interface MappingProblem {
  kind: MappingProblemKind
  /**
   * `true` stops activation. `false` is worth saying and worth activating
   * over — a unit sold through two listings on one channel is unusual and
   * legitimate, and refusing it would be this module inventing a business rule.
   */
  blocking: boolean
  message: string
}

export interface MappingValidation {
  ok: boolean
  problems: readonly MappingProblem[]
}

/**
 * Can this match be activated?
 *
 * Collects every problem rather than returning on the first, for the same
 * reason the availability engine does: a setup screen that reveals its
 * objections one at a time is a screen somebody walks through four times.
 */
export function validateMapping(args: {
  draft: MappingDraft
  units: readonly UnitFact[]
  listings: readonly Listing[]
  existing: readonly ListingMapping[]
}): MappingValidation {
  const { draft, units, listings, existing } = args
  const problems: MappingProblem[] = []

  const unit = units.find((candidate) => candidate.unitId === draft.unitId)
  if (!unit) {
    problems.push({
      kind: 'unknown_unit',
      blocking: true,
      message: 'היחידה שנבחרה אינה קיימת במערכת.',
    })
  } else {
    if (unit.propertyId !== draft.propertyId) {
      problems.push({
        kind: 'unit_wrong_property',
        blocking: true,
        message:
          'היחידה שייכת לנכס אחר מזה שנבחר. מיפוי חוצה־נכסים ישבור כל ' +
          'בדיקת הרשאה שמסתמכת על הנכס.',
      })
    }
    if (!unit.sellable) {
      problems.push({
        kind: 'unit_not_sellable',
        blocking: true,
        // The availability engine refuses a unit with no rules row — see its
        // `unknown_unit` blocker. Mapping a listing to it would produce a
        // channel that sells nights ESTIA will always refuse.
        message:
          `היחידה ״${unit.name}״ אינה מוגדרת למכירה, ולכן כל הזמנה שתגיע ` +
          'מהמודעה הזו תיחסם על ידי מנוע הזמינות.',
      })
    }
  }

  const ref: ListingRef = {
    channelCode: draft.channelCode,
    externalListingId: draft.externalListingId,
    externalVariantId: draft.externalVariantId,
  }
  const key = listingKey(ref)

  const listing = listings.find(
    (candidate) => listingKey(refOfListing(candidate)) === key,
  )
  if (!listing) {
    problems.push({
      kind: 'unknown_listing',
      blocking: true,
      message:
        'המודעה אינה מופיעה ברשימה שנמשכה מהערוץ. הרץ איתור מודעות מחדש.',
    })
  } else if (!listing.active) {
    problems.push({
      kind: 'listing_inactive',
      blocking: false,
      message:
        'המודעה אינה פעילה בערוץ כרגע. אפשר למפות אותה, אבל שום דבר לא יימכר ' +
        'דרכה עד שתופעל שם.',
    })
  }

  const claimants = existing.filter(
    (mapping) =>
      listingKey(refOf(mapping)) === key &&
      mapping.state !== 'suspended' &&
      mapping.unitId !== draft.unitId,
  )
  if (claimants.length > 0) {
    problems.push({
      kind: 'duplicate_listing',
      blocking: true,
      message:
        'מודעה זו כבר ממופה ליחידה אחרת. שתי התאמות לאותה מודעה הן הגרלה ' +
        'של חדר שינה בכל הזמנה שתיכנס.',
    })
  }

  const alsoListed = existing.filter(
    (mapping) =>
      mapping.unitId === draft.unitId &&
      mapping.channelCode === draft.channelCode &&
      mapping.state === 'active' &&
      listingKey(refOf(mapping)) !== key,
  )
  if (alsoListed.length > 0) {
    problems.push({
      kind: 'unit_already_listed',
      blocking: false,
      message:
        'היחידה כבר נמכרת דרך מודעה אחרת באותו ערוץ. זה אפשרי, אבל כל ' +
        'עדכון זמינות חייב לצאת לשתי המודעות.',
    })
  }

  return {
    ok: problems.every((problem) => !problem.blocking),
    problems,
  }
}

/* ------------------------------------------------------------ setup view -- */

export interface MappingPlanRow {
  listing: Listing
  mapping: ListingMapping | null
  /** More than one active mapping claims it. Rendered red, never auto-fixed. */
  ambiguous: boolean
}

export interface MappingPlan {
  rows: readonly MappingPlanRow[]
  /** Discovered listings nothing points at. The work the setup flow is for. */
  unmatched: readonly Listing[]
  /** Units nothing on this channel sells. Not an error — often deliberate. */
  unlistedUnits: readonly UnitFact[]
  /** True when every discovered listing has exactly one active mapping. */
  complete: boolean
}

/**
 * What the setup screen renders between "discover" and "activate".
 *
 * Both directions are reported, because both are decisions. A listing with no
 * unit is the dangerous one; a unit with no listing is usually deliberate — a
 * cabin the owner keeps for family — and calling it an error would train
 * people to ignore this screen.
 */
export function planMappings(args: {
  listings: readonly Listing[]
  mappings: readonly ListingMapping[]
  units: readonly UnitFact[]
}): MappingPlan {
  const { listings, mappings, units } = args

  const rows = listings.map((listing) => {
    const resolution = resolveListing(mappings, refOfListing(listing))
    switch (resolution.kind) {
      case 'mapped':
        return { listing, mapping: resolution.mapping, ambiguous: false }
      case 'inactive':
        return { listing, mapping: resolution.mapping, ambiguous: false }
      case 'ambiguous':
        return { listing, mapping: resolution.mappings[0], ambiguous: true }
      case 'unmapped':
        return { listing, mapping: null, ambiguous: false }
    }
  })

  const mappedUnitIds = new Set(
    mappings
      .filter((mapping) => mapping.state === 'active')
      .map((mapping) => mapping.unitId),
  )

  return {
    rows,
    unmatched: rows
      .filter((row) => row.mapping === null)
      .map((row) => row.listing),
    unlistedUnits: units.filter((unit) => !mappedUnitIds.has(unit.unitId)),
    complete:
      rows.length > 0 &&
      rows.every(
        (row) =>
          !row.ambiguous &&
          row.mapping !== null &&
          row.mapping.state === 'active',
      ),
  }
}
