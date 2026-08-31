import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { MaintenanceTable } from '@/components/operations/maintenance-table'
import { TaskFilterBar } from '@/components/operations/task-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { Money } from '@/components/finance/money'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  describeTaskFilter,
  hasActiveTaskFilter,
  parseTaskFilter,
} from '../tasks/_lib/filters'
import {
  MAINTENANCE_TASK_TYPES,
  OPERATIONS_PAGE_SIZE,
  countTasks,
  listTasks,
} from '../tasks/_lib/queries'
import {
  maintenanceTotal,
  withCosts,
  type MaintenanceItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'תחזוקה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The maintenance queue.
 *
 * WHAT IS ON THIS SCREEN. Tasks of type `maintenance` and `inspection` from
 * `public.tasks`, with the money attached from `public.approvals` and
 * `public.inventory_movements`. Five facts per row: what is broken, in which
 * unit, since when, who owns it, and what it is costing.
 *
 * ── Why this is a second screen over the same table ───────────────────────
 *
 * `/tasks` answers "what has to happen today". This answers "what is wrong with
 * the buildings, and what is it costing us" — a different question, a different
 * sort, and a column the board does not have. Nothing here re-reads a task
 * differently: `listTasks` is the one reading of a task row and this narrows it
 * by type and hangs the cost on it.
 *
 * ── `cleaning` is not here ────────────────────────────────────────────────
 *
 * A departure clean is the readiness chain, which `/preparation` owns. Putting
 * it on this queue would put the same job on two boards with two different sets
 * of columns, and the first time they disagreed nobody would know which was
 * right.
 *
 * GATING. `requireGrant('task.view')` refuses the route — the catalogue has no
 * maintenance-specific grant, and the nearest true one is used rather than a
 * permission string the engine would never match. The membership's scope is
 * pushed into the query, `can()` narrows again per row, and the money is
 * withheld by `redact()` from anybody without `expense.view`. So the handyman
 * sees his jobs and not their price; his property manager sees both.
 */
export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('task.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const filter = parseTaskFilter(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const maySeeMoney = holdsGrant(actor, 'expense.view')

  let items: readonly MaintenanceItem[] = []
  let reachable = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    const [tasks, count] = await Promise.all([
      listTasks({
        db,
        actor,
        propertyId,
        filter,
        grant: 'task.view',
        types: MAINTENANCE_TASK_TYPES,
      }),
      countTasks({
        db,
        actor,
        propertyId,
        grant: 'task.view',
        types: MAINTENANCE_TASK_TYPES,
      }),
    ])
    items = await withCosts(db, actor, tasks)
    reachable = count
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const totals = maintenanceTotal(items)
  const open = items.filter(
    (item) =>
      item.status !== 'completed' &&
      item.status !== 'verified' &&
      item.status !== 'cancelled',
  )
  const emptyReason = resolveEmptyReason({
    visibleCount: items.length,
    totalCount: reachable,
    hasActiveFilters: hasActiveTaskFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תחזוקה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {propertyName
            ? `עבודות התחזוקה והביקורת ב״${propertyName}״.`
            : 'עבודות התחזוקה והביקורת בכל הנכסים שבטווח שלך.'}{' '}
          ניקיון והכנה אינם כאן — הם שרשרת המוכנות, ומופיעים במסך ההכנה.
        </p>
      </header>

      <TaskFilterBar
        path="/maintenance"
        legend="סינון עבודות תחזוקה"
        axes={['status', 'priority']}
        statuses={TASK_STATUSES}
        types={TASK_TYPES}
        priorities={TASK_PRIORITIES}
        selected={filter}
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'property'}
          title={
            emptyReason === 'no_results'
              ? 'אין עבודות תחזוקה שתואמות לסינון'
              : 'אין עבודות תחזוקה פתוחות'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeTaskFilter(
                  filter,
                  {
                    status: TASK_STATUS_LABEL,
                    type: TASK_TYPE_LABEL,
                    priority: TASK_PRIORITY_LABEL,
                  },
                  propertyName,
                )}) לא מחזיר תוצאות. עבודות אחרות קיימות במערכת — שינוי או ניקוי הסינון יחזיר אותן.`
              : 'כאן יופיע כל מה שדורש תיקון או ביקורת — מה תקול, באיזו יחידה, ממתי, מי אחראי עליו וכמה הוא עולה. תקלה שמדווחת במסך התקלות נפתחת כאן כעבודה.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/maintenance" variant="secondary">
                נקה סינון
              </Button>
            ) : holdsGrant(actor, 'incident.create') ? (
              <Button href="/incidents/new">דווח על תקלה</Button>
            ) : null
          }
        />
      ) : (
        <>
          <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">עבודות פתוחות</dt>
              <dd className="font-display text-xl font-bold tabular-nums text-foreground">
                {open.length}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">עלות מאושרת</dt>
              <dd className="font-display text-xl font-bold text-foreground">
                <Money agorot={totals?.committedAgorot} emphasis />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">ממתין לאישור</dt>
              <dd className="font-display text-xl font-bold text-foreground">
                <Money agorot={totals?.pendingAgorot} emphasis />
              </dd>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              {maySeeMoney
                ? 'הסכומים הם סיכום השורות המוצגות בלבד: בקשות שאושרו, ומלאי שנרשם כיוצא מול העבודה. הצעות שממתינות להחלטה נספרות בנפרד ואינן עלות.'
                : 'סכומי העלות אינם זמינים לך. הרשאת "צפייה בהוצאות" היא שפותחת אותם, ובלעדיה השדה ריק ולא אפס.'}
            </p>
          </dl>

          <MaintenanceTable
            items={items}
            caption="עבודות התחזוקה והביקורת שבטווח שלך, ממוינות לפי מועד היעד"
          />

          {items.length === OPERATIONS_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {OPERATIONS_PAGE_SIZE} העבודות הקרובות ביותר. צמצם את
              הסינון כדי לראות עבודות נוספות.
            </p>
          )}
        </>
      )}
    </div>
  )
}
