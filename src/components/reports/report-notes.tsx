/**
 * The two sentences a report owes its reader, and the state that has neither.
 *
 * ── Withheld is stated, never faked ───────────────────────────────────────
 *
 * `computeDashboard` returns refused metrics in `withheld` and computes no
 * value of any kind for them — not zero, not null, not a greyed-out tile
 * holding the real figure in its props. This note is the interface's half of
 * that contract: it names what is missing so the gap is a permission the
 * reader can ask about, rather than a blank they assume is a bug.
 *
 * It names the metrics and not the grants. A grant code is an internal string,
 * and "you are missing report.financial.view" is a sentence a hotelier cannot
 * act on; "הכנסות" is.
 *
 * ── What the scope actually covered ───────────────────────────────────────
 *
 * `ResolvedScope` is the intersection of what was asked for with what the
 * membership permits, and a property-scoped manager who asked for the whole
 * organization silently received their own properties. Silently is the
 * problem: an aggregate under a heading that says more than it covers is the
 * exact failure `scope.ts` exists to prevent, so the heading says what was
 * counted.
 *
 * No `"use client"`: text in, markup out.
 */

import type { ResolvedScope } from '@/lib/metrics'

export function WithheldNote({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null

  return (
    <p
      role="status"
      className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
    >
      {names.length === 1
        ? 'מדד אחד אינו כלול בהרשאות שלך ולכן לא חושב כלל: '
        : `${names.length} מדדים אינם כלולים בהרשאות שלך ולכן לא חושבו כלל: `}
      <span className="font-medium text-foreground">{names.join(' · ')}</span>.
    </p>
  )
}

/**
 * What the figures above actually cover.
 *
 * `propertyNames` is resolved by the caller from the shell's property list,
 * because ids are what the scope carries and an id on screen tells nobody
 * anything. A name the shell could not resolve stays as its id rather than
 * being invented — see the note on `PropertyOption`.
 */
export function ScopeNote({
  scope,
  propertyNames,
}: {
  scope: ResolvedScope
  propertyNames: readonly string[]
}) {
  const covered =
    scope.propertyIds === null
      ? 'כל הנכסים בארגון'
      : propertyNames.length === 0
        ? 'הנכסים שבטווח שלך'
        : propertyNames.join(' · ')

  return (
    <p className="text-sm text-muted-foreground">
      הנתונים מכסים: <span className="text-foreground">{covered}</span>.
      {scope.unitIds !== null &&
        ' הטווח שלך מוגבל ליחידות מסוימות, והמספרים סופרים רק אותן.'}
    </p>
  )
}

/**
 * A report with nothing to report.
 *
 * Distinct in wording from a failed query, which is the distinction the
 * charter's honesty rule turns on: "no stays in this window" is a true
 * statement about a quiet month, and a screen that renders the same thing
 * because a query threw is a lie. The failure path renders `ActionError`
 * instead, and never this.
 */
export function NoFiguresNote({ period }: { period: string }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-border bg-muted px-4 py-6 text-center text-sm text-muted-foreground"
    >
      אין מדדים להצגה עבור {period}. כל המדדים בדוח הזה מחוץ להרשאות שלך.
    </p>
  )
}
