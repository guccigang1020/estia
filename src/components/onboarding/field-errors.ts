/**
 * Server field issues, indexed by the control they belong to.
 *
 * `ActionError` already lists every offending field in one block, and that
 * list stays — it is what a screen reader reaches first and what somebody
 * scrolled past the form still sees. This turns the same issues into a lookup
 * so the message ALSO appears under the control that caused it, which is where
 * a person fixing it is actually looking.
 *
 * First issue per field wins. A field with two complaints has one root cause,
 * and stacking both under one input reads as noise.
 *
 * `Object.hasOwn`, never `field in errors`. The `in` operator walks the
 * prototype chain, so a field named `constructor` or `toString` would test as
 * already present on an empty object literal and its message would be dropped
 * without a trace. No field is called that today — which is exactly the kind
 * of assumption that stops being true in a year, in a helper nobody re-reads.
 */

import type { SafeErrorBody } from '@/lib/errors/safe-response'

export type FieldErrors = Readonly<Record<string, string>>

export const NO_FIELD_ERRORS: FieldErrors = Object.freeze({})

export function fieldErrorsFrom(
  error: SafeErrorBody | null | undefined,
): FieldErrors {
  if (!error?.fields || error.fields.length === 0) return NO_FIELD_ERRORS

  const errors: Record<string, string> = {}
  for (const issue of error.fields) {
    if (!Object.hasOwn(errors, issue.field)) errors[issue.field] = issue.message
  }
  return errors
}

/** The same shape, built from the client-side validators in `schema.ts`. */
export function fieldErrorsFromIssues(
  issues: readonly { field: string; message: string }[],
): FieldErrors {
  if (issues.length === 0) return NO_FIELD_ERRORS

  const errors: Record<string, string> = {}
  for (const issue of issues) {
    if (!Object.hasOwn(errors, issue.field)) errors[issue.field] = issue.message
  }
  return errors
}
