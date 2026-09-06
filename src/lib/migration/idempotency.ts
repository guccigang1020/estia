/**
 * Running the same file twice must not double the business.
 *
 * ── The failure this closes ───────────────────────────────────────────────
 *
 * An import of eighteen hundred bookings takes minutes. The operator's laptop
 * sleeps, the tab is closed, the connection drops on hotel wifi, or the file
 * comes back next week with four corrected rows. Every one of those ends with a
 * person pressing the button again, and the only acceptable outcomes are
 * "nothing happened" and "the four corrections landed". "Three thousand six
 * hundred bookings" is not on the list, and it is what happens by default.
 *
 * ── Two layers, and the second one holds when the first is lost ───────────
 *
 * **The ledger.** One row per imported source record, keyed by what the source
 * called it. It is what makes a second run classify every row as `unchanged`
 * before anything is written, and it is what the dry run reads to say so out
 * loud on the screen.
 *
 * **The service pipeline's own idempotency store.** Every write carries a key
 * derived here, so even with the ledger gone — a restored backup, a session
 * deleted, a second organization admin importing the same file from their own
 * laptop — the second write of an identical record is *replayed* by
 * `src/lib/service/idempotency.ts` rather than performed. The key is derived
 * from the record and never from the session, which is the whole reason that
 * second layer works across sessions at all.
 *
 * ── Why the key is the source's id *and* the content digest ───────────────
 *
 * They answer different questions and the import needs both.
 *
 * The *identity* is `sourceId` where the source gave one — Airbnb's
 * `HMABCD1234`, a PMS export's `reservation_id`. That is what makes a corrected
 * re-export recognisable as the same booking rather than a new one.
 *
 * The *content digest* is what makes an identical re-run recognisable as
 * identical. It is included in the operation key, so a corrected record reaches
 * the write path instead of being replayed with its old body — a replay would
 * silently discard the correction and report success, which is the quietest
 * possible way to lose a fix.
 *
 * A source that gives no id has only the digest, and then a genuinely
 * corrected row is indistinguishable from a new one. That is a property of the
 * source and not something this module can reason its way out of, so it is
 * *reported* — `classify` returns `new` and the dry run says how many records
 * have no stable identifier, which is the sentence that makes an operator go
 * and find the id column in their export.
 */

import { fingerprint } from '../service/idempotency'
import type { ImportEntity, ImportRecord } from './types'

/**
 * One record this organization has already imported.
 *
 * Plain data, because the dry run reads it and proves at compile time that its
 * whole input holds no functions.
 */
export type LedgerEntry = {
  entity: ImportEntity
  /** `sourceId` where the source gave one, otherwise the content digest. */
  recordKey: string
  /** The digest of the record as it was when it was imported. */
  contentHash: string
  /** What it became in ESTIA. */
  estiaId: string
  /** Which session wrote it, so a report can be reopened. */
  sessionId: string
  rowNumber: number
}

/** How a record relates to what has already been imported. */
export const RECORD_STATES = ['new', 'unchanged', 'corrected'] as const
export type RecordState = (typeof RECORD_STATES)[number]

export const RECORD_STATE_LABEL: Readonly<Record<RecordState, string>> = {
  new: 'חדש',
  unchanged: 'כבר יובא',
  corrected: 'תוקן במקור',
}

/**
 * The identity of one source record.
 *
 * The source's own id where there is one. `sourceId` is trimmed and lower-cased
 * because a re-export that changes `HM-ABC` to `hm-abc` is the same booking and
 * treating it as a new one would double it — which is the exact failure the key
 * exists to prevent, arriving through the key itself.
 */
export function recordKey(record: ImportRecord): string {
  const sourceId = record.sourceId?.trim().toLowerCase() ?? ''
  return sourceId.length > 0 ? sourceId : record.contentHash
}

/** Whether this record's identity came from the source or from its body. */
export function hasStableIdentity(record: ImportRecord): boolean {
  return (record.sourceId?.trim().length ?? 0) > 0
}

