/**
 * Environment configuration, validated once at startup.
 *
 * A missing variable should stop the application immediately with a sentence
 * that says which one, not surface three hours later as an authentication
 * failure nobody can explain.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    )
  }
  return value
}

export const env = {
  supabaseUrl: required(
    'NEXT_PUBLIC_SUPABASE_URL',
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  supabasePublishableKey: required(
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  /**
   * The canonical origin of this deployment.
   *
   * Every link we email — confirmation, magic link, password reset — is built
   * from this and from nothing else. Deriving it from the incoming request
   * would let a caller choose the `Host` header and therefore choose where a
   * recovery link points; Supabase's redirect allow-list would catch it, but a
   * security-critical URL should not depend on a header a stranger controls.
   *
   * No trailing slash, so callers can concatenate a path without doubling it.
   */
  siteUrl: required(
    'NEXT_PUBLIC_SITE_URL',
    process.env.NEXT_PUBLIC_SITE_URL,
  ).replace(/\/+$/, ''),
} as const

/**
 * The service role key bypasses row level security completely.
 *
 * It is read lazily and only from server code, so that importing anything in
 * this module from a client component cannot drag it into the browser bundle.
 * It has no `NEXT_PUBLIC_` prefix, which means Next.js will not inline it —
 * and it must never be given one.
 */
/**
 * The shared secret the release sweep is called with.
 *
 * Lazy and server-only for the same reason as the service role key. Its
 * ABSENCE is meaningful and is not an error here: the sweep route refuses
 * every request when it is unset, which is the safe direction — an
 * unauthenticated endpoint that sends messages on a customer's behalf is the
 * worst thing this codebase could leave open. So this returns null rather
 * than throwing, and the caller decides.
 */
export function sweepReleaseSecret(): string | null {
  if (typeof window !== 'undefined') {
    throw new Error('The sweep secret must never be read in the browser.')
  }
  const value = process.env.SWEEP_RELEASE_SECRET
  return value !== undefined && value.trim().length > 0 ? value : null
}

export function serviceRoleKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('The service role key must never be read in the browser.')
  }
  return required(
    'SUPABASE_SERVICE_ROLE_KEY',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
}

/**
 * Is the service role key configured at all?
 *
 * `serviceRoleKey()` throws when it is missing, which is right for a caller
 * about to use it and wrong for a caller deciding *whether* it can. Onboarding
 * is the second kind: it chooses between an atomic write, a compensated one and
 * an honest refusal, and it has to make that choice without an exception.
 *
 * Without this it read `process.env` itself — a second place naming the one
 * variable that bypasses row level security, which is exactly what the secret
 * check refuses. One reader, in one module, is the whole point of this file.
 *
 * It reports absence rather than handing back the value, because presence is
 * all a decision needs and a helper that returns the key to answer a yes/no
 * question is a wider door than the question deserves.
 */
export function hasServiceRoleKey(): boolean {
  if (typeof window !== 'undefined') return false

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return typeof key === 'string' && key.trim() !== ''
}
