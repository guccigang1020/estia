/**
 * The work plans behind the board, and the honest account of there being none.
 *
 * ── The empty state here is a fact, not a failure ─────────────────────────
 *
 * `work_plans` is written by `buildPlan`, which is a write, and no screen in
 * this product calls it yet. So today every deployment — including the demo,
 * where the table is seeded empty on purpose — has stays with real cleaning
 * jobs and no computed plan behind them. That is an ordinary state with an
 * ordinary explanation, and it is said in those words.
 *
 * What it must never be confused with is a query that threw. A screen that
 * renders nothing because a read failed looks identical to a business with
 * nothing scheduled, and the page above this renders `ActionError` for the
 * first and this panel only for the second.
 *
 * ── The snapshot line is the whole point of the domain ────────────────────
 *
 * A plan carries `snapshotHash`, and beside it in `preparation_snapshots` is
 * the frozen catalogue it was computed against — append-only by trigger, so
 * not even `service_role` can move it. That is the mechanism that stops a plan
 * built in March from re-costing itself when April's prices change, and it is
 * worth a line on screen: the reader is told which day's rules this plan is
 * measured by, rather than being left to assume it is today's.
 *
 * Nothing here recomputes a section, a quantity or a duration.
 * `criticalPathMinutes` and `outstandingItems` are the domain's own functions,
 * called on the stored plan.
 *
 * No `"use client"`: plans in, markup out.
 */

import type { PlannedStay } from '@/app/(app)/preparation/_lib/queries'
import { EmptyState } from '@/components/states/empty-state'
import { cn } from '@/components/ui/cn'
import {
  criticalPathMinutes,
  outstandingItems,
  type PlanSection,
} from '@/lib/preparation'

import { TaskStatusBadge, isBlocked } from './task-status'

export type WorkPlanPanelProps = {
  stays: readonly PlannedStay[]
  /** How many stays on the board were looked up at all. */
  lookedUp: number
}

export function WorkPlanPanel({ stays, lookedUp }: WorkPlanPanelProps) {
  const planned = stays.filter((stay) => stay.plan !== null)

  if (planned.length === 0) {
    return (
      <EmptyState
        illustration="task"
        as="h3"
        title="עוד לא נבנתה תוכנית הכנה מחושבת"
        body={
          lookedUp === 0
            ? 'תוכנית הכנה נבנית לשהייה מתוך חוקי הנכס — כמה מצעים, כמה מגבות, כמה זמן וכמה אנשים. אין כרגע שהייה בטווח שאפשר לבדוק עבורה, ולכן אין מה להציג. זו אינה תקלה.'
            : `תוכנית הכנה נבנית לשהייה מתוך חוקי הנכס — כמה מצעים, כמה מגבות, כמה זמן וכמה אנשים — ונשמרת יחד עם צילום קפוא של החוקים, כדי שתוכנית מחודש שעבר לא תשתנה כשמחירון משתנה היום. נבדקו ${lookedUp} שהיות בטווח ולאף אחת מהן עוד לא נבנתה תוכנית. המשימות שלמטה קיימות ומוקצות כרגיל.`
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {planned.map((stay) => (
        <PlanCard key={stay.bookingId} stay={stay} />
      ))}
    </div>
  )
}

function PlanCard({ stay }: { stay: PlannedStay }) {
  const plan = stay.plan
  if (plan === null) return null

  const blocked = plan.sections.filter((section) => isBlocked(section.status))

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-display text-base font-bold text-foreground">
          תוכנית הכנה · גרסה {plan.version}
        </h4>
        <p className="text-sm text-muted-foreground">
          {/* From the domain, over the stored sections — not the column, so
              the figure on screen and the figure the engine would compute
              cannot disagree after a section is edited. */}
          מסלול קריטי {criticalPathMinutes(plan.sections)} דקות · צוות מומלץ{' '}
          {plan.recommendedStaff}
        </p>
      </header>

      {blocked.length > 0 && (
        <p className="rounded-lg border border-danger bg-surface px-3 py-2 text-sm font-semibold text-danger">
          {blocked.length === 1
            ? 'שלב אחד תקוע ועוצר את המשך התוכנית.'
            : `${blocked.length} שלבים תקועים ועוצרים את המשך התוכנית.`}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {plan.sections.map((section) => (
          <li key={section.key}>
            <SectionRow
              section={section}
              // The Hebrew heading each section already carries, so a
              // dependency is named the way the section itself is named
              // rather than as its machine key.
              labelOf={(key) =>
                plan.sections.find((entry) => entry.key === key)?.label ?? key
              }
            />
          </li>
        ))}
      </ul>

      {/* Which day's rules this plan is measured by. Absent when the snapshot
          could not be read, and said as absent rather than as today's. */}
      <p className="text-xs text-muted-foreground">
        {stay.snapshot === null
          ? 'לא נמצא צילום החוקים שהתוכנית חושבה מולו.'
          : `חושבה מול החוקים שהיו בתוקף ב-${stay.snapshot.effectiveOn}.`}
      </p>
    </article>
  )
}

function SectionRow({
  section,
  labelOf,
}: {
  section: PlanSection
  labelOf: (key: PlanSection['key']) => string
}) {
  const outstanding = outstandingItems(section)

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2',
        isBlocked(section.status) ? 'border-danger' : 'border-border',
      )}
    >
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-foreground">{section.label}</span>
        <span className="text-xs text-muted-foreground">
          {section.items.length === 1
            ? 'פריט אחד'
            : `${section.items.length} פריטים`}
          {outstanding.length > 0 && ` · ${outstanding.length} עדיין פתוחים`}
          {section.dependsOn.length > 0 &&
            ` · מותנה בסיום: ${section.dependsOn.map(labelOf).join(', ')}`}
          {section.assignedToUserId === null && ' · לא הוקצה'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {section.minutes} דקות
        </span>
        <TaskStatusBadge status={section.status} />
      </div>
    </div>
  )
}