/** The ledger, indexed the way `classify` needs it. */
export function indexLedger(
  entries: readonly LedgerEntry[],
): ReadonlyMap<string, LedgerEntry> {
  const index = new Map<string, LedgerEntry>()
  for (const entry of entries) {
    index.set(`${entry.entity} ${entry.recordKey}`, entry)
  }
  return index
}

/**
 * New, already imported, or imported and since corrected.
 *
 * `unchanged` requires the digest to match as well as the key. A record whose
 * key matches and whose body does not is `corrected` — the operator fixed a
 * date in their old system and re-exported, and telling them "already imported"
 * would report success for a change that never landed.
 */
export function classify(
  record: ImportRecord,
  ledger: ReadonlyMap<string, LedgerEntry>,
): { state: RecordState; existing: LedgerEntry | null } {
  const entry = ledger.get(`${record.entity} ${recordKey(record)}`)
  if (entry === undefined) return { state: 'new', existing: null }
  if (entry.contentHash === record.contentHash) {
    return { state: 'unchanged', existing: entry }
  }
  return { state: 'corrected', existing: entry }
}

/**
 * The key the write carries into the service pipeline.
 *
 * Derived from the organization, the entity, the record's identity and its
 * content — and deliberately **not** from the session. A key scoped to the
 * session would make the second import of the same file a fresh set of keys,
 * which is precisely the case this exists to catch.
 *
 * The content digest is in the key because an idempotency replay returns the
 * *original* result: keyed on identity alone, a corrected record would replay
 * the pre-correction write and report success without applying the fix.
 */
export function operationIdempotencyKey(
  record: ImportRecord,
  organizationId: string,
): string {
  return `migration:${fingerprint({
    organizationId,
    entity: record.entity,
    key: recordKey(record),
    content: record.contentHash,
  })}`
}

export interface IdempotencyPlan {
  create: readonly ImportRecord[]
  correct: readonly ImportRecord[]
  unchanged: readonly ImportRecord[]
  /** Records whose identity is only their body. Counted so the screen can warn. */
  withoutStableIdentity: number
}

/**
 * What this file would do against what has already been imported.
 *
 * Pure. Given the same records and the same ledger it returns the same plan on
 * every machine, which is what lets the dry run be read as a promise about the
 * apply rather than as an estimate of it.
 */
export function planAgainstLedger(
  records: readonly ImportRecord[],
  entries: readonly LedgerEntry[],
): IdempotencyPlan {
  const ledger = indexLedger(entries)

  const create: ImportRecord[] = []
  const correct: ImportRecord[] = []
  const unchanged: ImportRecord[] = []
  let withoutStableIdentity = 0

  // A file that holds the same record twice is a file, not a ledger problem.
  // The second occurrence is `unchanged` against the first, so an export that
  // repeats a booking per night does not create one booking per night.
  const seen = new Map<string, string>()

  for (const record of records) {
    if (!hasStableIdentity(record)) withoutStableIdentity += 1

    const key = `${record.entity} ${recordKey(record)}`
    const seenHash = seen.get(key)
    if (seenHash !== undefined) {
      unchanged.push(record)
      continue
    }
    seen.set(key, record.contentHash)

    const { state } = classify(record, ledger)
    if (state === 'new') create.push(record)
    else if (state === 'corrected') correct.push(record)
    else unchanged.push(record)
  }

  return { create, correct, unchanged, withoutStableIdentity }
}

/**
 * The ledger row to write once a record has landed.
 *
 * Built here rather than in `apply.ts` so that the key written is provably the
 * same key `classify` will look for. Two places computing "the identity of a
 * record" is how a second run stops recognising the first.
 */
export function ledgerEntryFor(
  record: ImportRecord,
  args: { estiaId: string; sessionId: string },
): LedgerEntry {
  return {
    entity: record.entity,
    recordKey: recordKey(record),
    contentHash: record.contentHash,
    estiaId: args.estiaId,
    sessionId: args.sessionId,
    rowNumber: record.rowNumber,
  }
}
