/**
 * The gate in front of an irreversible action.
 *
 * Two guarantees live here, and both are the kind that break quietly:
 *
 *  1. While a confirmation is in flight the gate is shut. A dialog that stays
 *     interactive for the 900ms the server takes is how a booking gets deleted
 *     twice — or worse, how the second click lands on whatever moved under the
 *     cursor after the dialog closed.
 *  2. When the action is dangerous enough to demand a typed phrase, "almost
 *     right" is not right. Leading and trailing space is forgiven because it
 *     comes from copy-paste and means nothing; a different word is not.
 */

export type ConfirmDenialReason =
  'pending' | 'phrase_missing' | 'phrase_mismatch'

export type ConfirmGateInput = {
  /**
   * The word the user must type — typically the name of the thing being
   * destroyed. Omitted, empty or whitespace-only means no phrase is demanded.
   */
  requiredPhrase?: string
  /** Exactly what is in the confirmation input right now. */
  typed?: string
  /** True while the confirmed action is running. */
  pending?: boolean
}

export type ConfirmGateVerdict = {
  canConfirm: boolean
  reason: ConfirmDenialReason | null
  /** True when a phrase is demanded at all, for rendering the input. */
  phraseRequired: boolean
  /** Hebrew help text for the input; `null` when nothing needs saying. */
  hint: string | null
}

/**
 * Compare on meaning, not on keystrokes: outer whitespace and runs of inner
 * whitespace come from copy-paste, and case is not a safety property in a
 * product whose object names are mostly Hebrew.
 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('he')
}

export function evaluateConfirmGate({
  requiredPhrase,
  typed = '',
  pending = false,
}: ConfirmGateInput): ConfirmGateVerdict {
  const phrase = requiredPhrase?.trim() ?? ''
  const phraseRequired = phrase.length > 0

  if (pending) {
    return {
      canConfirm: false,
      reason: 'pending',
      phraseRequired,
      hint: 'הפעולה מתבצעת. אל תסגור את החלון עד שתסתיים.',
    }
  }

  if (!phraseRequired) {
    return { canConfirm: true, reason: null, phraseRequired: false, hint: null }
  }

  if (typed.trim().length === 0) {
    return {
      canConfirm: false,
      reason: 'phrase_missing',
      phraseRequired: true,
      hint: `כדי לאשר, הקלד ${phrase}`,
    }
  }

  if (normalize(typed) !== normalize(phrase)) {
    return {
      canConfirm: false,
      reason: 'phrase_mismatch',
      phraseRequired: true,
      hint: `הטקסט אינו תואם. צריך להקליד בדיוק ${phrase}`,
    }
  }

  return { canConfirm: true, reason: null, phraseRequired: true, hint: null }
}
