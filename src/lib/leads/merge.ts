/**
 * What a merge is allowed to decide, and what it may never be asked.
 *
 * PURE. Nothing here reads or writes; `public.guest_merge_apply` does both, and
 * it re-decides everything below on its own terms. This module is what the
 * screen is built from and what the operation validates against, so a person
 * is told what is wrong before a transaction opens rather than after it rolls
 * back.
 *
 * ══ THE ALLOW-LIST IS THE DESIGN ════════════════════════════════════════════
 *
 * `docs/PERSONAL_DATA_INVENTORY.md` records that `guests` holds a date of
 * birth, an identity-document number in plain text, and a full address, and
 * that the document number is the most sensitive field in the database. §14 of
 * the specification puts it on the list of things that are never written to an
 * audit trail.
 *
 * So a merge resolves identity and contact, and stops:
 *
 *     chooseable   full_name · first_name · last_name ·
 *                  email · phone · phone_alt · language
 *     by rule      tags · notes · marketing_consent (+ _at) ·
 *                  is_blocked (+ blocked_reason)
 *     never        date_of_birth · nationality · id_document_* ·
 *                  address_line1 · city · postal_code · country · metadata
 *
 * A merge decides who the person is and how to reach them. It does not decide
 * where they live or what their passport says. Nothing is lost by refusing:
 * the merged row is soft-deleted rather than erased and still holds every one
 * of them, so a person who wants the address can read it and type it.
 *
 * ══ THE FOUR NOBODY CHOOSES (ח40-12) ════════════════════════════════════════
 *
 * Consent, blocking, tags and notes are computed, and a choice sent for them
 * is ignored rather than honoured. Refusal wins on consent — two people, one
 * of whom said no, is one person who said no — and the block wins on blocking.
 * A screen that offered "keep consent: yes" after one of the two had opted out
 * would be the bug, so the option does not exist.
 */

export const MERGE_CHOOSEABLE_FIELDS = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'phone_alt',
  'language',
] as const

export type MergeField = (typeof MERGE_CHOOSEABLE_FIELDS)[number]

/**
 * Named so it can be asserted in a test rather than only described.
 *
 * `merge.test.ts` checks that no member of this list is a member of
 * `MERGE_CHOOSEABLE_FIELDS`, which is a weak guarantee on its own — the strong
 * one is that `guest_merge_apply` names its columns literally and there is no
 * path in it that reads any of these.
 */
export const MERGE_NEVER_COPIED_FIELDS = [
  'date_of_birth',
  'nationality',
  'id_document_type',
  'id_document_number',
  'id_document_country',
  'address_line1',
  'city',
  'postal_code',
  'country',
  'metadata',
] as const

/** Fields the database decides. A choice sent for one of these is discarded. */
export const MERGE_RULED_FIELDS = [
  'tags',
  'notes',
  'marketing_consent',
  'marketing_consent_at',
  'is_blocked',
  'blocked_reason',
] as const

export const MERGE_FIELD_LABEL: Record<MergeField, string> = {
  full_name: 'שם מלא',
  first_name: 'שם פרטי',
  last_name: 'שם משפחה',
  email: 'אימייל',
  phone: 'טלפון',
  phone_alt: 'טלפון נוסף',
  language: 'שפה',
}

export type MergeSide = 'survivor' | 'merged'

/** `{ full_name: 'merged' }`. An unnamed field keeps the survivor's value. */
export type MergeChoices = Partial<Record<MergeField, MergeSide>>

/**
 * Only the fields the two rows actually disagree about.
 *
 * A merge screen that lists every column is a screen nobody reads to the
 * bottom, and the fields that matter are the ones where a person has to
 * choose. Where the two agree there is no decision and no entry.
 */
export interface MergeConflict {
  field: MergeField
  label: string
  survivorValue: string | null
  mergedValue: string | null
}

export type MergeableGuest = Readonly<
  Record<MergeField, string | null> & { id: string; version: number }
>

