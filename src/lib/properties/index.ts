/**
 * The property domain, in one import.
 *
 * Creation only. Editing a property is still done nowhere and belongs here
 * when it is done — with `requiresVersion`, because two managers editing the
 * same address is exactly the case optimistic locking exists for.
 */

export {
  PropertyNotReadableError,
  PropertySlugTakenError,
  definePropertyOperations,
  type CreatedProperty,
  type PropertyCreationOperation,
  type PropertyDraft,
  type PropertyOperations,
} from './operations'

export {
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  type PropertyStatus,
  type PropertyType,
} from './types'
