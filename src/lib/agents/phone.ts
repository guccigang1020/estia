/**
 * The phone number, normalised to E.164.
 *
 * For an external seller the telephone number is not a contact detail — it is
 * the **identity key**. It is what an owner types to add someone, what is
 * searched to find out whether that person is already in ESTIA, where the
 * invitation is delivered, and what the one-time login code is sent to.
 *
 * A key stored in five formats is not a key. `050-1234567`, `0501234567`,
 * `+972-50-1234567` and `972501234567` are one person and would otherwise
 * become four agents, four commission ledgers and four sets of permissions —
 * discovered on the day somebody asks why they were paid a quarter of what
 * they sold.
 *
 * So normalisation happens **on write**, never on read. Adding it afterwards
 * means de-duplicating real people who have already made real bookings, and
 * merging them means merging history, permissions and audit.
 *
 * ── Why this is written here and not installed ────────────────────────────
 *
 * A general E.164 library carries a metadata table for every country on earth
 * and answers a question this product does not ask. What is needed is narrow
 * and specific: Israeli mobile numbers, typed by a hotelier during a telephone
 * call, in whichever of six shapes their contacts app happened to store them.
 * The value is in refusing the near-misses — a landline, a number one digit
 * short, a foreign number — with a reason precise enough to put beside the
 * field.
 */

/** The only country this product issues agent identities in, for now. */
export const ISRAEL_COUNTRY_CODE = '972'

/** Digits of an Israeli national significant number. `501234567`. */
const NATIONAL_LENGTH = 9

/**
 * Why a number was refused.
 *
 * Distinguished rather than collapsed into "invalid" because the interface has
 * something different to say about each: a landline needs a different number,
 * a short number needs a correction, a foreign number is not supported at all.
 */
export type PhoneRejection =
  | 'empty'
  | 'not_a_number'
  | 'too_short'
  | 'too_long'
  | 'not_israeli'
  | 'not_mobile'

export type PhoneNormalization =
  | {
      ok: true
      /** `+972501234567`. The stored identity key. */
      e164: string
      /** `501234567`. The national significant number, without the trunk zero. */
      national: string
    }
  | { ok: false; reason: PhoneRejection }

/** The Hebrew sentence for each refusal, so every surface says the same thing. */
export const PHONE_REJECTION_MESSAGE: Record<PhoneRejection, string> = {
  empty: 'יש להזין מספר טלפון.',
  not_a_number: 'מספר הטלפון יכול להכיל ספרות בלבד.',
  too_short: 'מספר הטלפון קצר מדי. מספר נייד ישראלי הוא עשר ספרות.',
  too_long: 'מספר הטלפון ארוך מדי. מספר נייד ישראלי הוא עשר ספרות.',
  not_israeli: 'כרגע ניתן להוסיף סוכנים עם מספר ישראלי בלבד.',
  not_mobile: 'יש להזין מספר נייד. הזמנת הסוכן והכניסה למערכת נשלחות ב-SMS.',
}

/**
 * Everything a person or a contacts app puts between the digits.
 *
 * Written as code points rather than as a regular expression literal because
 * most of them are invisible, and an invisible character inside a character
 * class is a line no reviewer can check.
 *
 * The bidirectional control marks matter more than they look. A Hebrew,
 * right-to-left interface routinely round-trips a number through an RTL text
 * run, and the invisible mark that comes back turns `+972…` into a string that
 * matches nothing and equals nothing. An identity key that silently fails to
 * match is worse than one that is refused out loud.
 */
const SEPARATOR_CODE_POINTS: ReadonlySet<number> = new Set([
  0x0009, // tab
  0x000a, // newline
  0x000d, // carriage return
  0x0020, // space
  0x0028, // (
  0x0029, // )
  0x002c, // ,
  0x002d, // hyphen-minus
  0x002e, // .
  0x002f, // /
  0x00a0, // no-break space
  0x2013, // en dash
  0x2014, // em dash
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
])

const DIGITS_ONLY = /^\d+$/

function stripSeparators(input: string): string {
  let kept = ''
  for (const character of input) {
    if (!SEPARATOR_CODE_POINTS.has(character.codePointAt(0) ?? -1)) {
      kept += character
    }
  }
  return kept
}

