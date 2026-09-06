/**
 * The vocabulary of a migration.
 *
 * ── Why this capability is a sales capability ─────────────────────────────
 *
 * An Israeli villa operator with three years of stays in another PMS does not
 * evaluate ESTIA on its screens. They ask one question — "does my history come
 * with me" — and every answer except "yes" ends the conversation. So the
 * entities named here are not an admin convenience list: they are the shape of
 * a business that already exists somewhere else, and the closed vocabulary is
 * what stops an import inventing a category nobody can then report on.
 *
 * ── Closed, on purpose ────────────────────────────────────────────────────
 *
 * `ImportEntity`, `SourceFormat`, `IssueSeverity`, `ImportField` and
 * `ConflictKind` are all frozen tuples with a derived union type, exactly as
 * `BOOKING_STATUSES` and `DOMAIN_EVENTS` are. A string union invented at the
 * call site would let one parser emit `guest` and another `guests`, and the
 * screens would then have to know both.
 *
 * ── Everything here is plain data ─────────────────────────────────────────
 *
 * `PlainData` is not decoration. `dryrun.ts` proves at compile time that its
 * whole input satisfies it, which is what makes "the dry run cannot write"
 * a property of the signature rather than a claim about the body. A repository,
 * a Supabase client or an `Operation` added to any type in this file breaks
 * that proof in `dryrun.ts` at build time. Read the note there before widening
 * anything below to hold a function.
 */

/* ------------------------------------------------------------ plain data -- */

/**
 * A value that can only be looked at.
 *
 * `undefined` is a member because an optional property is `T | undefined`, and
 * excluding it would make every optional field fail the proof for a reason
 * that has nothing to do with writing.
 */
export type PlainData =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PlainData[]
  | { readonly [key: string]: PlainData }

/** Fails to compile when `T` is not `true`. Used to assert the shape above. */
export type Assert<T extends true> = T

/* -------------------------------------------------------------- entities -- */

/**
 * What a migration can carry.
 *
 * In dependency order, and that order is load-bearing: a booking names a unit,
 * a unit names a property, and importing them the other way round produces
 * three years of stays attached to nothing. `IMPORT_ENTITIES` is what
 * `apply.ts` iterates, so the order here is the order things are written.
 */
export const IMPORT_ENTITIES = [
  'organizations',
  'properties',
  'units',
  'guests',
  'bookings',
  'blocked_dates',
  'pricing',
  'owners',
  'agents',
  'notes',
] as const

export type ImportEntity = (typeof IMPORT_ENTITIES)[number]

export const IMPORT_ENTITY_LABEL: Readonly<Record<ImportEntity, string>> = {
  organizations: 'ארגונים',
  properties: 'נכסים',
  units: 'יחידות',
  guests: 'אורחים',
  bookings: 'הזמנות',
  blocked_dates: 'תאריכים חסומים',
  pricing: 'תמחור',
  owners: 'בעלים',
  agents: 'סוכנים',
  notes: 'הערות',
}

/* --------------------------------------------------------------- formats -- */

/**
 * What the file turned out to be.
 *
 * `unknown` is a first-class member rather than an error, because the honest
 * answer to an unrecognised file is "I do not know what this is", and a
 * detector that guessed would parse a PDF as a one-column CSV and report four
 * hundred invalid rows.
 *
 * `excel_binary` is separate from `excel`: an `.xlsx` is a zip archive, this
 * product carries no zip reader, and pretending otherwise would refuse a
 * customer's file with a parse error instead of the one sentence that actually
 * unblocks them — save it as CSV.
 */
export const SOURCE_FORMATS = [
  'csv',
  'tsv',
  'excel',
  'excel_binary',
  'ical',
  'unknown',
] as const

export type SourceFormat = (typeof SOURCE_FORMATS)[number]

