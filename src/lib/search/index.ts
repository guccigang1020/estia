/**
 * Search, in one import.
 *
 * Entirely pure — classification and the permission gate — so a Client
 * Component may import it. The reads live beside the screen in
 * `src/app/(app)/search/_lib/queries.ts`, because they take a Supabase client
 * and a module a browser bundle can reach must not.
 */

export {
  MIN_QUERY_LENGTH,
  SEARCH_KINDS,
  likePattern,
  parseQuery,
  type ParsedQuery,
  type QueryShape,
  type SearchKind,
} from './query'

export {
  GRANT_FOR_KIND,
  KIND_LABEL,
  planSearch,
  type SearchPlan,
} from './access'
