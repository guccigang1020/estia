/**
 * EXECUTION CONTEXT — either. The shape a Server Action hands back to
 * `useActionState`, and the small amount of validation the auth forms share.
 *
 * This file is deliberately NOT a `"use server"` module: `"use server"` files
 * may only export async functions, and these are types and pure helpers.
 */

export type AuthField = 'email' | 'password' | 'confirmPassword' | 'fullName'

export type AuthFormState = {
  status: 'idle' | 'error' | 'success'
  /** The sentence shown in the form-level alert. */
  message: string | null
  /** Per-field messages, rendered next to the input and via aria-describedby. */
  fieldErrors: Partial<Record<AuthField, string>>
  /**
   * Incremented on every server response.
   *
   * The alert component moves focus when this changes rather than when the
   * message changes, so submitting the same wrong password twice announces
   * twice instead of falling silent the second time.
   */
  attempt: number
}

export const INITIAL_STATE: AuthFormState = {
  status: 'idle',
  message: null,
  fieldErrors: {},
  attempt: 0,
}

export function initialStateWithMessage(
  message: string | null,
  status: 'error' | 'success' | 'info' = 'error',
): AuthFormState {
  if (!message) return INITIAL_STATE
  return {
    // `info` is presentational only; the state machine has no such state, and
    // a message the user did not cause should not read as a failure.
    status: status === 'success' ? 'success' : 'error',
    message,
    fieldErrors: {},
    attempt: 0,
  }
}

export function fail(
  previous: AuthFormState,
  message: string,
  fieldErrors: Partial<Record<AuthField, string>> = {},
): AuthFormState {
  return {
    status: 'error',
    message,
    fieldErrors,
    attempt: previous.attempt + 1,
  }
}

export function succeed(
  previous: AuthFormState,
  message: string,
): AuthFormState {
  return {
    status: 'success',
    message,
    fieldErrors: {},
    attempt: previous.attempt + 1,
  }
}

/* ------------------------------------------------------------- validation -- */

/**
 * Intentionally permissive. Full RFC 5322 in a regular expression rejects
 * addresses that genuinely work, and the only authority on whether an address
 * exists is whether mail arrives at it. This catches the typo — a missing `@`,
 * a missing dot, a stray space — and lets the mail server judge the rest.
 * It mirrors the CHECK constraint on `invitations.email` in migration 0001.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Matches Supabase's own default minimum, so the server never disagrees. */
export const MIN_PASSWORD_LENGTH = 8

export function readText(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** Passwords are not trimmed: a leading or trailing space is part of them. */
export function readSecret(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

export function validateEmail(email: string): string | null {
  if (!email) return 'יש להזין כתובת אימייל.'
  if (email.length > 254) return 'כתובת האימייל ארוכה מדי.'
  if (!EMAIL_PATTERN.test(email)) return 'כתובת האימייל אינה תקינה.'
  return null
}

export function validateNewPassword(password: string): string | null {
  if (!password) return 'יש לבחור סיסמה.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים.`
  }
  // 72 bytes is bcrypt's hard limit; anything beyond it is silently ignored,
  // which would mean two different passwords opening the same account.
  if (new TextEncoder().encode(password).length > 72) {
    return 'הסיסמה ארוכה מדי. בחרו סיסמה קצרה יותר.'
  }
  return null
}

export function hasFieldErrors(
  fieldErrors: Partial<Record<AuthField, string>>,
): boolean {
  return Object.values(fieldErrors).some(Boolean)
}
