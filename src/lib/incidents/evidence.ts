/**
 * Evidence is a reference and its provenance. It is never a blob.
 *
 * ══ THIS MODULE STORES NO BYTES, AND THAT IS A RULE RATHER THAN A HABIT ═════
 *
 * Nothing in this codebase holds file content. `src/lib/website/types.ts`
 * models an image as a `site_media` row carrying a URL, dimensions and alt
 * text and has no data column; `src/lib/payments/types.ts` models a bank
 * transfer receipt as a `storageKey` the `ProofStorage` port interprets, and
 * the payments module never sees the file either. This follows both exactly.
 *
 * Why it matters more here than anywhere else. A damage photograph is the
 * artefact a dispute turns on: the guest says the worktop was already burnt,
 * the business says it was not, and the only thing that settles it is a file
 * with a capture time somebody can check. A row that carried the bytes would
 * be a row an ordinary `update` could rewrite, and an evidence store whose
 * contents can be edited in place is not evidence. So the row points at the
 * file and records who put it there and when, and the file lives wherever the
 * deployment's object store lives.
 *
 * `assertReference` is the enforcement rather than the documentation: a draft
 * carrying an inline `data:` URI or a base64 payload is refused before it can
 * reach the repository, because that is the exact shape a well-meaning caller
 * reaches for the first time somebody asks to "just save the photo".
 *
 * ── What evidence is NOT allowed to say ───────────────────────────────────
 *
 * Whose fault it is. There is no `liability`, `responsible` or `charge` field
 * on this record and there must never be one. A before photograph and an after
 * photograph are two facts; the difference between them is a third fact; the
 * conclusion is a person's, and it lives in `liability.ts` with that person's
 * name on it.
 *
 * Pure. Nothing here reaches a database.
 */

/* --------------------------------------------------------------- kinds --- */

/**
 * The nine things a case can be evidenced by.
 *
 * `timestamp` looks odd beside the others and is the most useful of them: the
 * fact that the lock was opened at 03:14, that the cleaner's checklist was
 * signed at 11:02, that the guest's message arrived on Tuesday. It carries no
 * media at all and is a reference to a moment, which is why the media pointer
 * below is nullable.
 */
export const EVIDENCE_KINDS = [
  'before_photo',
  'after_photo',
  'video',
  'staff_statement',
  'guest_statement',
  'invoice',
  'repair_estimate',
  'inventory_record',
  'timestamp',
] as const

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  before_photo: 'תמונה לפני',
  after_photo: 'תמונה אחרי',
  video: 'וידאו',
  staff_statement: 'הצהרת עובד',
  guest_statement: 'הצהרת אורח',
  invoice: 'חשבונית',
  repair_estimate: 'הצעת מחיר לתיקון',
  inventory_record: 'רישום מלאי',
  timestamp: 'חותמת זמן',
}

/** The kinds that point at a file. The rest carry text or a moment. */
export const MEDIA_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'before_photo',
  'after_photo',
  'video',
  'invoice',
  'repair_estimate',
]

/** The kinds that carry somebody's words. */
export const STATEMENT_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'staff_statement',
  'guest_statement',
]

/** The two halves of a comparison. Neither concludes anything on its own. */
export const COMPARISON_KINDS: readonly EvidenceKind[] = [
  'before_photo',
  'after_photo',
]

/**
 * Who produced it.
 *
 * Recorded because it changes what the evidence is worth and never because it
 * changes what the evidence *says*. A guest's photograph of a stain is a
 * photograph of a stain; that the guest took it is a fact a person weighs.
 */
export const EVIDENCE_SOURCES = ['staff', 'guest', 'vendor', 'system'] as const

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  staff: 'צוות',
  guest: 'אורח',
  vendor: 'ספק',
  system: 'מערכת',
}

/* ----------------------------------------------------------- the record -- */

/**
 * One piece of evidence.
 *
 * `mediaRef` is opaque and is interpreted by exactly one thing: whatever
 * storage port the deployment wires up. This module never dereferences it,
 * never fetches it and never renders it — the same contract `PaymentProof`
 * has with `storageKey`.
 *
 * `capturedAt` and `recordedAt` are two different times and both are kept. A
 * photograph taken at checkout and uploaded four days later is ordinary; a
 * photograph whose capture time is *after* the case was opened is a question
 * somebody should ask, and collapsing the two would delete the question.
 */
export interface CaseEvidence {
  id: string
  organizationId: string
  caseId: string
  kind: EvidenceKind
  /** Opaque pointer into the object store. Never the file. Never a data URI. */
  mediaRef: string | null
  contentType: string | null
  /** Bytes as reported by the store, for display. The file is still not here. */
  byteSize: number | null
  /** The words, for a statement. `null` for everything else. */
  statement: string | null
  /** When the thing evidenced happened, per the file's own metadata. */
  capturedAt: Date | null
  /** When it was attached to this case. Always known. */
  recordedAt: Date
  source: EvidenceSource
  recordedByUserId: string | null
  note: string | null
}

/** What attaching evidence needs. */
export interface CaseEvidenceDraft {
  organizationId: string
  caseId: string
  kind: EvidenceKind
  mediaRef: string | null
  contentType: string | null
  byteSize: number | null
  statement: string | null
  capturedAt: Date | null
  source: EvidenceSource
  recordedByUserId: string | null
  note: string | null
}

/* ------------------------------------------------------------ the rules -- */

export type EvidenceProblem =
  | 'inline_bytes'
  | 'media_kind_without_reference'
  | 'statement_kind_without_text'
  | 'reference_and_statement'
  | 'no_provenance'