export const SOURCE_FORMAT_LABEL: Readonly<Record<SourceFormat, string>> = {
  csv: 'CSV',
  tsv: 'טבלה מופרדת בטאבים',
  excel: 'גיליון שיוצא מאקסל',
  excel_binary: 'קובץ אקסל בינארי',
  ical: 'יומן iCal',
  unknown: 'לא זוהה',
}

/* -------------------------------------------------------------- severity -- */

/**
 * How much a finding costs.
 *
 * Three, and the middle one is the one that matters. `error` refuses the
 * record. `warning` imports it and says what was assumed — a booking with no
 * telephone number is still a booking, and refusing it would lose the stay to
 * protect a field. `info` is a fact worth showing and no decision at all.
 */
export const ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const

export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

export const ISSUE_SEVERITY_LABEL: Readonly<Record<IssueSeverity, string>> = {
  error: 'שגיאה',
  warning: 'אזהרה',
  info: 'לידיעה',
}

/* ---------------------------------------------------------------- fields -- */

/**
 * Every field a source column can be mapped onto.
 *
 * One flat list rather than one per entity, because a real export has a
 * `Phone` column that is a guest's on the guest sheet and an agent's on the
 * agent sheet, and two vocabularies would make that one name into two.
 * `ENTITY_FIELDS` below is what narrows the list for a given sheet.
 */
export const IMPORT_FIELDS = [
  // Shared identity
  'externalId',
  'fullName',
  'phone',
  'email',
  'city',
  'notes',
  // Organization
  'legalName',
  'taxId',
  // Property
  'propertyName',
  'slug',
  'propertyType',
  'checkInTime',
  'checkOutTime',
  'minNights',
  'taxRatePercent',
  'description',
  // Unit
  'unitName',
  'unitCode',
  'capacity',
  'bedrooms',
  // Guest
  'language',
  'nationality',
  'tags',
  'marketingConsent',
  // Booking
  'guestName',
  'guestPhone',
  'guestEmail',
  'checkIn',
  'checkOut',
  'guestCount',
  'adults',
  'children',
  'infants',
  'status',
  'source',
  'totalAgorot',
  'depositAgorot',
  // Blocked dates and pricing
  'fromDate',
  'toDate',
  'reason',
  'nightlyAgorot',
  // Owners and agents
  'sharePercent',
  'agencyName',
  'commissionPercent',
  // Notes
  'subject',
  'body',
  'author',
  'createdAt',
] as const

export type ImportField = (typeof IMPORT_FIELDS)[number]

/** Which fields belong on which sheet. Anything else is refused as unknown. */
export const ENTITY_FIELDS: Readonly<
  Record<ImportEntity, readonly ImportField[]>
> = {
  organizations: ['externalId', 'fullName', 'legalName', 'taxId', 'phone',
    'email', 'city'],
  properties: ['externalId', 'propertyName', 'slug', 'propertyType', 'city',
    'description', 'checkInTime', 'checkOutTime', 'minNights',
    'taxRatePercent'],
  units: ['externalId', 'propertyName', 'unitName', 'unitCode', 'capacity',
    'bedrooms', 'nightlyAgorot', 'notes'],
  guests: ['externalId', 'fullName', 'phone', 'email', 'language',
    'nationality', 'city', 'tags', 'notes', 'marketingConsent'],
  bookings: ['externalId', 'propertyName', 'unitName', 'guestName',
    'guestPhone', 'guestEmail', 'checkIn', 'checkOut', 'guestCount', 'adults',
    'children', 'infants', 'status', 'source', 'totalAgorot', 'depositAgorot',
    'notes'],
  blocked_dates: ['externalId', 'propertyName', 'unitName', 'fromDate',
    'toDate', 'reason', 'notes'],
  pricing: ['externalId', 'propertyName', 'unitName', 'fromDate', 'toDate',
    'nightlyAgorot', 'minNights'],
  owners: ['externalId', 'fullName', 'phone', 'email', 'propertyName',
    'sharePercent', 'notes'],
  agents: ['externalId', 'fullName', 'phone', 'email', 'agencyName',
    'commissionPercent', 'notes'],
  notes: ['externalId', 'subject', 'body', 'author', 'createdAt',
    'propertyName', 'guestName'],
}

