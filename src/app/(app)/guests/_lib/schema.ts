/**
 * What a new guest card must contain, and what the database will refuse.
 *
 * Plain TypeScript beside the action rather than inside it, for two reasons.
 * The prosaic one is that a `'use server'` module may only export async
 * functions, so a validator and a label map cannot live there. The real one is
 * that the browser and the server have to agree about what is wrong with a
 * form, and the only way to guarantee that is to have them run the same
 * function — `create-guest-form.tsx` imports this, and so does
 * `createGuestAction`. The client copy saves a round trip; the server copy is
 * the rule.
 *
 * Every check below is a check the database already makes. That is deliberate
 * and it is the *order* that matters: `guests_email_format` refusing a write
 * produces a Postgres error naming a constraint, and the person filling in the
 * form learns nothing from it. Refusing here names the field in Hebrew.
 * Neither replaces the other — the constraint is the authority, this is the
 * explanation.
 */

import type { FieldIssue } from '@/lib/errors'

export type CreateGuestInput = {
  fullName: string
  /** Optional everywhere except the name: a walk-in may leave nothing else. */
  phone: string
  email: string
  /** Matches `guests.language`, which is `text not null default 'he'`. */
  language: string
  /** ISO-3166 alpha-2, upper case, or empty. */
  nationality: string
  city: string
  /** Free text the business invents. Blank and repeated entries are dropped. */
  tags: readonly string[]
  notes: string
  marketingConsent: boolean
}

export const EMPTY_GUEST_INPUT: CreateGuestInput = {
  fullName: '',
  phone: '',
  email: '',
  language: 'he',
  nationality: '',
  city: '',
  tags: [],
  notes: '',
  marketingConsent: false,
}

/** The Hebrew name of each field, for the message a person actually reads. */
export const GUEST_FIELD_LABEL: Record<string, string> = {
  fullName: 'שם מלא',
  phone: 'טלפון',
  email: 'אימייל',
  language: 'שפה',
  nationality: 'אזרחות',
  city: 'עיר',
  notes: 'הערות',
}

/**
 * `guests_email_format`, as 0009 writes it.
 *
 * Copied from the constraint rather than invented, so a value this accepts is
 * a value the database accepts. The point is not to be a good e-mail validator
 * — nothing is — it is to refuse here, with the field named, rather than let
 * Postgres refuse with a constraint name nobody can act on.
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** `guests_nationality_format`, and `guests_country_format` beside it. */
const ALPHA2 = /^[A-Z]{2}$/

/**
 * Every problem at once, never the first.
 *
 * A form that reveals its problems one at a time is a form somebody submits
 * five times.
 */
export function validateGuest(input: CreateGuestInput): FieldIssue[] {
  const issues: FieldIssue[] = []

  const push = (field: string, code: string, message: string) => {
    issues.push({ field, code, message, label: GUEST_FIELD_LABEL[field] })
  }

  // `guests_full_name_not_blank` is `length(btrim(full_name)) > 0`. Two
  // characters rather than one, matching the booking form's own floor — a
  // one-letter guest card is a typo somebody has to clean up later.
  if (input.fullName.trim().length < 2) {
    push('fullName', 'too_short', 'שם האורח חייב להכיל לפחות שני תווים.')
  }

  const email = input.email.trim()
  if (email.length > 0 && !EMAIL.test(email)) {
    push('email', 'invalid', 'כתובת האימייל אינה בפורמט תקין.')
  }

  const nationality = input.nationality.trim().toUpperCase()
  if (nationality.length > 0 && !ALPHA2.test(nationality)) {
    push(
      'nationality',
      'invalid',
      'אזרחות נשמרת כקוד מדינה בן שתי אותיות לטיניות, למשל IL או FR.',
    )
  }

  if (input.language.trim().length === 0) {
    push('language', 'required', 'צריך לציין שפה. ברירת המחדל היא עברית.')
  }

  return issues
}

/**
 * The tags as they will be stored.
 *
 * Trimmed, de-duplicated and stripped of blanks — an empty label is a tag
 * nobody can filter on and every guest silently carries.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()))].filter(
    (tag) => tag.length > 0,
  )
}
