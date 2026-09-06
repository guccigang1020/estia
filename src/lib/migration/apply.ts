/**
 * The import itself.
 *
 * ── Three properties, and they are the whole file ─────────────────────────
 *
 * **Every write goes through a domain command.** `ImportCommands` is the only
 * thing in scope that can write, and it exposes three creates and two updates.
 * There is no client here, no repository, no table name. See `commands.ts` for
 * why that matters more in a migration than anywhere else: rows inserted around
 * the domain are rows no invariant ever saw, and they sit quietly until the day
 * somebody amends one.
 *
 * **No live side effects.** The commands were built with an `EventQuarantine`,
 * enforced by the type of `defineImportCommands`'s options. Nothing this loop
 * does can deliver a `booking.created` to a subscriber, whatever the dates on
 * the stay. Read `quarantine.ts`.
 *
 * **Interrupted is not lost.** Progress is reported after every batch and the
 * results carry row numbers, so a run that stops — a closed laptop, a dropped
 * connection, a deploy — resumes from the row after the last one confirmed
 * rather than starting again. And because every write carries an idempotency
 * key derived from the record rather than from the session, even the rows in
 * the batch that was in flight when it stopped are *replayed* rather than
 * repeated. The resume is an optimisation on top of a guarantee, not the
 * guarantee itself.
 *
 * ── Why the loop is sequential ────────────────────────────────────────────
 *
 * Twenty concurrent writes would be faster and would be wrong here. The
 * occupancy exclusion constraint makes two overlapping bookings a race whose
 * loser fails at commit; running the file in order means the loser is the later
 * row in the operator's own file, which is a result they can reason about. In
 * parallel it is whichever connection got there first, and re-running the same
 * file would refuse a different row each time.
 */

import {
  findUnit,
  type ExistingCalendar,
  type ExistingUnit,
} from './conflicts'
import type { CommandContext, ImportCommands, ResolvedUnit } from './commands'
import { isHistoric } from './dryrun'
import {
  classify,
  indexLedger,
  ledgerEntryFor,
  type LedgerEntry,
} from './idempotency'
import type { EventQuarantine } from './quarantine'
import type {
  CompletionReport,
  ImportRecord,
  RecordOutcome,
  RecordResult,
} from './types'

/* ------------------------------------------------------------- progress -- */

/**
 * What has been done so far.
 *
 * Persisted by the caller after each batch — `repository.ts` writes it — so it
 * is deliberately small and serialisable. The ledger entries are in here rather
 * than written separately because a result and its ledger row have to become
 * durable together: a created booking with no ledger row would be imported
 * twice by the next run.
 */
export type ApplyProgress = {
  results: readonly RecordResult[]
  ledger: readonly LedgerEntry[]
}

export type ApplyArgs = {
  sessionId: string
  /** The dry run's `writable`, in dependency order. */
  records: readonly ImportRecord[]
  commands: ImportCommands
  quarantine: EventQuarantine
  /** For resolving a unit name to an id. The same snapshot the dry run used. */
  calendar: ExistingCalendar
  /** What has already been imported, from previous sessions. */
  ledger: readonly LedgerEntry[]
  /** What this session already did, when resuming. */
  resumeFrom?: ApplyProgress
  context: Omit<CommandContext, 'historic'>
  /** ISO date the run is judged against, for deciding what is history. */
  today: string
  startedAt: string
  batchSize?: number
  /**
   * Persist progress. Called after every batch, and awaited: a batch that is
   * reported as done before its progress is durable is a batch that is
   * repeated after a crash.
   */
  onProgress?: (progress: ApplyProgress) => Promise<void>
  /** Checked between records. A person pressing stop is not a failure. */
  shouldStop?: () => boolean
}

/** Small enough that an interruption costs little, large enough to be quiet. */
const DEFAULT_BATCH_SIZE = 25

/**
 * Write the import.
 *
 * Never throws for a bad record: one row's failure is that row's `failed`
 * result with a Hebrew message, and the loop continues. An import that stops on
 * row nineteen makes a person fix nineteen, re-run, and discover twenty-three —
 * the same argument `inventory/import.ts` makes, three orders of magnitude more
 * expensive here.
 */