/* ------------------------------------------------------------- the rows -- */

/**
 * One record as the parser produced it, before anything is understood.
 *
 * `cells` is keyed by the source's own column name — never by an ESTIA field —
 * because mapping happens later and a parser that mapped as it read would make
 * a saved mapping impossible to apply to a second file.
 */
export type SourceRow = {
  /** 1-based and counting the header, so it matches the operator's editor. */
  rowNumber: number
  cells: Readonly<Record<string, string>>
}

export interface ParsedFile {
  format: SourceFormat
  /** The source's own header, in the order it appeared. */
  columns: readonly string[]
  rows: readonly SourceRow[]
  /** Refusals from the parse itself. Never an exception. */
  issues: readonly ValidationIssue[]
}

/* --------------------------------------------------------------- mapping -- */

/** One source column, and the ESTIA field it feeds. `null` is "ignore it". */
export interface FieldMapping {
  column: string
  field: ImportField | null
}

/**
 * A mapping somebody already made, kept so they never make it twice.
 *
 * `signature` is a digest of the normalised header row. The second export out
 * of the same PMS has the same header, so the same signature, so the mapping
 * is offered automatically — which is the whole point: a monthly top-up import
 * that demands the same twenty-four decisions every month is an import nobody
 * runs twice.
 */
export interface SavedMapping {
  id: string
  organizationId: string
  name: string
  entity: ImportEntity
  sourceFormat: SourceFormat
  signature: string
  mappings: readonly FieldMapping[]
}

/* --------------------------------------------------------------- records -- */

export type OrganizationValues = {
  externalId: string | null
  name: string
  legalName: string | null
  taxId: string | null
  phone: string | null
  email: string | null
  city: string | null
}

export type PropertyValues = {
  externalId: string | null
  name: string
  slug: string
  propertyType: string
  city: string | null
  description: string | null
  checkInTime: string
  checkOutTime: string
  minNights: number
  taxRatePercent: number
}

export type UnitValues = {
  externalId: string | null
  propertyName: string | null
  name: string
  code: string | null
  capacity: number | null
  bedrooms: number | null
  nightlyAgorot: number | null
  notes: string | null
}

export type GuestValues = {
  externalId: string | null
  fullName: string
  /** Normalised to E.164 by `validate.ts`, or `null`. Never as typed. */
  phone: string | null
  email: string | null
  language: string
  nationality: string | null
  city: string | null
  tags: readonly string[]
  notes: string | null
  marketingConsent: boolean
}

export type BookingValues = {
  externalId: string | null
  propertyName: string | null
  unitName: string
  guestName: string
  guestPhone: string | null
  guestEmail: string | null
  /** `YYYY-MM-DD`. Inclusive first night. */
  checkIn: string
  /** `YYYY-MM-DD`. Exclusive — the next guest may arrive on it. */
  checkOut: string
  guestCount: number
  adults: number | null
  children: number | null
  infants: number | null
  status: string | null
  source: string | null
  totalAgorot: number | null
  depositAgorot: number | null
  notes: string | null
}

export type BlockedDateValues = {
  externalId: string | null
  propertyName: string | null
  unitName: string
  fromDate: string
  toDate: string
  reason: string | null
  notes: string | null
}

export type PricingValues = {
  externalId: string | null
  propertyName: string | null
  unitName: string
  fromDate: string
  toDate: string
  nightlyAgorot: number
  minNights: number | null
}

export type PartyValues = {
  externalId: string | null
  fullName: string
  phone: string | null
  email: string | null
  propertyName: string | null
  agencyName: string | null
  /** Owner share or agent commission, whole percent. */
  percent: number | null
  notes: string | null
}

