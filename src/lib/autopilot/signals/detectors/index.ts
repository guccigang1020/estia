/**
 * The nine detectors, and the one rule they all obey.
 *
 * Every one is a pure function from already-fetched facts to `Signal[]`. None
 * of them fetches anything, none imports a Supabase client, and none knows the
 * organization's Autopilot level or who would be told. A detector that asked
 * those questions would be a detector nobody could test, and the answers
 * belong to `decide` and `policy` — which are separate stages precisely so
 * that "why did ESTIA do this" has one answer rather than four.
 */

export { detectAccess, type AccessFacts } from './access'
export { detectCleaning, type CleaningFacts } from './cleaning'
export { detectContract, type ContractFacts } from './contract'
export { detectInventory, type ShortageFacts } from './inventory'
export { detectLaundry, type LaundryFacts } from './laundry'
export { detectMaintenance, type MaintenanceFacts } from './maintenance'
export { detectOpportunity, type EmptyNightFacts } from './opportunity'
export {
  detectPayment,
  type OutstandingRequirement,
  type PaymentFacts,
} from './payment'
export {
  detectPreparation,
  type AdditionalItem,
  type PreparationFacts,
} from './preparation'
