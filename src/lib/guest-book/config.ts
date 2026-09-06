/**
 * Which fields this organization requires, and whether it keeps a register at
 * all.
 *
 * ══ OFF BY DEFAULT, AND OFF IS COMPLETE ════════════════════════════════════
 *
 * `DEFAULT_GUEST_BOOK_CONFIG.enabled` is `false`. A business that does not keep
 * a register gets no entries, no empty screen implying a setup step was
 * skipped, and no field on any other screen that exists only to feed this one.
 * The register is a capability some businesses need; it is not a stage of
 * onboarding.
 *
 * ══ WHY THE DEFAULT REQUIRED SET IS WHAT IT IS ═════════════════════════════
 *
 * Six fields: the booking reference, the property, the guest's name, arrival,
 * departure and how many people. They are required not because anything says
 * they must be, but because a register that omits any one of them cannot
 * answer the question a register is for — who was here, and when. An entry
 * with no arrival date is not a lenient entry; it is not an entry.
 *
 * Address, financial document and notes are **optional by default**, and that
 * is the deliberate half of the decision. This module has not verified what
 * any particular business must record (see `types.ts`), and the conservative
 * response to not knowing is to collect less and let an operator who does know
 * turn the field on — not to demand a guest's home address from every
 * guesthouse in the country on an engineer's assumption. Requiring data
 * nobody has established a need for is its own harm.
 *
 * ══ IT APPLIES WHERE IT APPLIES ════════════════════════════════════════════
 *
 * `propertyIds` empty means every property. A business running a hotel and a
 * campsite may keep a register for one and not the other, and a capability that
 * could only be organization-wide would force the register onto a property it
 * does not belong to — which the brief names explicitly.
 */

import { GUEST_BOOK_FIELDS, type GuestBookField } from './types'

/**
 * Fields an operator cannot switch off.
 *
 * Not a legal floor and not presented as one: these are the fields the record
 * is *made of*. `generation.ts` cannot produce an entry without them because it
 * reads them off the booking, and a configuration that made the arrival date
 * optional would describe a row the code cannot build.
 */
export const STRUCTURAL_FIELDS: readonly GuestBookField[] = [
  'booking_reference',
  'property',
  'arrival',
]

/** Fields an operator may require or not. Everything that is not structural. */
export const CONFIGURABLE_FIELDS: readonly GuestBookField[] =
  GUEST_BOOK_FIELDS.filter((field) => !STRUCTURAL_FIELDS.includes(field))

export interface GuestBookConfig {
  organizationId: string
  /** The capability. `false` until an operator turns it on. */
  enabled: boolean
  /** Empty means every property in the organization. */
  propertyIds: readonly string[]
  /** A subset of `GUEST_BOOK_FIELDS`. Structural fields are always in force. */
  requiredFields: readonly GuestBookField[]
  /**
   * When an operator last confirmed they had checked what their own business
   * must record.
   *
   * Recorded because this product cannot answer that question for them, and a
   * register configured by whoever clicked through onboarding fastest is worth
   * knowing about. `null` is an honest and common value; the screen says so
   * rather than treating it as an error.
   */
  fieldsReviewedAt: Date | null
  fieldsReviewedByUserId: string | null
  updatedAt: Date | null
}

/**
 * What an organization that has never configured anything has.
 *
 * A whole value rather than a set of nullable columns, so every caller reads
 * the same defaults and none of them invents its own.
 */
export function defaultGuestBookConfig(
  organizationId: string,
): GuestBookConfig {
  return {
    organizationId,
    enabled: false,
    propertyIds: [],
    requiredFields: [
      'booking_reference',
      'property',
      'primary_guest_name',
      'arrival',
      'departure',
      'guest_count',
    ],
    fieldsReviewedAt: null,
    fieldsReviewedByUserId: null,
    updatedAt: null,
  }
}

/**
 * Is the register kept for this property?
 *
 * Both halves, in one function, because a caller that checked `enabled` and
 * forgot `propertyIds` would write entries for a property the operator
 * excluded — and the entry would look identical to a legitimate one.
 */
export function isGuestBookEnabledFor(
  config: GuestBookConfig,
  propertyId: string,
): boolean {
  if (!config.enabled) return false
  if (config.propertyIds.length === 0) return true
  return config.propertyIds.includes(propertyId)
}

/**
 * Is this field required?
 *
 * Structural fields answer `true` whatever the configuration says. Everything
 * else is exactly what the operator chose.
 */
export function requiresField(
  config: GuestBookConfig,
  field: GuestBookField,
): boolean {
  if (STRUCTURAL_FIELDS.includes(field)) return true
  return config.requiredFields.includes(field)
}

/**
 * The stated configuration, with the structural fields folded in.
 *
 * For the screen, which should show a person the whole truth about what their
 * register demands rather than the part of it that happens to be stored.
 */
export function effectiveRequiredFields(
  config: GuestBookConfig,
): readonly GuestBookField[] {
  return GUEST_BOOK_FIELDS.filter((field) => requiresField(config, field))
}

/**
 * A configuration change, refused when it is not expressible.
 *
 * Returns the rejected field names rather than throwing: this is called from a
 * form, and "you cannot make the arrival date optional" is a sentence beside a
 * checkbox, not an exception.
 */
export function rejectedFieldChoices(
  fields: readonly string[],
): readonly string[] {
  const known: readonly string[] = GUEST_BOOK_FIELDS
  return fields.filter((field) => !known.includes(field))
}