export type NoteValues = {
  externalId: string | null
  subject: string | null
  body: string
  author: string | null
  createdAt: string | null
  propertyName: string | null
  guestName: string | null
}

/** The record, narrowed by its entity. Closed: no `unknown` payload anywhere. */
export type ImportValues =
  | { entity: 'organizations'; organization: OrganizationValues }
  | { entity: 'properties'; property: PropertyValues }
  | { entity: 'units'; unit: UnitValues }
  | { entity: 'guests'; guest: GuestValues }
  | { entity: 'bookings'; booking: BookingValues }
  | { entity: 'blocked_dates'; block: BlockedDateValues }
  | { entity: 'pricing'; pricing: PricingValues }
  | { entity: 'owners'; owner: PartyValues }
  | { entity: 'agents'; agent: PartyValues }
  | { entity: 'notes'; note: NoteValues }

/**
 * One understood record, ready to be judged.
 *
 * `sourceId` and `contentHash` are both here and both matter. A source that
 * gives its own identifier — Airbnb's `HMABCD1234`, a PMS export's
 * `reservation_id` — gives the strongest possible idempotency key: a
 * *corrected* file re-exported next week carries the same id with a different
 * body, and that is an update rather than a second booking. A source that gives
 * none leaves only the body, and then a corrected row is genuinely
 * indistinguishable from a new one. Keeping both fields is what lets
 * `idempotency.ts` say which of the two situations it is in instead of
 * guessing.
 */
export type ImportRecord = {
  rowNumber: number
  entity: ImportEntity
  sourceId: string | null
  contentHash: string
  values: ImportValues
}

/* ---------------------------------------------------------------- issues -- */

export const ISSUE_CODES = [
  'unknown_format',
  'binary_spreadsheet',
  'empty_file',
  'no_header',
  'unknown_column',
  'unmapped_required_field',
  'missing_required',
  'not_a_number',
  'negative_number',
  'not_a_date',
  /**
   * The file offered no value that settles day-first from month-first.
   *
   * Its own code rather than a `not_a_date`, because nothing is wrong with any
   * row: an operator sent hunting for the bad date a `not_a_date` names would
   * find none. What is reported is an assumption the whole file was read under,
   * and it is reported precisely so it can be overruled in one click.
   */
  'date_order_assumed',
  'range_reversed',
  'phone_unreadable',
  'email_malformed',
  'unknown_enum',
  'too_long',
  'unit_not_found',
  'property_not_found',
  'entity_not_importable',
  'duplicate_in_file',
] as const

export type IssueCode = (typeof ISSUE_CODES)[number]

/**
 * One thing wrong with one row, in a sentence a person can act on.
 *
 * `message` is Hebrew and names the value as they typed it. "שורה 412 אינה
 * תקינה" is the failure mode this type exists to make impossible: the operator
 * opens their spreadsheet, looks at row 412, sees nothing obviously wrong, and
 * stops migrating. Every issue therefore carries the row, the column, the
 * offending text and what to do about it.
 */
export type ValidationIssue = {
  rowNumber: number
  entity: ImportEntity
  severity: IssueSeverity
  code: IssueCode
  /** The ESTIA field, when the problem is about one. */
  field: ImportField | null
  /** The source column, so the operator can find it in their own file. */
  column: string | null
  /** The text as it appeared. Never normalised — they have to recognise it. */
  value: string | null
  message: string
}

/* ------------------------------------------------------------- conflicts -- */

export const CONFLICT_KINDS = [
  'booking_overlaps_booking',
  'booking_overlaps_import',
  'booking_overlaps_owner_stay',
  'booking_overlaps_maintenance',
  'unit_mismatch',
  'guest_merge_candidate',
] as const

export type ConflictKind = (typeof CONFLICT_KINDS)[number]

