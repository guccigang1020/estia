/**
 * Everything this screen is not saying, and why.
 *
 * Four notes, and they exist because the alternative to each one is a lie a
 * reader would believe.
 *
 *   `AbsenceList`  — an insight that could not be produced. Grouped by reason,
 *                    because "you may not" and "your package does not include
 *                    this" are answered by two different people, and "there is
 *                    no comparison period" is not answered by anybody: it is a
 *                    fact about a business that is three weeks old.
 *   `GapList`      — a figure no canonical source produces. Not a permission,
 *                    not a package, not a bug.
 *   `EmptyWindow`  — the source returned no rows. Distinct in wording from a
 *                    failed query, which renders as an error with a
 *                    correlation id and never as this.
 *   `ScopeNote`    — what the figures actually cover, since a property-scoped
 *                    manager who asked for the organization silently received
 *                    their own properties.
 *
 * No `"use client"`: text in, markup out.
 */

import { entitlementLabel } from '@/components/nav/labels'
import type { AbsenceReason, InsightAbsence, InsightGap } from '@/lib/insights'
import type { ResolvedScope } from '@/lib/metrics'

const REASON_HEADING: Readonly<Record<AbsenceReason, string>> = {
  permission: 'לא חושב — מחוץ להרשאות שלך',
  plan: 'לא חושב — לא כלול בחבילה',
  no_baseline: 'אין תקופת השוואה',
  not_measurable: 'אין ממה לחשב',
  no_data: 'אין נתונים בתקופה',
}

/** The order the groups are read in: rights first, then the calendar. */
const REASON_ORDER: readonly AbsenceReason[] = [
  'plan',
  'permission',
  'no_baseline',
  'not_measurable',
  'no_data',
]

export function AbsenceList({
  absences,
}: {
  absences: readonly InsightAbsence[]
}) {
  if (absences.length === 0) return null

  const groups = REASON_ORDER.map((reason) => ({
    reason,
    entries: absences.filter((absence) => absence.reason === reason),
  })).filter((group) => group.entries.length > 0)

  return (
    <section
      aria-labelledby="insights-absent"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="insights-absent"
          className="font-display text-base font-bold text-foreground"
        >
          מה לא נאמר כאן, ולמה
        </h2>
        <p className="text-sm text-muted-foreground">
          כל שורה כאן היא תובנה שלא חושבה. אין מאחוריה אפס ואין מאחוריה מספר
          מוסתר — פשוט לא נבדק דבר.
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.reason} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {REASON_HEADING[group.reason]}
          </h3>

          <ul className="flex flex-col gap-2">
            {group.entries.map((absence) => (
              <li
                key={absence.id}
                className="flex flex-col gap-1 border-s-2 border-border ps-3"
              >
                <p className="text-sm font-medium text-foreground">
                  {absence.title}
                  {absence.entitlement !== null && (
                    <span className="text-muted-foreground">
                      {' '}
                      — היכולת נקראת {entitlementLabel(absence.entitlement)}
                    </span>
                  )}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {absence.explanation}
                </p>
                {/* Metrics are named, never their grant codes.
                    "report.financial.view" is not a sentence a hotelier can
                    act on; "הכנסות" is. */}
                {absence.metricNames.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    הנתונים שהיא קוראת: {absence.metricNames.join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

export function GapList({ gaps }: { gaps: readonly InsightGap[] }) {
  if (gaps.length === 0) return null

  return (
    <section
      aria-labelledby="insights-gaps"
      className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-5"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="insights-gaps"
          className="font-display text-base font-bold text-foreground"
        >
          מה המסך הזה עדיין לא יודע למדוד
        </h2>
        <p className="text-sm text-muted-foreground">
          לא הרשאה ולא חבילה: אין במוצר מקור קנוני שמייצר את המספר, ולכן אין
          תובנה. רשום כאן כדי שמי שחיפש אותו ידע למה הוא לא נמצא.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {gaps.map((gap) => (
          <li key={gap.title} className="flex flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">{gap.title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {gap.explanation}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * A window the source could say nothing about.
 *
 * The sentence teaches rather than apologises: a business with three weeks of
 * history has no trend, and a screen that drew a flat line for it would be
 * inventing one. This is the shape a new customer sees on their first day, so
 * it says what has to exist before the screen fills.
 */
export function EmptyWindow({ period }: { period: string }) {
  return (
    <section
      role="status"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-8 text-center shadow-soft"
    >
      <h2 className="font-display text-lg font-bold text-foreground">
        אין נתונים ב{period}
      </h2>
      <p className="mx-auto max-w-prose text-sm leading-relaxed text-muted-foreground">
        לא נמצאו יחידות או הזמנות בתקופה הזאת, ולכן אין ממה לגזור תובנה. זה אינו
        אפס תפוסה ואינו אפס הכנסות — אלה טענות על עסק שנמדד, וכאן לא נמדד דבר.
      </p>
      <p className="mx-auto max-w-prose text-sm leading-relaxed text-muted-foreground">
        תובנה על כיוון דורשת שתי תקופות עם נתונים. עסק שהתחיל לפני שלושה שבועות
        עדיין אין לו מגמה, וקו שטוח היה המצאה ולא מדידה. בחרו תקופה אחרת למעלה,
        או חזרו אחרי שיהיו הזמנות בפנקס.
      </p>
    </section>
  )
}

/** What the figures above actually cover. Ids stay ids when a name is missing. */
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
      התובנות מכסות: <span className="text-foreground">{covered}</span>.
      {scope.unitIds !== null &&
        ' הטווח שלך מוגבל ליחידות מסוימות, והמספרים סופרים רק אותן.'}
    </p>
  )
}