export async function applyImport(args: ApplyArgs): Promise<CompletionReport> {
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE
  const done = new Set(
    (args.resumeFrom?.results ?? []).map((result) => result.rowNumber),
  )

  const results: RecordResult[] = [...(args.resumeFrom?.results ?? [])]
  const written: LedgerEntry[] = [...(args.resumeFrom?.ledger ?? [])]

  // Grown as the loop runs, not computed once. A three-year export routinely
  // holds the same guest once per stay, and a ledger snapshotted before the
  // first write would let the second occurrence through — six guest cards for
  // one family, which is the exact failure this module exists to avoid rather
  // than to reproduce faithfully.
  const ledgerIndex = new Map(
    indexLedger([...args.ledger, ...written]).entries(),
  )

  let interrupted = false
  let sinceLastReport = 0

  for (const record of args.records) {
    if (done.has(record.rowNumber)) continue

    if (args.shouldStop?.() === true) {
      interrupted = true
      break
    }

    // Attribution before the write, so a suppressed event on the report points
    // at a row in the operator's own file.
    args.quarantine.attributeTo(record.rowNumber)

    const outcome = await writeOne(record, args, ledgerIndex)
    results.push(outcome.result)
    if (outcome.ledger !== null) {
      written.push(outcome.ledger)
      ledgerIndex.set(
        `${outcome.ledger.entity} ${outcome.ledger.recordKey}`,
        outcome.ledger,
      )
    }

    sinceLastReport += 1
    if (sinceLastReport >= batchSize) {
      sinceLastReport = 0
      await args.onProgress?.({ results: [...results], ledger: [...written] })
    }
  }

  if (sinceLastReport > 0 || interrupted) {
    await args.onProgress?.({ results: [...results], ledger: [...written] })
  }

  return {
    sessionId: args.sessionId,
    startedAt: args.startedAt,
    finishedAt: args.context.now.toISOString(),
    interrupted,
    results,
    byEntity: tallyResults(results),
    issues: [],
    conflicts: [],
    suppressedEvents: args.quarantine.suppressed,
  }
}

/* ------------------------------------------------------------ one record -- */

async function writeOne(
  record: ImportRecord,
  args: ApplyArgs,
  ledger: ReadonlyMap<string, LedgerEntry>,
): Promise<{ result: RecordResult; ledger: LedgerEntry | null }> {
  const { state, existing } = classify(record, ledger)

  if (state === 'unchanged') {
    return {
      result: {
        rowNumber: record.rowNumber,
        entity: record.entity,
        outcome: 'skipped_unchanged',
        createdId: existing?.estiaId ?? null,
        message: 'הרשומה כבר יובאה בעבר ולא השתנתה מאז.',
      },
      ledger: null,
    }
  }

  const historic = isHistoric(record, args.today)
  const context: CommandContext = { ...args.context, historic }

  try {
    if (state === 'corrected') {
      return await writeCorrection(record, args, context, existing)
    }
    return await writeCreation(record, args, context)
  } catch (error) {
    return {
      result: {
        rowNumber: record.rowNumber,
        entity: record.entity,
        outcome: 'failed',
        createdId: null,
        message: explain(error),
      },
      ledger: null,
    }
  }
}

async function writeCreation(
  record: ImportRecord,
  args: ApplyArgs,
  context: CommandContext,
): Promise<{ result: RecordResult; ledger: LedgerEntry | null }> {
  switch (record.values.entity) {
    case 'properties': {
      const written = await args.commands.createProperty(record, context)
      return landed(record, args, written.id, written.replayed)
    }
    case 'guests': {
      const written = await args.commands.createGuest(record, context)
      return landed(record, args, written.id, written.replayed)
    }
    case 'bookings': {
      const unit = resolveUnit(record, args.calendar)
      if (unit === null) {
        return {
          result: {
            rowNumber: record.rowNumber,
            entity: record.entity,
            outcome: 'failed',
            createdId: null,
            message:
              `היחידה ״${record.values.booking.unitName}״ אינה קיימת ב-ESTIA, ` +
              'ולכן לא ניתן לשייך אליה את ההזמנה. צור את היחידה או מפה אותה ' +
              'ליחידה קיימת, והרץ את הקובץ שוב.',
          },
          ledger: null,
        }
      }
      const written = await args.commands.createBooking(record, context, unit)
      return landed(record, args, written.id, written.replayed)
    }
    // Deliberately not written. `dryrun.ts` separates these into `unsupported`
    // and says so on the preview, so reaching here means a caller passed the
    // wrong list — refused rather than written around the domain.
    default:
      return {
        result: {
          rowNumber: record.rowNumber,
          entity: record.entity,
          outcome: 'failed',
          createdId: null,
          message:
            'לגוף הזה עדיין אין פעולת יצירה במוצר, ולכן הייבוא אינו כותב אותו.',
        },
        ledger: null,
      }
  }
}