export const CONFLICT_KIND_LABEL: Readonly<Record<ConflictKind, string>> = {
  booking_overlaps_booking: 'חפיפה עם הזמנה קיימת',
  booking_overlaps_import: 'חפיפה בין שתי שורות בקובץ',
  booking_overlaps_owner_stay: 'חפיפה עם שהות בעלים',
  booking_overlaps_maintenance: 'חפיפה עם חסימת תחזוקה',
  unit_mismatch: 'היחידה אינה מוכרת',
  guest_merge_candidate: 'ייתכן שזה אותו אורח',
}

/** What a person is choosing between. Never chosen for them — see below. */
export const CONFLICT_DECISIONS = [
  'undecided',
  'keep_existing',
  'import_anyway',
  'skip_record',
  'merge',
] as const

export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number]

/** One side of a conflict, described well enough to choose without leaving. */
export type ConflictSide = {
  /** `import` or `estia`. Which world this side lives in. */
  origin: 'import' | 'estia'
  /** The row number in the file, or the ESTIA record id. */
  reference: string
  label: string
  /** Hebrew, one line. Dates, guest, and whatever else decides it. */
  detail: string
}

/**
 * A decision a person owes, never a record quietly dropped.
 *
 * Nothing in this module discards a record because it collided. Three years of
 * bookings contain genuine double-entries, cancelled-then-rebooked stays and
 * one villa sold twice on a Friday in 2023, and every one of those is a fact
 * about the operator's business that they — not this code — have to settle. A
 * silent drop makes the import *look* cleaner and makes the migration wrong in
 * a way nobody discovers until a guest arrives.
 */
export type Conflict = {
  id: string
  kind: ConflictKind
  rowNumber: number
  entity: ImportEntity
  left: ConflictSide
  right: ConflictSide
  /** Hebrew. What the operator is actually being asked. */
  question: string
  decision: ConflictDecision
}

/* ------------------------------------------------------------ duplicates -- */

/**
 * Two records this module believes are one thing.
 *
 * Offered, never applied. `dedupe.ts` explains at length why a merge is close
 * to unrecoverable and why this type therefore carries a `matchedOn` rather
 * than a confidence score: a person deciding whether to weld two stay
 * histories together needs to know it was the telephone number, not that the
 * machine felt 0.87 sure.
 */
export type DuplicateCandidate = {
  rowNumber: number
  entity: ImportEntity
  /** `phone` or `email`. Never a name — see `dedupe.ts`. */
  matchedOn: 'phone' | 'email'
  /** The normalised value that matched. */
  matchedValue: string
  existingId: string
  existingLabel: string
  incomingLabel: string
}

/* ---------------------------------------------------------------- report -- */

/** Counts for one entity, so the summary is never a single total. */
export type EntityTally = {
  entity: ImportEntity
  valid: number
  invalid: number
  warnings: number
  duplicates: number
  conflicts: number
  /** Already imported by a previous run of this same session. */
  unchanged: number
}

/**
 * What the import would do, computed without doing any of it.
 *
 * The screen's most prominent state, because it is the screen that earns an
 * operator's trust: a person about to move three years of their business into
 * a product they have used for twenty minutes needs to read what will happen
 * before it happens, in their own numbers.
 */
export interface DryRunReport {
  /** ISO date the run was computed against. Injected, never read from a clock. */
  computedOn: string
  totals: EntityTally
  byEntity: readonly EntityTally[]
  issues: readonly ValidationIssue[]
  duplicates: readonly DuplicateCandidate[]
  conflicts: readonly Conflict[]
  /** Rows that would be written, in dependency order. */
  writable: readonly ImportRecord[]
  /**
   * Rows this build cannot write because no domain command exists for their
   * entity. Named rather than counted as invalid: the file is fine and the
   * product is not finished, and telling an operator their data is wrong when
   * it is not is how a migration stalls.
   */
  unsupported: readonly ImportRecord[]
  /** How many records fall entirely in the past. See `apply.ts`. */
  historicBookings: number
  /** True when nothing at all would be written. */
  empty: boolean
}

