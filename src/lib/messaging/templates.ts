/**
 * The wording a business writes for itself, and what stops it breaking.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * `compose.ts` writes good Hebrew and every business gets the same Hebrew.
 * A guesthouse with a voice of its own — or one hosting mostly English
 * speakers, or one whose owner simply says things differently — cannot change
 * a word of what its guests are sent. `message_templates` has been declared
 * missing in the inbox screen since the messaging module landed; this is that
 * table's reason.
 *
 * ══ THE RULE THE WHOLE FILE EXISTS TO ENFORCE ═══════════════════════════════
 *
 * **A template that names a fact the product cannot supply is refused when it
 * is SAVED, not when a guest is waiting for it.**
 *
 * The failure this prevents is specific and expensive. Somebody writes
 * `{{door_code}}` because their previous system had one. It saves. Three weeks
 * later a guest arrives at a locked door holding a message that says
 * `{{door_code}}` — and the business finds out from the guest. Validation at
 * save time turns that into a red line under a text box while somebody is
 * sitting there able to fix it.
 *
 * ══ ABSENT IS NOT THE SAME AS UNKNOWN ═══════════════════════════════════════
 *
 * Two placeholders can legitimately have no value at send time, and they are
 * the two `compose.ts` already handles with an `if`:
 *
 *   · `amount`     — the outstanding balance is null when nothing has been
 *                    computed yet
 *   · `portal_url` — a business with no portal link configured
 *
 * They are not forbidden. They carry a declared `whenAbsent`, the editor shows
 * it, and the business chooses knowingly. What is NOT done is dropping the
 * whole message because one line is missing — `compose.ts` argues that at
 * length and it holds here: a missing setting must not become a guest who was
 * never told their check-in time.
 *
 * ══ THE BUILT-IN TEXT REMAINS THE FALLBACK ══════════════════════════════════
 *
 * No template means `compose.ts` exactly as it is today. Nothing regresses for
 * a business that never opens this screen, and a business that writes a
 * template and then deletes it goes back to working Hebrew rather than to
 * silence.
 */

import type { GuestMessageKind } from './types'

/* -------------------------------------------------------- the placeholders -- */

export type PlaceholderName =
  | 'guest_first_name'
  | 'organization_name'
  | 'property_name'
  | 'reference'
  | 'check_in'
  | 'check_out'
  | 'amount'
  | 'portal_url'

export type Placeholder = {
  readonly name: PlaceholderName
  /** Hebrew, shown in the editor beside the token. */
  readonly label: string
  /**
   * What appears when the product has no value at send time.
   *
   * `null` means it can never be absent, so the editor says nothing about it.
   * A non-null value is a promise: this exact text goes to the guest.
   */
  readonly whenAbsent: string | null
}

const PLACEHOLDER: Readonly<Record<PlaceholderName, Placeholder>> =
  Object.freeze({
    guest_first_name: {
      name: 'guest_first_name',
      label: 'שם האורח',
      // A booking can genuinely carry no first name — a channel import often
      // does. `compose.ts` already falls back to a bare "שלום,".
      whenAbsent: '',
    },
    organization_name: {
      name: 'organization_name',
      label: 'שם העסק',
      whenAbsent: null,
    },
    // Falls back to the organization name when a booking names no property,
    // which is exactly what `where()` in `compose.ts` already does. The caller
    // resolves it, so the token can never render empty and needs no
    // `whenAbsent`.
    //
    // There is deliberately no `unit_name`: `GuestMessageSubject` does not
    // carry one, and offering a placeholder the product cannot fill is the
    // thing this whole module refuses to do.
    property_name: {
      name: 'property_name',
      label: 'שם הנכס',
      whenAbsent: null,
    },
    reference: { name: 'reference', label: 'מספר הזמנה', whenAbsent: null },
    check_in: { name: 'check_in', label: 'תאריך הגעה', whenAbsent: null },
    check_out: { name: 'check_out', label: 'תאריך יציאה', whenAbsent: null },
    amount: {
      name: 'amount',
      label: 'יתרה לתשלום',
      whenAbsent: 'יתרה לתשלום',
    },
    portal_url: {
      name: 'portal_url',
      label: 'קישור לאורח',
      whenAbsent: '',
    },
  })

/**
 * Which placeholders each kind may use.
 *
 * Scoped per kind rather than one global list, because `{{amount}}` in a
 * review request is not a typo the product should quietly render as empty —
 * it is somebody editing the wrong template, and the sooner they are told the
 * less confusing it is.
 */
