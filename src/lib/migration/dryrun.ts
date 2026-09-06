/**
 * What the import would do, computed without doing any of it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRY RUN CANNOT WRITE, AND THAT IS A PROPERTY OF THE SIGNATURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A reviewer must be able to establish that by reading the first ten lines of
 * `dryRun` and nothing else. If they have to read the body, the signature is
 * wrong. Three things make it true, and each is checkable without trust:
 *
 *   1. **It takes no writer.** No repository, no client, no `Operation`, no
 *      callback. There is nothing in scope that could perform a write, so the
 *      body cannot contain one however it is edited later.
 *
 *   2. **It is synchronous.** It returns `DryRunReport`, not
 *      `Promise<DryRunReport>`. Every write path in this codebase is
 *      asynchronous — `defineOperation.run`, every repository method, every
 *      PostgREST call — so a function that cannot `await` cannot reach any of
 *      them. Making it async later would be a visible change to the signature
 *      and would fail review on that alone.
 *
 *   3. **Its whole input is plain data, proven by the compiler.** The
 *      `PLAIN_DATA_PROOF` block below is a type-level assertion that
 *      `DryRunInput` contains no function anywhere in its shape. Adding a
 *      repository, a client or a callback to any type it reaches breaks the
 *      build *in this file*, with a message pointing at the assertion. It is
 *      not a comment asking people to be careful; it is a test that runs on
 *      every `tsc`.
 *
 * The clock is the fourth thing and is passed in for the same family of
 * reasons: `computedOn` is an ISO date the caller supplies, so the report is
 * deterministic and two runs of the same file produce byte-identical output.
 * A `new Date()` here would make the dry run untestable at exactly the boundary
 * — a stay that is historic today and current tomorrow — where its answer
 * matters most.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * This is the screen that earns the migration. A person is about to move three
 * years of their business into a product they have used for twenty minutes, and
 * the only thing that makes that reasonable is reading, in their own numbers,
 * exactly what is about to happen: how many stays, how many guests, which rows
 * will not come, which look like people who are already here, and which
 * collisions they personally have to settle first.
 */

import { rangesOverlap } from '../booking/types'
import {
  applicableRows,
  detectConflicts,
  skippedRows,
  undecidedRows,
  type ExistingCalendar,
} from './conflicts'
import { findDuplicateGuests, type ExistingGuest } from './dedupe'
import { planAgainstLedger, type LedgerEntry } from './idempotency'
import {
  IMPORT_ENTITIES,
  type Assert,
  type Conflict,
  type DryRunReport,
  type DuplicateCandidate,
  type EntityTally,
  type ImportEntity,
  type ImportRecord,
  type PlainData,
  type ValidationIssue,
} from './types'

/* ------------------------------------------------------------ the world -- */

/**
 * Everything already in ESTIA that the dry run compares against.
 *
 * A **snapshot**, loaded by the caller and handed over as data. Not a
 * repository, not a query function, not a lazy loader. That is the point: a
 * port would be a callable in scope, and a callable in scope is a thing a
 * future edit can write through.
 */
export type ExistingWorld = {
  guests: readonly ExistingGuest[]
  calendar: ExistingCalendar
  /** What this organization has already imported. See `idempotency.ts`. */
  ledger: readonly LedgerEntry[]
}

/**
 * Which entities this build can actually write.
 *
 * Not a configuration knob — the honest list of entities that have a domain
 * command behind them today. `apply.ts` refuses everything else rather than
 * writing to a table directly, and the dry run says so in advance so that an
 * operator finds out on the preview screen and not after pressing the button.
 */
export const SUPPORTED_ENTITIES: readonly ImportEntity[] = [
  'properties',
  'guests',
  'bookings',
]

