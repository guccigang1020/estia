/**
 * Leads, and joining two guest rows that are one person.
 *
 * The pure half — the state machine, the match score, the merge rules — has no
 * database in it and is tested against handmade values. The operations are the
 * only path that writes, and the two merge operations do not write at all:
 * they call the SECURITY DEFINER functions in
 * `supabase/migrations/0074_leads_and_guest_merges.sql`, whose header is where
 * the reasoning for all of this lives.
 */

export {
  LEAD_LOST_REASONS,
  LEAD_LOST_REASON_LABEL,
  LEAD_SOURCES,
  LEAD_SOURCE_LABEL,
  LEAD_STATUSES,
  LEAD_STATUS_LABEL,
  OPEN_LEAD_STATUSES,
  type Lead,
  type LeadLostReason,
  type LeadSource,
  type LeadStatus,
} from './types'

export {
  ALL_STATUS_PAIRS,
  canTransition,
  isOpen,
  nextStatuses,
  problemsWith,
  type TransitionProblem,
  type TransitionRequest,
} from './transitions'

export {
  MATCH_WEIGHTS,
  MERGE_SUGGESTION_THRESHOLD,
  POSSIBLE_MATCH_THRESHOLD,
  attachmentFor,
  jaroWinkler,
  normaliseName,
  scoreMatch,
  suggestsMerge,
  worthMentioning,
  type Attachment,
  type MatchScore,
  type MatchableGuest,
  type MatchableLead,
} from './matching'

export {
  MERGE_CHOOSEABLE_FIELDS,
  MERGE_FIELD_LABEL,
  MERGE_NEVER_COPIED_FIELDS,
  MERGE_REASON_MIN,
  MERGE_RULED_FIELDS,
  MERGE_UNDO_WINDOW_DAYS,
  conflictsBetween,
  problemsWithMerge,
  sanitiseChoices,
  undoAvailability,
  type MergeChoices,
  type MergeConflict,
  type MergeField,
  type MergeRecord,
  type MergeSide,
  type MergeableGuest,
  type UndoAvailability,
} from './merge'

export { KNOWN_MERGE_TOKENS, asMergeFailure } from './errors'

export {
  defineLeadOperations,
  type Assignment,
  type LeadDraft,
  type LeadOperations,
  type LeadSnapshot,
  type MergeInput,
  type MergeTargets,
  type StatusChange,
} from './operations'
