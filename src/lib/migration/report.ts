/**
 * What happened, in numbers somebody can drill into.
 *
 * ── A count is not a report ───────────────────────────────────────────────
 *
 * "1,847 בוצע" is a number an operator has no way to check and therefore no
 * reason to believe. The question they actually ask, six months later when a
 * booking looks wrong, is "which row in my file became this" — and an import
 * that cannot answer it is an import nobody can audit.
 *
 * So every figure on this report is the length of a list, and every list holds
 * row numbers. `drillDown` is not a debugging affordance; it is the thing that
 * makes the summary trustworthy, because a total whose members can be listed is
 * a total somebody can verify against their own spreadsheet.
 *
 * ── Failures are shown by reason, not by count ────────────────────────────
 *
 * Forty failures with one cause is one problem and a two-minute fix. Forty
 * failures with forty causes is a bad file. Those are completely different
 * situations for the person reading the screen, and a single number tells them
 * nothing about which one they are in — so `failureGroups` groups by the
 * sentence, largest first.
 */

import {
  IMPORT_ENTITY_LABEL,
  RECORD_OUTCOME_LABEL,
  type CompletionReport,
  type DryRunReport,
  type EntityTally,
  type ImportEntity,
  type RecordOutcome,
  type RecordResult,
  type ValidationIssue,
} from './types'

/* ------------------------------------------------------------ drill-down -- */

/** The rows behind one number on the screen. */
export type DrillDown = {
  label: string
  rowNumbers: readonly number[]
}

/** Every row that ended in this outcome. */
export function drillDown(
  report: CompletionReport,
  outcome: RecordOutcome,
  entity?: ImportEntity,
): DrillDown {
  const rows = report.results
    .filter((result) => result.outcome === outcome)
    .filter((result) => entity === undefined || result.entity === entity)
    .map((result) => result.rowNumber)
    .sort((a, b) => a - b)

  return {
    label:
      entity === undefined
        ? RECORD_OUTCOME_LABEL[outcome]
        : `${RECORD_OUTCOME_LABEL[outcome]} · ${IMPORT_ENTITY_LABEL[entity]}`,
    rowNumbers: rows,
  }
}

/** One row's whole story, for the "what happened to row 412" question. */
export function traceRow(
  report: CompletionReport,
  rowNumber: number,
): {
  result: RecordResult | null
  issues: readonly ValidationIssue[]
  conflicts: readonly string[]
} {
  return {
    result:
      report.results.find((result) => result.rowNumber === rowNumber) ?? null,
    issues: report.issues.filter((issue) => issue.rowNumber === rowNumber),
    conflicts: report.conflicts
      .filter((conflict) => conflict.rowNumber === rowNumber)
      .map((conflict) => conflict.question),
  }
}

/* -------------------------------------------------------------- failures -- */

export type FailureGroup = {
  message: string
  rowNumbers: readonly number[]
}

/**
 * Failures grouped by what they say, largest group first.
 *
 * See the header: one cause forty times and forty causes once are different
 * problems, and a count of forty describes both.
 */
export function failureGroups(
  report: CompletionReport,
): readonly FailureGroup[] {
  const groups = new Map<string, number[]>()

  for (const result of report.results) {
    if (result.outcome !== 'failed') continue
    const message = result.message ?? 'סיבה לא ידועה'
    const rows = groups.get(message)
    if (rows) rows.push(result.rowNumber)
    else groups.set(message, [result.rowNumber])
  }

  return [...groups.entries()]
    .map(([message, rowNumbers]) => ({
      message,
      rowNumbers: rowNumbers.sort((a, b) => a - b),
    }))
    .sort((a, b) => b.rowNumbers.length - a.rowNumbers.length)
}

/* ------------------------------------------------------------- sentences -- */

/**
 * The one line at the top of the screen.
 *
 * Written as a sentence rather than assembled from labels because it is the
 * only part of the report most people read, and "1,812 הזמנות נוצרו, 31 דורשות
 * החלטה" is a different piece of information from four numbers in four boxes.
 */
export function summarise(report: CompletionReport): string {
  const created = count(report, 'created')
  const updated = count(report, 'updated')
  const unchanged = count(report, 'skipped_unchanged')
  const failed = count(report, 'failed')
  const manual = count(report, 'needs_manual_update')

  const parts: string[] = []
  if (created > 0) parts.push(`${created} רשומות נוצרו`)
  if (updated > 0) parts.push(`${updated} עודכנו`)
  if (unchanged > 0) parts.push(`${unchanged} כבר היו קיימות`)
  if (manual > 0) parts.push(`${manual} דורשות עדכון ידני`)
  if (failed > 0) parts.push(`${failed} נכשלו`)

  if (parts.length === 0) return 'לא נכתבה אף רשומה.'

  const suffix = report.interrupted
    ? ' הייבוא נעצר באמצע וניתן להמשיך אותו מהנקודה שבה עצר.'
    : ''

  return `${parts.join(', ')}.${suffix}`
}

/**
 * The promise about the guests' telephones, with its evidence.
 *
 * The single sentence an operator most needs before they will run this at all,
 * and it is stated as a fact with a number rather than as reassurance.
 */
export function suppressionSentence(report: CompletionReport): string {
  if (report.suppressedEvents.length === 0) {
    return 'הייבוא לא הפעיל אף תהליך אוטומטי.'
  }

  const names = [
    ...new Set(report.suppressedEvents.map((event) => event.name)),
  ].sort()

  return (
    `${report.suppressedEvents.length} אירועים אוטומטיים נחסמו ולא נשלחו ` +
    'לאף אורח ולא יצרו משימות: ' +
    `${names.join(', ')}. ` +
    'ייבוא היסטוריה לעולם אינו מפעיל הודעות, הכנות או משימות.'
  )
}

function count(report: CompletionReport, outcome: RecordOutcome): number {
  return report.results.filter((result) => result.outcome === outcome).length
}

/* -------------------------------------------------------------- dry run -- */

/**
 * The dry run's headline.
 *
 * Deliberately leads with what will *not* happen. A person about to move three
 * years of their business needs the refusals and the decisions before the
 * successes, because those are the only parts they can still act on.
 */
export function summariseDryRun(report: DryRunReport): string {
  const { totals } = report
  const undecided = report.conflicts.filter(
    (conflict) => conflict.decision === 'undecided',
  ).length

  const parts: string[] = []
  if (undecided > 0) parts.push(`${undecided} התנגשויות ממתינות להחלטה`)
  if (totals.invalid > 0) parts.push(`${totals.invalid} שורות לא ייובאו`)
  if (report.duplicates.length > 0) {
    parts.push(`${report.duplicates.length} אורחים שייתכן שכבר קיימים`)
  }
  if (totals.unchanged > 0) parts.push(`${totals.unchanged} כבר יובאו בעבר`)

  const writable = `${report.writable.length} רשומות ייכתבו`
  const historic =
    report.historicBookings > 0
      ? ` מהן ${report.historicBookings} שהויות שהסתיימו — הן לא ישלחו הודעה ולא ייצרו משימה`
      : ''

  if (parts.length === 0) return `${writable}.${historic}`
  return `${parts.join(', ')}. ${writable}.${historic}`
}

/** The per-entity table, ready to render. Order follows the catalogue. */
export function entityRows(
  report: DryRunReport,
): readonly (EntityTally & { label: string })[] {
  return report.byEntity.map((tally) => ({
    ...tally,
    label: IMPORT_ENTITY_LABEL[tally.entity],
  }))
}