export const EVIDENCE_PROBLEM_MESSAGE: Record<EvidenceProblem, string> = {
  inline_bytes:
    'לא ניתן לשמור את תוכן הקובץ עצמו. יש לשמור הפניה לקובץ באחסון, ולא את הקובץ.',
  media_kind_without_reference: 'ראיה מסוג קובץ חייבת להפנות לקובץ באחסון.',
  statement_kind_without_text: 'הצהרה חייבת לכלול את מה שנאמר.',
  reference_and_statement:
    'ראיה אחת היא או קובץ או הצהרה, ולא שניהם. יש לצרף שתי ראיות נפרדות.',
  no_provenance: 'לכל ראיה חייב להיות מקור ידוע.',
}

export type EvidenceCheck =
  { ok: true } | { ok: false; problems: readonly EvidenceProblem[] }

/**
 * Does this look like somebody trying to store the file itself?
 *
 * Three shapes, and all three are things a caller reaches for honestly. A
 * `data:` URI is what a browser's `FileReader` produces. A bare base64 run is
 * what a naive API client sends. A `blob:` URL is a pointer that is valid in
 * one browser tab for a few minutes and is worthless the moment it is stored,
 * which makes it worse than bytes rather than better.
 *
 * Deliberately narrow: an ordinary storage key or an `https://` URL passes,
 * and a false refusal here would block real evidence, which is the failure
 * direction that costs a business a deposit.
 */
export function looksLikeInlineBytes(reference: string): boolean {
  const value = reference.trim()
  if (value.startsWith('data:')) return true
  if (value.startsWith('blob:')) return true

  // A very long unbroken base64-ish run with no path separator is a payload,
  // not a key. Storage keys in this codebase carry slashes and extensions.
  return value.length > 512 && /^[A-Za-z0-9+/=]+$/.test(value)
}

/**
 * Refuse anything that is not a reference plus its provenance.
 *
 * Returns a result rather than throwing, because this is called from a domain
 * operation that turns problems into a `ValidationError` with fields, and from
 * tests that assert the refusal — neither wants an exception to unwrap.
 */
export function checkEvidence(draft: CaseEvidenceDraft): EvidenceCheck {
  const problems: EvidenceProblem[] = []

  if (draft.mediaRef !== null && looksLikeInlineBytes(draft.mediaRef)) {
    problems.push('inline_bytes')
  }

  if (draft.statement !== null && looksLikeInlineBytes(draft.statement)) {
    problems.push('inline_bytes')
  }

  const wantsMedia = MEDIA_EVIDENCE_KINDS.includes(draft.kind)
  const wantsStatement = STATEMENT_EVIDENCE_KINDS.includes(draft.kind)

  if (wantsMedia && !hasText(draft.mediaRef)) {
    problems.push('media_kind_without_reference')
  }

  if (wantsStatement && !hasText(draft.statement)) {
    problems.push('statement_kind_without_text')
  }

  if (hasText(draft.mediaRef) && hasText(draft.statement)) {
    problems.push('reference_and_statement')
  }

  // Provenance is the whole difference between evidence and a picture. A row
  // whose source is unknown cannot be weighed by the person deciding, so it is
  // refused at the door rather than shown to them as if it counted.
  if (!EVIDENCE_SOURCES.includes(draft.source)) {
    problems.push('no_provenance')
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0
}

/* ---------------------------------------------------------- comparisons -- */

/**
 * The before/after pairs on a case, as pairs.
 *
 * A pairing and not a finding. What comes back is "these two photographs are
 * of the same thing at two times", which is the raw material a person looks
 * at. It says nothing about what changed and could not: this module has never
 * seen either file.
 */
export interface EvidencePair {
  before: CaseEvidence
  after: CaseEvidence
}

/**
 * Pair the before shots with the after shots, oldest first.
 *
 * Pairs by position after sorting by capture time, which is the only ordering
 * available without opening the files. Unpaired shots are simply absent from
 * the result — an unmatched "after" is not half a comparison, it is one
 * photograph, and pretending otherwise would invent a "before" that nobody
 * took.
 */
export function pairComparisons(
  evidence: readonly CaseEvidence[],
): readonly EvidencePair[] {
  const before = byTime(evidence.filter((item) => item.kind === 'before_photo'))
  const after = byTime(evidence.filter((item) => item.kind === 'after_photo'))

  const pairs: EvidencePair[] = []
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    const first = before[index]
    const second = after[index]
    if (first && second) pairs.push({ before: first, after: second })
  }
  return pairs
}

function byTime(evidence: readonly CaseEvidence[]): readonly CaseEvidence[] {
  return [...evidence].sort(
    (left, right) => timeOf(left).getTime() - timeOf(right).getTime(),
  )
}

function timeOf(item: CaseEvidence): Date {
  return item.capturedAt ?? item.recordedAt
}

/**
 * How complete the evidence on this case is, counted rather than scored.
 *
 * A count and never a percentage or a confidence. "Two photographs, one
 * invoice, no guest statement" is a sentence a person can act on; "evidence
 * quality 68%" is a number that invites somebody to decide a dispute by it.
 */
export interface EvidenceTally {
  total: number
  byKind: Record<EvidenceKind, number>
  comparisons: number
  /** Evidence the guest themselves supplied. Weighed by a person, not scored. */
  fromGuest: number
}

export function tallyEvidence(
  evidence: readonly CaseEvidence[],
): EvidenceTally {
  const byKind = Object.fromEntries(
    EVIDENCE_KINDS.map((kind) => [kind, 0]),
  ) as Record<EvidenceKind, number>

  for (const item of evidence) byKind[item.kind] += 1

  return {
    total: evidence.length,
    byKind,
    comparisons: pairComparisons(evidence).length,
    fromGuest: evidence.filter((item) => item.source === 'guest').length,
  }
}