/* ------------------------------------------------------------- the session -- */

export const IMPORT_SESSION_STATUSES = [
  'draft',
  'mapped',
  'validated',
  'dry_run',
  'applying',
  'completed',
  'failed',
  'cancelled',
] as const

export type ImportSessionStatus = (typeof IMPORT_SESSION_STATUSES)[number]

export const IMPORT_SESSION_STATUS_LABEL: Readonly<
  Record<ImportSessionStatus, string>
> = {
  draft: 'טיוטה',
  mapped: 'מיפוי הושלם',
  validated: 'נבדק',
  dry_run: 'הרצה יבשה',
  applying: 'בייבוא',
  completed: 'הושלם',
  failed: 'נכשל',
  cancelled: 'בוטל',
}

/**
 * The unit of work an operator can leave and come back to.
 *
 * A three-year migration is not one request. The file is uploaded, the mapping
 * argued about, the dry run read by somebody else in the business, the
 * conflicts settled over two days, and only then is anything written. Every one
 * of those steps has to survive closing the laptop, which is why the session is
 * a row and not component state.
 */
export interface ImportSession {
  id: string
  organizationId: string
  status: ImportSessionStatus
  entity: ImportEntity
  sourceFormat: SourceFormat
  fileName: string
  /** Digest of the file's bytes. Identical file, identical digest. */
  fileHash: string
  rowCount: number
  mappings: readonly FieldMapping[]
  createdAt: string
  createdByUserId: string
  updatedAt: string
  /** Set once `apply.ts` finishes, so a report survives the session. */
  completedAt: string | null
}

/* ------------------------------------------------------- completion report -- */

export const RECORD_OUTCOMES = [
  'created',
  'updated',
  'skipped_unchanged',
  'skipped_by_decision',
  /**
   * Imported before, changed at the source since, and this build has no update
   * command for its entity.
   *
   * Its own outcome rather than a failure, because nothing failed and nothing
   * is wrong with the file: the record is in ESTIA, it is out of date, and the
   * import refused to create a second one. Calling it `failed` would send an
   * operator hunting for a problem in their data that is not there.
   */
  'needs_manual_update',
  'failed',
] as const

export type RecordOutcome = (typeof RECORD_OUTCOMES)[number]

export const RECORD_OUTCOME_LABEL: Readonly<Record<RecordOutcome, string>> = {
  created: 'נוצר',
  updated: 'עודכן',
  skipped_unchanged: 'כבר קיים',
  skipped_by_decision: 'דולג בהחלטת אדם',
  needs_manual_update: 'דורש עדכון ידני',
  failed: 'נכשל',
}

/**
 * What happened to one source row, traceable back to it.
 *
 * `rowNumber` is on every outcome including the successes, because "which of
 * my 1,847 rows became this booking" is the question asked six months later
 * when something looks wrong, and an import that cannot answer it is an import
 * nobody can audit.
 */
export interface RecordResult {
  rowNumber: number
  entity: ImportEntity
  outcome: RecordOutcome
  /** The ESTIA id, when one was created. */
  createdId: string | null
  /** Hebrew, and only when something needs saying. */
  message: string | null
}

export interface CompletionReport {
  sessionId: string
  startedAt: string
  finishedAt: string
  /** True when the run stopped early and can be resumed. */
  interrupted: boolean
  results: readonly RecordResult[]
  byEntity: readonly EntityTally[]
  issues: readonly ValidationIssue[]
  conflicts: readonly Conflict[]
  /**
   * Domain events the import produced and deliberately did not deliver.
   *
   * Shown rather than hidden. "Nothing was sent to your guests" is a promise,
   * and a promise with a list under it is the only kind an operator can check.
   */
  suppressedEvents: readonly SuppressedEvent[]
}

export interface SuppressedEvent {
  name: string
  rowNumber: number
  reason: string
}