/**
 * A record the source has corrected since it was imported.
 *
 * Routed to an update command where one exists and reported as needing a person
 * where one does not. Never written as a second record: a corrected booking
 * imported again is two stays on the calendar, which is the failure the ledger
 * exists to prevent and would be a strange way to fail it.
 */
async function writeCorrection(
  record: ImportRecord,
  args: ApplyArgs,
  context: CommandContext,
  existing: LedgerEntry | null,
): Promise<{ result: RecordResult; ledger: LedgerEntry | null }> {
  if (existing === null) return writeCreation(record, args, context)

  const update =
    record.values.entity === 'guests'
      ? args.commands.updateGuest
      : record.values.entity === 'bookings'
        ? args.commands.updateBooking
        : undefined

  if (update === undefined) {
    return {
      result: {
        rowNumber: record.rowNumber,
        entity: record.entity,
        outcome: 'needs_manual_update',
        createdId: existing.estiaId,
        message:
          'הרשומה יובאה בעבר והשתנתה מאז במערכת המקור. עדכון אוטומטי עדיין ' +
          'אינו נתמך לגוף הזה, ולכן לא נוצרה כפילות — פתח את הרשומה הקיימת ' +
          'ועדכן אותה ידנית.',
      },
      ledger: null,
    }
  }

  const written = await update(record, existing.estiaId, context)
  return {
    result: {
      rowNumber: record.rowNumber,
      entity: record.entity,
      outcome: 'updated',
      createdId: written.id,
      message: null,
    },
    ledger: ledgerEntryFor(record, {
      estiaId: written.id,
      sessionId: args.sessionId,
    }),
  }
}

function landed(
  record: ImportRecord,
  args: ApplyArgs,
  id: string,
  replayed: boolean,
): { result: RecordResult; ledger: LedgerEntry | null } {
  const outcome: RecordOutcome = replayed ? 'skipped_unchanged' : 'created'

  return {
    result: {
      rowNumber: record.rowNumber,
      entity: record.entity,
      outcome,
      createdId: id,
      message: replayed
        ? 'הרשומה כבר נכתבה בעבר עם אותו מפתח, והפעולה לא בוצעה פעמיים.'
        : null,
    },
    // Written even on a replay. A replay means the row exists in ESTIA and is
    // missing from *this* ledger — a restored backup, or a second person
    // importing the same file — and not recording it would leave the next run
    // relying on the pipeline's key again instead of answering from the ledger.
    ledger: ledgerEntryFor(record, {
      estiaId: id,
      sessionId: args.sessionId,
    }),
  }
}

function resolveUnit(
  record: ImportRecord,
  calendar: ExistingCalendar,
): ResolvedUnit | null {
  if (record.values.entity !== 'bookings') return null
  const booking = record.values.booking

  const unit: ExistingUnit | null = findUnit(
    calendar.units,
    booking.unitName,
    booking.propertyName,
  )
  if (unit === null) return null
  return { id: unit.id, propertyId: unit.propertyId }
}

/**
 * A failure, as a sentence rather than a stack.
 *
 * `userMessage` is preferred where the domain supplied one — every `AppError`
 * in this codebase carries a Hebrew sentence written for the person who caused
 * the failure, and replacing it with a generic line here would throw away the
 * most useful part of the error.
 */
function explain(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as { userMessage?: unknown; message?: unknown }
    if (typeof record.userMessage === 'string') return record.userMessage
    if (typeof record.message === 'string') return record.message
  }
  return 'הייבוא של השורה נכשל מסיבה שאינה ידועה. נסה שוב.'
}

/* --------------------------------------------------------------- tallies -- */

function tallyResults(
  results: readonly RecordResult[],
): CompletionReport['byEntity'] {
  const entities = [...new Set(results.map((result) => result.entity))]

  return entities.map((entity) => {
    const rows = results.filter((result) => result.entity === entity)
    return {
      entity,
      valid: rows.filter(
        (row) => row.outcome === 'created' || row.outcome === 'updated',
      ).length,
      invalid: rows.filter((row) => row.outcome === 'failed').length,
      warnings: rows.filter((row) => row.outcome === 'needs_manual_update')
        .length,
      duplicates: 0,
      conflicts: rows.filter((row) => row.outcome === 'skipped_by_decision')
        .length,
      unchanged: rows.filter((row) => row.outcome === 'skipped_unchanged')
        .length,
    }
  })
}
