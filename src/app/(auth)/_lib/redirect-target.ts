/**
 * EXECUTION CONTEXT — either. Pure string handling, no I/O.
 *
 * OPEN REDIRECT DEFENCE.
 *
 * Every auth screen carries a `?next=` parameter so that a user who was
 * interrupted lands back where they were going. That parameter is attacker
 * controlled: a link like
 *
 *     https://estia.example/sign-in?next=https://estia-login.example/steal
 *
 * arrives looking legitimate, and if the value is fed to `redirect()` without
 * checking, the product itself bounces the freshly-authenticated user onto a
 * phishing page. Every `next` value in this route group passes through here
 * first, and anything that is not a plain same-origin path is discarded rather
 * than repaired.
 */

export const DEFAULT_AFTER_SIGN_IN = '/account'

/** Bouncing a signed-in user back to sign-in is a loop, not a destination. */
const NEVER_A_DESTINATION = [
  '/sign-in',
  '/sign-up',
  '/magic-link',
  '/forgot-password',
  '/reset-password',
  '/auth',
]

/**
 * A newline, carriage return or NUL inside a `Location` header splits the
 * response and lets an attacker append headers of their own. Checked by code
 * point rather than by regular expression, so the guard cannot be weakened by
 * a mis-escaped character class.
 */
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function safeRedirectTarget(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_SIGN_IN,
): string {
  if (!raw) return fallback

  // Must be a path on this origin. `https://evil.example` and
  // `javascript:alert(1)` both fail here.
  if (!raw.startsWith('/')) return fallback

  // `//evil.example` is protocol-relative and resolves to another host.
  // `/\evil.example` is the same attack: several browsers normalise the
  // backslash to a slash before resolving.
  if (raw[1] === '/' || raw[1] === '\\') return fallback

  if (containsControlCharacter(raw)) return fallback

  const path = raw.split(/[?#]/)[0]
  if (
    NEVER_A_DESTINATION.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  ) {
    return fallback
  }

  return raw
}
