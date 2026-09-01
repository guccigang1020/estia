/**
 * Which configuration is actually in force, and the profile lookup beside it.
 *
 * ── One row wins, whole ───────────────────────────────────────────────────
 *
 * An organization has a default and a property may override it. The tempting
 * design is a per-column fallback: take `mode` from the property if it set one,
 * otherwise the organization, and the same for the other six values. It reads
 * beautifully in a specification.
 *
 * It produces a screen nobody can debug. A manager looking at a property in
 * `external` mode with the organization's turnaround and the property's
 * dispatch mode cannot answer "where is this coming from", and the support
 * conversation that follows has no good ending. So `resolveSettings` picks ONE
 * row and reports which — `source` is `'property'` or `'organization'` — and
 * the screen says so out loud.
 *
 * The cost is real and worth stating: a property that wants only a different
 * turnaround has to restate the other six values. That is a worse afternoon
 * for whoever configures it and a better year for whoever runs it.
 *
 * ── The default when there is no row at all ───────────────────────────────
 *
 * `off`. Not `simple`, and this is the load-bearing default in the module: an
 * organization that has never opened this section has no laundry operation,
 * preparation works completely without one, and defaulting to anything else
 * would put a section in the menu of every customer in the product.
 */

import type { LaundryItemProfile, LaundrySettings } from './types'

/**
 * The configuration in force, with its provenance.
 *
 * `source` of `'default'` means no row exists and the module is off — which is
 * a different sentence from "somebody chose off", and a settings screen should
 * say the different sentence.
 */
export interface ResolvedSettings {
  settings: LaundrySettings
  source: 'property' | 'organization' | 'default'
}

/**
 * The configuration for an organization that has none.
 *
 * Every value here is inert. The mode is `off`, the day lists are empty, and
 * the two numbers that must be positive are the smallest positive value rather
 * than a guess at a sensible one — a fabricated 24-hour turnaround shown to
 * somebody who has configured nothing is the product asserting a fact about
 * their supplier.
 */
export function defaultSettings(organizationId: string): LaundrySettings {
  return {
    organizationId,
    propertyId: null,
    mode: 'off',
    dispatchMode: 'approval_required',
    defaultChannel: 'whatsapp',
    defaultProviderId: null,
    turnaroundHours: 1,
    pickupDays: [],
    deliveryDays: [],
    forecastHorizonDays: 1,
    standingNotes: null,
  }
}

/**
 * Pick the row in force for one property.
 *
 * `propertyId` of `null` asks for the organization-wide answer, which is what
 * a consolidated view across several properties needs.
 */
export function resolveSettings(
  organizationId: string,
  rows: readonly LaundrySettings[],
  propertyId: string | null,
): ResolvedSettings {
  const mine = rows.filter((row) => row.organizationId === organizationId)

  if (propertyId !== null) {
    const override = mine.find((row) => row.propertyId === propertyId)
    if (override) return { settings: override, source: 'property' }
  }

  const organization = mine.find((row) => row.propertyId === null)
  if (organization) return { settings: organization, source: 'organization' }

  return { settings: defaultSettings(organizationId), source: 'default' }
}

/**
 * Are two properties running the same operation.
 *
 * Consolidation asks this before it puts two properties in one run: a house on
 * `internal` and a house on `external` do not share a van, and a run that
 * mixed them would be sent to a provider carrying items nobody meant to send
 * out. Compared on the fields that decide where the linen physically goes,
 * not on the whole record — a different `standingNotes` is not a reason to
 * send two vans.
 */
export function sharesOperation(
  a: LaundrySettings,
  b: LaundrySettings,
): boolean {
  return a.mode === b.mode && a.defaultProviderId === b.defaultProviderId
}

// ── Item profiles ─────────────────────────────────────────────────────────

/** Profiles by `itemId`, for the engine's per-requirement lookup. */
export function profileIndex(
  profiles: readonly LaundryItemProfile[],
): ReadonlyMap<string, LaundryItemProfile> {
  return new Map(profiles.map((profile) => [profile.itemId, profile]))
}

/**
 * The items this organization actually washes.
 *
 * Used by the configuration screen to answer "what is laundry here", and by
 * the forecast, which must not walk every catalogue item on every booking.
 */
export function laundryManagedItems(
  profiles: readonly LaundryItemProfile[],
): readonly LaundryItemProfile[] {
  return profiles.filter(
    (profile) => profile.laundryManaged && profile.washable,
  )
}

/**
 * The turnaround that applies to one item, most specific first.
 *
 * Item, then provider, then the organization's own. A duvet takes longer than
 * a hand towel and every provider knows it, so the item's own figure wins when
 * it has one — and `null` at every level means the settings' value, which is
 * NOT NULL in the schema and therefore always an answer.
 */
export function turnaroundFor(
  profile: LaundryItemProfile,
  providerHours: number | null,
  settingsHours: number,
): number {
  return profile.turnaroundHours ?? providerHours ?? settingsHours
}
