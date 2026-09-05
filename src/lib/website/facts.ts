/**
 * WHERE EVERY PUBLISHED SENTENCE COMES FROM.
 *
 * This is the module's centre. Everything else — the studio, the renderer, the
 * quality passes, the AI port — is arranged around the rule enforced here:
 *
 *   ══════════════════════════════════════════════════════════════════════
 *   A CLAIM THAT CANNOT BE TRACED TO A ROW IS NOT PUBLISHED.
 *   ══════════════════════════════════════════════════════════════════════
 *
 * ── Why this is a builder and not a validator ─────────────────────────────
 *
 * A validator runs after the fact and can be skipped. The functions below are
 * the only way to construct a `SiteClaim`, and each one takes the row it is
 * reading from as an argument — `fromProperty(property, 'description')` cannot
 * be called without a property, and it records which column it read. There is
 * no exported function that produces a claim from a bare string with a
 * canonical source attached, because that is precisely the shape a hallucinated
 * fact would arrive in.
 *
 * `authored` is the one source that is a person rather than a table, and
 * `authoredClaim` demands the person's user id. "Somebody typed it" is a real
 * provenance; "it appeared" is not.
 *
 * ── Drift ─────────────────────────────────────────────────────────────────
 *
 * A claim records `sourceValue` — what the row said when the claim was made.
 * When the row changes, `driftedClaims` finds every published sentence that no
 * longer matches its source. That is the failure mode a naive "read the row at
 * render time" design does not have and a snapshot design does, and it is
 * answered rather than ignored: the studio shows drift, the pre-publish pass
 * raises it, and the renderer still serves the snapshot because serving
 * half-old and half-new copy is worse than serving old copy honestly.
 *
 * ── What the AI may and may not do ────────────────────────────────────────
 *
 * A model's output arrives as a `GeneratedDraft`, which is NOT a claim and has
 * no source. `groundDraft` is the only door from one to the other: it takes the
 * draft, the facts that were offered to the model, and the person accepting it,
 * and it returns claims sourced to that person — plus the list of sentences it
 * could not ground, which are dropped rather than published. A model cannot
 * manufacture provenance because it never touches this file.
 */

import {
  CANONICAL_FACT_SOURCES,
  type SiteClaim,
  type SiteFactSource,
  type SiteSection,
} from './types'

/**
 * Re-exported from the file that enforces the rule, not only from the file
 * that declares the shape.
 *
 * A reader who arrives at `groundDraft` or `claimFromRow` should be able to
 * import the thing they produce from the same module, rather than learning
 * that the type lives somewhere else and the guarantees live here.
 */
export type { SiteClaim }

/* -------------------------------------------------------- the row shapes -- */

/**
 * The canonical rows this module is allowed to read facts from.
 *
 * Deliberately structural rather than imported from each owning module: what
 * matters is that the value came from a row with an id, and a structural type
 * lets `facts.test.ts` exercise every branch without a database. The
 * repository is what guarantees these are really property and unit rows, and
 * it reads them with an explicit `organization_id` filter.
 */
export type SourceRow = Record<string, unknown>

/**
 * A row's id, or `null`.
 *
 * `Row` in the persistence layer is `Record<string, unknown>` and cannot
 * promise an id, so this reads one and refuses when there is none. That
 * refusal is load-bearing rather than defensive: a row with no id cannot be
 * pointed at, so nothing read from it can be traced, so it produces no claim
 * at all. `claimFromRow` returning `null` there is the module's rule applied
 * one level lower than the constraint.
 */
function rowId(row: SourceRow): string | null {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : null
}

/* ------------------------------------------------------------ the builder -- */

