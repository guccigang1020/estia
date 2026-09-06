/**
 * The migration module, in one import.
 *
 * ── Read before importing this from a Client Component ────────────────────
 *
 * Do not. `commands.ts` and `repository.ts` reach the persistence layer and
 * through it the `postgres` driver, so a `'use client'` file that touches this
 * barrel takes the whole application down with `Can't resolve 'fs'` — the
 * failure `scripts/client-bundle.mjs` exists to catch and which the header of
 * that script describes at length.
 *
 * The browser side of this feature imports leaves instead: `./types` for the
 * vocabulary, `./parsers` for reading a file, `./mapping`, `./validate`,
 * `./dryrun`, `./conflicts`, `./dedupe` and `./report`. Every one of those is
 * pure and free of the database by construction, which is not an accident —
 * it is why the dry run runs in the browser before anything is uploaded.
 */

export {
  applyImport,
  type ApplyArgs,
  type ApplyProgress,
} from './apply'

export {
  UnsupportedImportEntityError,
  defineImportCommands,
  type CommandContext,
  type ImportCommandBundle,
  type ImportCommands,
  type ResolvedUnit,
  type WriteOutcome,
} from './commands'

export {
  applicableRows,
  decide,
  detectConflicts,
  findUnit,
  normalizeUnitName,
  skippedRows,
  undecidedRows,
  type ExistingBlock,
  type ExistingBooking,
  type ExistingCalendar,
  type ExistingUnit,
} from './conflicts'

export {
  findDuplicateGuests,
  groupDuplicatesInFile,
  identityOf,
  isSharedMailbox,
  normalizeEmail,
  type DedupeOptions,
  type ExistingGuest,
  type IdentityKeys,
} from './dedupe'

export {
  SUPPORTED_ENTITIES,
  dryRun,
  isHistoric,
  isInHouse,
  type DryRunInput,
  type ExistingWorld,
} from './dryrun'

export {
  RECORD_STATES,
  RECORD_STATE_LABEL,
  classify,
  hasStableIdentity,
  indexLedger,
  ledgerEntryFor,
  operationIdempotencyKey,
  planAgainstLedger,
  recordKey,
  type IdempotencyPlan,
  type LedgerEntry,
  type RecordState,
} from './idempotency'

export {
  ALL_IMPORT_FIELDS,
  IMPORT_FIELD_LABEL,
  applySavedMapping,
  fieldForHeader,
  fieldsFor,
  findSavedMapping,
  headerSignature,
  mappedValues,
  normalizeHeader,
  suggestMappings,
  toSavedMapping,
} from './mapping'

export {
  detectFormat,
  parseDelimitedFile,
  parseIcal,
  parseSource,
  parseSpreadsheet,
} from './parsers'

export { EventQuarantine } from './quarantine'

export {
  SupabaseMigrationRepository,
  isRecordOutcome,
  type ImportedRecordRow,
  type MigrationRepository,
  type SessionDraft,
  type SessionPatch,
} from './repository'

export {
  drillDown,
  entityRows,
  failureGroups,
  summarise,
  summariseDryRun,
  suppressionSentence,
  traceRow,
  type DrillDown,
  type FailureGroup,
} from './report'

export * from './types'

export {
  DATE_ORDERS,
  DATE_ORDER_LABEL,
  inferDateOrder,
  isTruthy,
  slugFrom,
  toAgorot,
  toCount,
  toIsoDate,
  validateRows,
  type DateOrder,
  type ValidateOptions,
  type ValidationResult,
} from './validate'
