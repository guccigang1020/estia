/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Reading the query string safely.
 *
 * Next.js types `searchParams` as
 * `Promise<{ [key: string]: string | string[] | undefined }>` — the array
 * branch is real: `?error=a&error=b` produces one. Every auth page needs the
 * same single-value read, and doing it by hand in each page is how one of them
 * ends up rendering `a,b` or crashing on `.startsWith`.
 */

export type SearchParams = Record<string, string | string[] | undefined>

export function firstParam(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