/** Nothing useful can be said with an empty string, and an empty claim is noise. */
function present(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

/**
 * Read one column of one canonical row as a claim.
 *
 * Returns `null` when the column is absent or empty — which is the whole
 * point. A property with no `description` produces no description claim, the
 * section renders without one, and nothing anywhere invents a paragraph about
 * a villa in the Galilee. A caller that wants to know it was missing gets
 * `null` rather than a plausible sentence.
 */
export function claimFromRow(input: {
  key: string
  row: SourceRow
  column: string
  source: Exclude<SiteFactSource, 'authored'>
  /** Rendered differently from the raw value — "4 חדרי שינה" from `4`. */
  format?: (raw: string) => string
}): SiteClaim | null {
  const raw = present(input.row[input.column])
  if (raw === null) return null

  const id = rowId(input.row)
  if (id === null) return null

  return {
    key: input.key,
    text: input.format ? input.format(raw) : raw,
    source: input.source,
    sourceId: id,
    sourceField: input.column,
    sourceValue: raw,
  }
}

/**
 * A sentence a person wrote.
 *
 * `authorUserId` is required and becomes the claim's `sourceId`. A published
 * paragraph of marketing prose is legitimate and common; what is not
 * legitimate is a published paragraph nobody will own.
 */
export function authoredClaim(input: {
  key: string
  text: string
  authorUserId: string
}): SiteClaim | null {
  const text = present(input.text)
  if (text === null) return null
  if (present(input.authorUserId) === null) return null

  return {
    key: input.key,
    text,
    source: 'authored',
    sourceId: input.authorUserId,
    sourceField: null,
    sourceValue: text,
  }
}

/* ------------------------------------------------------------ the checker -- */

export type UnsourcedClaim = {
  claim: SiteClaim
  reason:
    'canonical_source_without_row' | 'authored_without_author' | 'empty_text'
}

/**
 * Every claim that cannot be traced, with the reason.
 *
 * Three ways a claim fails, and each is a different mistake:
 *
 *   `canonical_source_without_row`  it says it came from a property and names
 *                                   no property. The shape a fabricated fact
 *                                   takes when somebody writes the row by hand.
 *   `authored_without_author`       nobody will own the sentence.
 *   `empty_text`                    a claim asserting nothing, which a
 *                                   renderer turns into an empty heading.
 *
 * Note what is NOT checked here: whether the row still says what the claim
 * says. That is drift, it is a different question, and answering it needs the
 * current rows — see `driftedClaims`.
 */
export function unsourcedClaims(
  claims: readonly SiteClaim[],
): readonly UnsourcedClaim[] {
  const failures: UnsourcedClaim[] = []

  for (const claim of claims) {
    if (present(claim.text) === null) {
      failures.push({ claim, reason: 'empty_text' })
      continue
    }

    const sourceId = present(claim.sourceId)

    if (claim.source === 'authored') {
      if (sourceId === null) {
        failures.push({ claim, reason: 'authored_without_author' })
      }
      continue
    }

    if (CANONICAL_FACT_SOURCES.includes(claim.source) && sourceId === null) {
      failures.push({ claim, reason: 'canonical_source_without_row' })
    }
  }

  return failures
}

/** Every claim in a set of sections, flattened. What the manifest is built from. */
export function allClaims(
  sections: readonly SiteSection[],
): readonly SiteClaim[] {
  return sections.flatMap((section) => section.claims)
}

/**
 * May this be published?
 *
 * The gate `publish.ts` calls, and the reason it is a separate exported
 * function rather than an `if` inside the publish operation: the studio calls
 * it too, before the button is pressed, so a person is told what is wrong while
 * they can still fix it rather than at the moment they expected to go live.
 */
export function publishBlockers(
  sections: readonly SiteSection[],
): readonly UnsourcedClaim[] {
  return unsourcedClaims(allClaims(sections))
}

/* -------------------------------------------------------------- the drift -- */

export type DriftedClaim = {
  claim: SiteClaim
  /** What the row says now. `null` when the row or column is gone. */
  currentValue: string | null
}

/**
 * Published sentences whose source has moved underneath them.
 *
 * `rows` is keyed by the source row's id. A claim whose row is absent from the
 * map is NOT reported: the caller may have loaded only the properties, and
 * treating "I did not look" as "it changed" would fill the studio with noise
 * that trains people to ignore it.
 *
 * `authored` claims never drift. A person's sentence is not wrong because a
 * column moved, and reporting it would mean a business could never write a
 * word of its own without being nagged about it.
 */
export function driftedClaims(
  claims: readonly SiteClaim[],
  rows: ReadonlyMap<string, SourceRow>,
): readonly DriftedClaim[] {
  const drifted: DriftedClaim[] = []

  for (const claim of claims) {
    if (claim.source === 'authored') continue
    if (claim.sourceId === null || claim.sourceField === null) continue

    const row = rows.get(claim.sourceId)
    if (!row) continue

    const current = present(row[claim.sourceField])
    if (current !== claim.sourceValue) {
      drifted.push({ claim, currentValue: current })
    }
  }

  return drifted
}

/* ---------------------------------------------------------- the AI ground -- */

/**
 * What a model returns. Not a claim, and it cannot become one by itself.
 *
 * `text` is prose. `citesFactKeys` is the model's assertion about which of the
 * facts it was given each sentence rests on — an assertion, not a proof, which
 * is exactly why `groundDraft` checks it against the facts that were actually
 * offered rather than believing it.
 */
export type GeneratedDraft = {
  key: string
  text: string
  citesFactKeys: readonly string[]
}

export type GroundingResult = {
  /** Sourced to the accepting person, and safe to store. */
  accepted: readonly SiteClaim[]
  /** Dropped, with the reason. Shown to the person; never published. */
  rejected: readonly { draft: GeneratedDraft; reason: string }[]
}

/**
 * Turn a model's draft into claims a person owns, or drop it.
 *
 * ── Why the result is `authored` and not some `generated` source ──────────
 *
 * Because a generated sentence has no provenance until somebody accepts it,
 * and after somebody accepts it the provenance is that person. A `generated`
 * source would be a published claim whose answer to "who says so?" is "a
 * language model", which is the thing this whole module exists to prevent.
 * The fact that a model drafted it is recorded — in
 * `site_generation_requests`, with the prompt and the offered facts — so the
 * history is not lost; it is simply not a source.
 *
 * ── The check ─────────────────────────────────────────────────────────────
 *
 * Every fact key the draft cites must be among the facts that were offered. A
 * model that cites `property.heated_pool` when no such fact was in its input
 * has invented one, and that draft is dropped whole rather than edited down —
 * a paragraph with one fabricated clause removed is still a paragraph nobody
 * checked.
 *
 * A draft that cites nothing is allowed through as pure prose, because "a
 * warm welcome awaits you in the Galilee" asserts nothing checkable and a
 * person is accepting it. What is refused is a draft that claims a source it
 * was not given.
 */
export function groundDraft(input: {
  drafts: readonly GeneratedDraft[]
  /** The facts handed to the model, by key. Nothing else may be cited. */
  offeredFacts: readonly SiteClaim[]
  acceptedByUserId: string
}): GroundingResult {
  const offered = new Set(input.offeredFacts.map((fact) => fact.key))
  const accepted: SiteClaim[] = []
  const rejected: { draft: GeneratedDraft; reason: string }[] = []

  for (const draft of input.drafts) {
    const invented = draft.citesFactKeys.filter((key) => !offered.has(key))

    if (invented.length > 0) {
      rejected.push({
        draft,
        reason: `הטיוטה מסתמכת על עובדות שלא נמסרו לה: ${invented.join(', ')}`,
      })
      continue
    }

    const claim = authoredClaim({
      key: draft.key,
      text: draft.text,
      authorUserId: input.acceptedByUserId,
    })

    if (!claim) {
      rejected.push({ draft, reason: 'הטיוטה ריקה ואין מה לפרסם ממנה.' })
      continue
    }

    accepted.push(claim)
  }

  return { accepted, rejected }
}