export type DryRunInput = {
  records: readonly ImportRecord[]
  world: ExistingWorld
  /** ISO date. Injected — see the header on why there is no clock in here. */
  computedOn: string
  /** Decisions a person has already made. Empty on the first pass. */
  decisions: readonly Conflict[]
  /** Issues the parse and the validation already found. */
  issues: readonly ValidationIssue[]
  /** Does the source verify the addresses it exports? See `dedupe.ts`. */
  emailIsVerified?: boolean
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PLAIN_DATA_PROOF
 *
 * The compiler checking that nothing which can write is reachable from the dry
 * run's input. If somebody adds a repository to `ExistingWorld`, a client to
 * `ExistingCalendar` or a callback to `ImportRecord`, this line stops
 * compiling and names the assertion.
 *
 * `Assert<T extends true>` is in `types.ts`. `false` does not extend `true`,
 * so a violation is a build error rather than a warning nobody reads.
 * ═══════════════════════════════════════════════════════════════════════════ */
type PLAIN_DATA_PROOF = Assert<DryRunInput extends PlainData ? true : false>

/** Referenced so the assertion is not removed as an unused type. */
export type DryRunInputIsPlainData = PLAIN_DATA_PROOF

/* -------------------------------------------------------------- the run -- */

/**
 * The report.
 *
 * Synchronous, writer-free, deterministic. Read the signature; there is no
 * second thing to check.
 */
export function dryRun(input: DryRunInput): DryRunReport {
  const { records, world, computedOn, decisions, issues, emailIsVerified } =
    input

  // Rows a person has already settled against importing are excluded from
  // conflict detection, so settling one collision does not leave the rows
  // behind it still colliding with something that is no longer coming.
  const alreadySkipped = [...skippedRows(decisions)]

  const detected = detectConflicts(records, world.calendar, {
    skippedRows: alreadySkipped,
  })

  // Decisions already made are carried onto the freshly detected conflicts by
  // id. Re-detecting throws away a person's afternoon otherwise: they settle
  // forty conflicts, change one field mapping, and are asked all forty again.
  const decided = new Map(
    decisions.map((conflict) => [conflict.id, conflict.decision]),
  )
  const conflicts: readonly Conflict[] = detected.map((conflict) => {
    const decision = decided.get(conflict.id)
    return decision === undefined ? conflict : { ...conflict, decision }
  })

  const duplicates = findDuplicateGuests(records, world.guests, {
    emailIsVerified,
  })

  const ledgerPlan = planAgainstLedger(records, world.ledger)
  const unchangedRows = new Set(
    ledgerPlan.unchanged.map((record) => record.rowNumber),
  )

  // Three filters, in this order, and the order is the argument. A row that a
  // person decided to skip is not counted as unchanged; a row already imported
  // is not offered as writable; a row whose entity has no domain command is
  // separated from the ones that do rather than being called invalid.
  const settled = applicableRows(records, conflicts)
  const notYetImported = settled.filter(
    (record) => !unchangedRows.has(record.rowNumber),
  )

  const supported = new Set(SUPPORTED_ENTITIES)
  const writable = notYetImported.filter((record) =>
    supported.has(record.entity),
  )
  const unsupported = notYetImported.filter(
    (record) => !supported.has(record.entity),
  )

  const allIssues = [
    ...issues,
    ...unsupportedIssues(unsupported),
    ...identityIssue(records, ledgerPlan.withoutStableIdentity),
  ]

  const byEntity = tally({
    records,
    issues: allIssues,
    duplicates,
    conflicts,
    unchangedRows,
  })

  return {
    computedOn,
    totals: totalOf(byEntity),
    byEntity,
    issues: allIssues,
    duplicates,
    conflicts,
    writable,
    unsupported,
    historicBookings: countHistoric(writable, computedOn),
    empty: writable.length === 0,
  }
}

/* --------------------------------------------------------------- pieces -- */

/**
 * A stay that is entirely in the past.
 *
 * `checkOut <= computedOn` and not `checkIn < computedOn`: a guest who arrived
 * last week and leaves tomorrow is *in the building*, and importing them as
 * history would put a live occupancy on the calendar with none of the
 * preparation a live stay needs. The boundary is compared as ISO strings, which
 * sort correctly and carry no time zone — the same reasoning
 * `booking/dates.ts` applies to a property-local day.
 */
export function isHistoric(record: ImportRecord, computedOn: string): boolean {
  if (record.values.entity !== 'bookings') return false
  return record.values.booking.checkOut <= computedOn
}

/** A stay that spans today. Neither history nor a future arrival. */
export function isInHouse(record: ImportRecord, computedOn: string): boolean {
  if (record.values.entity !== 'bookings') return false
  const booking = record.values.booking
  return rangesOverlap(
    { checkIn: booking.checkIn, checkOut: booking.checkOut },
    { checkIn: computedOn, checkOut: nextDay(computedOn) },
  )
}

function nextDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function countHistoric(
  records: readonly ImportRecord[],
  computedOn: string,
): number {
  return records.filter((record) => isHistoric(record, computedOn)).length
}

/**
 * One issue per unsupported record, saying which capability is missing.
 *
 * Named rather than counted. "עשרים ושתיים שורות לא יובאו" tells an operator
 * their file is bad; "ייבוא בעלים עדיין אינו נתמך" tells them the product is
 * not finished, which is the truth and is something they can plan around.
 */
function unsupportedIssues(
  records: readonly ImportRecord[],
): readonly ValidationIssue[] {
  return records.map((record) => ({
    rowNumber: record.rowNumber,
    entity: record.entity,
    severity: 'warning' as const,
    code: 'entity_not_importable' as const,
    field: null,
    column: null,
    value: null,
    message:
      'לגוף הזה עדיין אין פעולת יצירה במוצר, ולכן הייבוא אינו כותב אותו. ' +
      'השורה נקראה ונבדקה במלואה, וכשהפעולה תתווסף אפשר יהיה להריץ את ' +
      'אותו קובץ שוב — הוא לא ייצור כפילות.',
  }))
}

/**
 * The warning about a source that exports no identifiers.
 *
 * One issue for the file rather than one per row, because it is a fact about
 * the export and not about any particular booking, and eighteen hundred copies
 * of it would bury everything else on the screen.
 */
function identityIssue(
  records: readonly ImportRecord[],
  withoutStableIdentity: number,
): readonly ValidationIssue[] {
  if (withoutStableIdentity === 0 || records.length === 0) return []
  const entity = records[0]?.entity
  if (entity === undefined) return []

  return [
    {
      rowNumber: 0,
      entity,
      severity: 'info',
      code: 'unmapped_required_field',
      field: 'externalId',
      column: null,
      value: null,
      message:
        `ל-${withoutStableIdentity} שורות אין מזהה מהמערכת הקודמת, ולכן הן ` +
        'מזוהות לפי תוכנן. הרצה חוזרת של אותו קובץ לא תכפיל אותן, אבל שורה ' +
        'שתתוקן במקור תיראה כשורה חדשה. אם יש בייצוא עמודת מזהה — מפה אותה ' +
        'בשלב המיפוי.',
    },
  ]
}

/* -------------------------------------------------------------- tallies -- */

function tally(args: {
  records: readonly ImportRecord[]
  issues: readonly ValidationIssue[]
  duplicates: readonly DuplicateCandidate[]
  conflicts: readonly Conflict[]
  unchangedRows: ReadonlySet<number>
}): readonly EntityTally[] {
  const present = IMPORT_ENTITIES.filter((entity) =>
    args.records.some((record) => record.entity === entity),
  )

  // An entity with no records but with issues still appears: a file where every
  // row failed to parse has no records at all, and a report with no line for it
  // would show an operator nothing but a blank screen.
  const withIssues = IMPORT_ENTITIES.filter(
    (entity) =>
      !present.includes(entity) &&
      args.issues.some((issue) => issue.entity === entity),
  )

  const blockedByConflict = new Set([
    ...skippedRows(args.conflicts),
    ...undecidedRows(args.conflicts),
  ])

  return [...present, ...withIssues].map((entity) => {
    const rows = args.records.filter((record) => record.entity === entity)
    const issues = args.issues.filter((issue) => issue.entity === entity)
    const failedRows = new Set(
      issues
        .filter((issue) => issue.severity === 'error' && issue.rowNumber > 0)
        .map((issue) => issue.rowNumber),
    )

    const unchanged = rows.filter((record) =>
      args.unchangedRows.has(record.rowNumber),
    ).length

    return {
      entity,
      valid: rows.filter(
        (record) =>
          !args.unchangedRows.has(record.rowNumber) &&
          !blockedByConflict.has(record.rowNumber),
      ).length,
      invalid: failedRows.size,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
      duplicates: args.duplicates.filter(
        (duplicate) => duplicate.entity === entity,
      ).length,
      conflicts: args.conflicts.filter((conflict) => conflict.entity === entity)
        .length,
      unchanged,
    }
  })
}

function totalOf(tallies: readonly EntityTally[]): EntityTally {
  return tallies.reduce<EntityTally>(
    (sum, entry) => ({
      entity: sum.entity,
      valid: sum.valid + entry.valid,
      invalid: sum.invalid + entry.invalid,
      warnings: sum.warnings + entry.warnings,
      duplicates: sum.duplicates + entry.duplicates,
      conflicts: sum.conflicts + entry.conflicts,
      unchanged: sum.unchanged + entry.unchanged,
    }),
    {
      // The total row carries the first entity in the catalogue as a
      // placeholder; every screen reads it as "the whole file" and never as a
      // statement about organizations.
      entity: 'organizations',
      valid: 0,
      invalid: 0,
      warnings: 0,
      duplicates: 0,
      conflicts: 0,
      unchanged: 0,
    },
  )
}