/**
 * Normalise one number.
 *
 * Never throws and never guesses. Ambiguity is resolved in exactly one place —
 * a leading `972` on a number too long to be a domestic one is read as a
 * country code — and everything else is decided by shape.
 */
export function normalizePhone(
  input: string | null | undefined,
): PhoneNormalization {
  if (input === null || input === undefined) return reject('empty')

  const cleaned = stripSeparators(input)
  if (cleaned.length === 0) return reject('empty')

  const hadPlus = cleaned.startsWith('+')
  const digits = hadPlus ? cleaned.slice(1) : cleaned

  if (digits.length === 0) return reject('empty')
  if (!DIGITS_ONLY.test(digits)) return reject('not_a_number')

  const national = toNationalSignificant(digits, hadPlus)
  if (national === null) return reject('not_israeli')

  // Order matters, and it is chosen so the reason sends the person to the right
  // correction. "Use a mobile number" and "you dropped a digit" are different
  // fixes, and reporting either as the other wastes the telephone call the
  // owner is having while they type.
  //
  // The prefix is therefore checked *before* the upper length bound. A
  // premium-rate `1-700-123-456` and a landline `03-1234567` are both perfectly
  // real Israeli numbers of the wrong kind, and telling their owner the number
  // is the wrong length invites them to add a digit to something that was never
  // going to work. Only the lower bound comes first, because a fragment too
  // short to have a prefix cannot be judged on the prefix it does not have.
  if (national.length < NATIONAL_LENGTH - 1) return reject('too_short')
  if (!national.startsWith('5')) return reject('not_mobile')
  if (national.length > NATIONAL_LENGTH) return reject('too_long')
  if (national.length !== NATIONAL_LENGTH) return reject('too_short')

  return { ok: true, e164: `+${ISRAEL_COUNTRY_CODE}${national}`, national }
}

/**
 * Strip whatever says "Israel" and whatever says "trunk call", leaving the
 * national significant number. `null` means the number named another country.
 *
 * `+972 (0)50-1234567` is the case worth naming: a contacts app that stores
 * both the country code and the domestic trunk zero produces a string carrying
 * both, and reading it literally yields a ten-digit national number that is one
 * digit too long and would be refused as a typo.
 */
function toNationalSignificant(
  digits: string,
  hadPlus: boolean,
): string | null {
  const international =
    hadPlus ||
    digits.startsWith('00') ||
    // No plus, no international prefix, and longer than any domestic number:
    // the only reading left is a country code somebody omitted the plus from.
    (digits.length > 10 && digits.startsWith(ISRAEL_COUNTRY_CODE))

  if (!international) {
    return digits.startsWith('0') ? digits.slice(1) : digits
  }

  const withoutExitCode = digits.startsWith('00') ? digits.slice(2) : digits
  if (!withoutExitCode.startsWith(ISRAEL_COUNTRY_CODE)) return null

  const rest = withoutExitCode.slice(ISRAEL_COUNTRY_CODE.length)
  return rest.startsWith('0') ? rest.slice(1) : rest
}

function reject(reason: PhoneRejection): PhoneNormalization {
  return { ok: false, reason }
}

/**
 * The stored key, or `null`.
 *
 * For call sites that only want the answer. Anything that has to explain a
 * refusal to a person uses `normalizePhone` and reads the reason.
 */
export function toE164(input: string | null | undefined): string | null {
  const result = normalizePhone(input)
  return result.ok ? result.e164 : null
}

/**
 * Are these the same person?
 *
 * Compared after normalisation, never as strings. Two records that disagree
 * about formatting are one identity, and this is the only comparison in the
 * module entitled to decide that.
 */
export function isSamePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = toE164(a)
  if (left === null) return false
  return left === toE164(b)
}

/**
 * `+972501234567` → `050-123-4567`.
 *
 * Display only. The stored value never changes shape — this exists so an audit
 * sentence reads the way the owner wrote the number, not the way we store it.
 */
export function formatIsraeliPhone(e164: string): string {
  const normalized = normalizePhone(e164)
  if (!normalized.ok) return e164

  const { national } = normalized
  return `0${national.slice(0, 2)}-${national.slice(2, 5)}-${national.slice(5)}`
}
