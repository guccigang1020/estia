/**
 * The work plans behind the board, and the honest account of there being none.
 *
 * ── The empty state here is a fact, not a failure ─────────────────────────
 *
 * `work_plans` is written by `buildPlan`, and until `/preparation/[bookingId]`
 * existed nothing called it — so every deployment, the demo included, had
 * stays with real cleaning jobs and no computed plan behind any of them. That
 * is still an ordinary state for a business that has not built one yet, and it
 * is said in those words. What is new is that it is now an *actionable* state:
 * every stay without a plan carries a link to the screen that can build one,
 * rather than a paragraph explaining a dead end.
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

import Link from 'next/link'

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

/**
 * Where one stay's plan lives.
 *
 * The same route whether a plan exists or not: with one it renders the plan,
 * without one it offers to build it. A separate "create" URL would be a second
 * place for the same stay to live, and the pair would drift.
 */
export function planHref(bookingId: string): string {
  return `/preparation/${bookingId}`
}

export function WorkPlanPanel({ stays, lookedUp }: WorkPlanPanelProps) {
  const planned = stays.filter((stay) => stay.plan !== null)
  const unplanned = stays.filter((stay) => stay.plan === null)

  if (planned.length === 0 && unplanned.length === 0) {
    return (
      <EmptyState
        illustration="task"
        as="h3"
        title="עוד לא נבנתה תוכנית הכנה מחושבת"
        body="תוכנית הכנה נבנית לשהייה מתוך חוקי הנכס — כמה מצעים, כמה מגבות, כמה זמן וכמה אנשים. אין כרגע שהייה בטווח שאפשר לבדוק עבורה, ולכן אין מה להציג. זו אינה תקלה."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {planned.map((stay) => (
        <PlanCard key={stay.bookingId} stay={stay} />
      ))}

      {/* Stays with jobs on the board and no computed plan behind them. Listed
          rather than hidden, and each one links to the screen that can build
          it. `buildPlan` is a write and nothing called it until that screen
          existed, which is exactly why every deployment had an empty
          `work_plans` and an empty state that never resolved. */}
      {unplanned.length > 0 && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5 shadow-soft">
          <h4 className="font-display text-base font-bold text-foreground">
            שהיות בלי תוכנית מחושבת
          </h4>
          <p className="text-sm text-muted-foreground">
            תוכנית הכנה נבנית לשהייה מתוך חוקי הנכס ונשמרת יחד עם צילום קפוא של
            החוקים, כדי שתוכנית מחודש שעבר לא תשתנה כשהמדיניות משתנה היום. נבדקו{' '}
            {lookedUp} שהיות בטווח, ו
            {unplanned.length === 1 ? 'לאחת מהן' : `-${unplanned.length} מהן`}{' '}
            עוד לא נבנתה תוכנית. המשימות שלמטה קיימות ומוקצות כרגיל.
          </p>
          <ul className="flex flex-col gap-1">
            {unplanned.map((stay) => (
              <li key={stay.bookingId}>
                <Link
                  href={planHref(stay.bookingId)}
                  className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  בנה תוכנית הכנה לשהייה זו ←
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
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
          <Link
            href={planHref(stay.bookingId)}
            className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            תוכנית הכנה · גרסה {plan.version}
          </Link>
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