export const PLACEHOLDERS_FOR: Readonly<
  Record<GuestMessageKind, readonly Placeholder[]>
> = Object.freeze({
  payment_reminder: [
    PLACEHOLDER.guest_first_name,
    PLACEHOLDER.organization_name,
    PLACEHOLDER.property_name,
    PLACEHOLDER.reference,
    PLACEHOLDER.check_in,
    PLACEHOLDER.check_out,
    PLACEHOLDER.amount,
    PLACEHOLDER.portal_url,
  ],
  arrival_info: [
    PLACEHOLDER.guest_first_name,
    PLACEHOLDER.organization_name,
    PLACEHOLDER.property_name,
    PLACEHOLDER.reference,
    PLACEHOLDER.check_in,
    PLACEHOLDER.check_out,
    PLACEHOLDER.portal_url,
  ],
  review_request: [
    PLACEHOLDER.guest_first_name,
    PLACEHOLDER.organization_name,
    PLACEHOLDER.property_name,
    PLACEHOLDER.reference,
    PLACEHOLDER.portal_url,
  ],
})

/* ------------------------------------------------------------- validation -- */

/**
 * `{{ name }}` with optional inner spaces, and nothing else.
 *
 * Deliberately narrow. A single brace is text, `{{{x}}}` does not parse as a
 * placeholder, and there is no expression syntax at all — a template language
 * a business can write logic in is a template language that can loop forever
 * on the send path.
 */
const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g

export type TemplateProblem =
  | { readonly kind: 'unknown_placeholder'; readonly token: string }
  | { readonly kind: 'wrong_kind'; readonly token: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_long'; readonly length: number }

/**
 * 1500 characters.
 *
 * Not a storage limit. An SMS is billed per 70 Hebrew characters, and a
 * business writing a page of text is about to be surprised by a bill it never
 * agreed to. The number is generous enough for a long WhatsApp message and
 * small enough that nobody writes a brochure by accident.
 */
export const MAX_TEMPLATE_CHARS = 1500

/** Every token in the text, in order, including repeats. */
export function tokensIn(body: string): readonly string[] {
  return [...body.matchAll(TOKEN)].map((match) => match[1] as string)
}

export function validateTemplate(
  kind: GuestMessageKind,
  body: string,
): readonly TemplateProblem[] {
  const problems: TemplateProblem[] = []

  if (body.trim() === '') return [{ kind: 'empty' }]
  if (body.length > MAX_TEMPLATE_CHARS) {
    problems.push({ kind: 'too_long', length: body.length })
  }

  const allowed = new Set(PLACEHOLDERS_FOR[kind].map((p) => p.name))
  const known = new Set(Object.keys(PLACEHOLDER))

  for (const token of tokensIn(body)) {
    if (!known.has(token)) {
      // Not a placeholder this product has ever had. `{{door_code}}`.
      problems.push({ kind: 'unknown_placeholder', token })
    } else if (!allowed.has(token as PlaceholderName)) {
      // Real placeholder, wrong template. `{{amount}}` in a review request.
      problems.push({ kind: 'wrong_kind', token })
    }
  }

  return problems
}

/* ---------------------------------------------------------------- render -- */

export type PlaceholderValues = Partial<Record<PlaceholderName, string | null>>

/**
 * Substitute, with the declared fallback for anything absent.
 *
 * Never throws and never leaves a raw token in the output. A token that
 * survived validation and still has no value renders as its `whenAbsent`,
 * which for most is the empty string — because a guest reading
 * `{{portal_url}}` is worse than a guest reading one line less.
 *
 * A line that becomes empty because its only content was an absent
 * placeholder is dropped, so a missing portal link does not leave a blank line
 * and a dangling colon behind it.
 */
export function renderTemplate(
  body: string,
  values: PlaceholderValues,
): string {
  const substituted = body.replace(TOKEN, (_match, rawName: string) => {
    const name = rawName as PlaceholderName
    const value = values[name]
    if (typeof value === 'string' && value.trim() !== '') return value
    return PLACEHOLDER[name]?.whenAbsent ?? ''
  })

  const lines = substituted.split('\n')
  const kept: string[] = []

  for (const line of lines) {
    const isBlank = line.trim() === ''
    // One blank line between paragraphs is deliberate formatting; two in a row
    // is the hole an absent placeholder left.
    if (isBlank && kept.length > 0 && kept[kept.length - 1]?.trim() === '') {
      continue
    }
    kept.push(line)
  }

  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()

  return kept.join('\n').trim()
}