export function conflictsBetween(
  survivor: MergeableGuest,
  merged: MergeableGuest,
): readonly MergeConflict[] {
  return MERGE_CHOOSEABLE_FIELDS.filter(
    (field) => (survivor[field] ?? null) !== (merged[field] ?? null),
  ).map((field) => ({
    field,
    label: MERGE_FIELD_LABEL[field],
    survivorValue: survivor[field] ?? null,
    mergedValue: merged[field] ?? null,
  }))
}

/**
 * The choices, cleaned of anything the database will ignore.
 *
 * Sending a choice for `marketing_consent` and having it silently discarded is
 * the kind of thing that reads as working until the day somebody checks. It is
 * dropped here, where a test can see it happen.
 */
export function sanitiseChoices(input: Record<string, unknown>): MergeChoices {
  const choices: MergeChoices = {}
  for (const field of MERGE_CHOOSEABLE_FIELDS) {
    const value = input[field]
    if (value === 'merged' || value === 'survivor') choices[field] = value
  }
  return choices
}

/* --------------------------------------------------- before it may run -- */

export interface MergeRequest {
  survivorId: string
  mergedId: string
  reason: string
  /**
   * The survivor's name, typed by hand.
   *
   * §5.3 and ח40-10: the confirmation is a name typed, not a button pressed.
   * A dialog with a button is dismissed by muscle memory; a name has to be
   * read off the correct column first, which is the whole mechanism.
   */
  typedSurvivorName: string
  survivorName: string
}

export interface MergeProblem {
  field: string
  message: string
}

/** The minimum a reason has to be before it explains anything (§8). */
export const MERGE_REASON_MIN = 10

export function problemsWithMerge(
  request: MergeRequest,
): readonly MergeProblem[] {
  const problems: MergeProblem[] = []

  // ק40-09
  if (request.survivorId === request.mergedId) {
    problems.push({
      field: 'mergedId',
      message: 'אי אפשר למזג פרופיל לתוך עצמו.',
    })
  }

  if (request.reason.trim().length < MERGE_REASON_MIN) {
    problems.push({
      field: 'reason',
      message:
        'יש להסביר למה מיזגת את הפרופילים. מישהו יקרא את זה בעוד חודשיים ' +
        'וינסה להבין מה קרה כאן.',
    })
  }

  // Compared on the normalised form, because a trailing space is not a
  // different person — but nothing looser than that, since the entire point is
  // that the name was read off the surviving column and not off the other one.
  if (collapse(request.typedSurvivorName) !== collapse(request.survivorName)) {
    problems.push({
      field: 'typedSurvivorName',
      message:
        `כדי לאשר, הקלד את שם האורח שיישאר: ״${request.survivorName}״. ` +
        'המיזוג מעביר את כל ההיסטוריה לפרופיל הזה.',
    })
  }

  return problems
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/* -------------------------------------------------------------- undoing -- */

export const MERGE_UNDO_WINDOW_DAYS = 30

export interface MergeRecord {
  id: string
  survivorGuestId: string
  mergedGuestId: string
  performedAt: string
  undoDeadline: string
  undoneAt: string | null
}

export type UndoAvailability =
  | { kind: 'available'; daysLeft: number }
  | { kind: 'already_undone'; at: string }
  | { kind: 'expired'; closedAt: string }

/**
 * Whether the 30-day banner should offer an undo — and nothing more.
 *
 * It deliberately does NOT try to say whether the undo will succeed. That
 * depends on whether any of the moved rows has been edited since, which is a
 * question about rows this module cannot see and which `guest_merge_undo`
 * answers by comparing the version it recorded at the moment of the move. A
 * screen that promised "undoable" on the strength of a date would be promising
 * something it cannot know.
 */
export function undoAvailability(
  record: MergeRecord,
  now: Date,
): UndoAvailability {
  if (record.undoneAt !== null) {
    return { kind: 'already_undone', at: record.undoneAt }
  }

  const deadline = Date.parse(record.undoDeadline)
  if (Number.isNaN(deadline) || now.getTime() > deadline) {
    return { kind: 'expired', closedAt: record.undoDeadline }
  }

  return {
    kind: 'available',
    daysLeft: Math.max(
      0,
      Math.ceil((deadline - now.getTime()) / (24 * 60 * 60 * 1000)),
    ),
  }
}
