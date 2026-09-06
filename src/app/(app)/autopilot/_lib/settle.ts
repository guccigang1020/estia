/**
 * EXECUTION CONTEXT — SERVER ONLY. One panel's failure stays in that panel.
 *
 * The same shape `action-center/page.tsx` wrote inline, lifted here because
 * five Autopilot screens need it and a fifth copy would be a fifth place for
 * the wording to drift.
 *
 * ── Why a failure must not blank the screen ──────────────────────────────
 *
 * A command centre that disappears because one table was briefly unreachable
 * is worse than one with four working sections and a fifth that says what went
 * wrong. And the second half matters more than the first: a section that
 * rendered nothing because its query failed must never look like a section
 * with nothing to do. On this screen in particular, "אין חריגות" and "לא הצלחנו
 * לקרוא את החריגות" are the difference between going to bed and not.
 *
 * `toSafeResponse` produces the correlation id and the Hebrew wording the
 * server already chose. Nothing here invents a sentence, and no stack trace or
 * SQL string can reach the browser through it.
 */

import { toSafeResponse } from '@/lib/errors'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export type Settled<T> =
  { ok: true; value: T } | { ok: false; error: SafeErrorBody }

export async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

/** The value, or a fallback, for a section that can render without the read. */
export function valueOr<T>(settled: Settled<T>, fallback: T): T {
  return settled.ok ? settled.value : fallback
}
