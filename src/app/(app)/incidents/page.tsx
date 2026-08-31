import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { IncidentTable } from '@/components/operations/incident-table'
import { TaskFilterBar } from '@/components/operations/task-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import {
  describeTaskFilter,
  hasActiveTaskFilter,
  parseTaskFilter,
} from '../tasks/_lib/filters'
import {
  INCIDENT_TASK_TYPES,
  OPERATIONS_PAGE_SIZE,
  countTasks,
  listTasks,
  type TaskListItem,
} from '../tasks/_lib/queries'
import { requireIncidentAccess } from './_lib/guard'

export const metadata: Metadata = { title: 'תקלות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The fault register.
 *
 * ── THE ASYMMETRY THIS SCREEN EXISTS TO CARRY ────────────────────────────
 *
 * A cleaner may report a fault and may not browse the organization's faults.
 * That is in the permission catalogue — `cleaner` holds `incident.create` and
 * not `incident.view` — and it survives onto the screen rather than being
 * flattened by it.
 *
 * `requireIncidentAccess` admits anybody holding either grant and says which.
 * A reader with `incident.view` gets the register. A reporter without it gets
 * the reporting screen, and is *told* that the register is not theirs rather
 * than being shown an empty one — an empty list would be the product asserting
 * that this business has no faults, which is a lie about the data rather than a
 * statement about her permissions. Somebody holding neither never arrives: the
 * guard redirects with the missing grant named.
 *
 * ── What a fault report is, given there is no `incidents` table ───────────
 *
 * There is none. The catalogue carries four `incident.*` grants and
 * `DOMAIN_EVENTS` carries `incident.opened` and `incident.resolved`, and no
 * migration creates the table — 0011 puts every kind of operational work in
 * `public.tasks` on purpose. So a fault is a task whose `task_type` is
 * `maintenance`, `INCIDENT_TASK_TYPES` says so once, and the gap is reported
 * rather than papered over.
 *
 * GATING. The guard refuses the route. The membership's scope is pushed into
 * the query. `can(actor, 'incident.view', …)` narrows again per row — not
 * `task.view`, because this list is the incident reader's and a row admitted by
 * the wrong grant is a leak. `redact()` removes the reporter's name without
 * `user.view` and the link to the stay without `booking.view`. There is no
 * money on this screen at all.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, context, params] = await Promise.all([
    requireIncidentAccess(),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const { actor, mayBrowse, mayReport } = access

  // ── The reporter who may not browse ────────────────────────────────────
  if (!mayBrowse) {
    return (
      <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            דיווח על תקלה
          </h1>
          <p className="max-w-prose text-muted-foreground">
            אפשר לדווח כאן על כל דבר שנשבר, דולף, לא עובד או חסר. הדיווח נפתח
            כעבודת תחזוקה ומגיע לצוות שאחראי עליה.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle as="h2">רשימת התקלות של הארגון אינה פתוחה לך</CardTitle>
            <CardDescription>
              ההרשאה שלך כוללת דיווח על תקלה ולא צפייה בתקלות שאחרים דיווחו. זו
              הגדרה מכוונת ולא תקלה: רשימת התקלות היא תמונה של מה שלא תקין בכל
              הנכסים, והיא נפתחת למי שאחראי לטפל בהן. הדיווחים שלך נשלחים
              ומטופלים בדיוק כמו כל דיווח אחר.
            </CardDescription>
          </CardHeader>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button href="/incidents/new">דווח על תקלה</Button>
            <Button href="/tasks" variant="secondary">
              המשימות שלי
            </Button>
          </div>
        </Card>
      </div>
    )
  }

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

  let incidents: readonly TaskListItem[] = []
  let reachable = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[incidents, reachable] = await Promise.all([
      listTasks({
        db,
        actor,
        propertyId,
        filter,
        grant: 'incident.view',
        types: INCIDENT_TASK_TYPES,
      }),
      countTasks({
        db,
        actor,
        propertyId,
        grant: 'incident.view',
        types: INCIDENT_TASK_TYPES,
      }),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const unhandled = incidents.filter(
    (incident) =>
      incident.assignees.length === 0 &&
      incident.status !== 'completed' &&
      incident.status !== 'verified' &&
      incident.status !== 'cancelled',
  )
  const emptyReason = resolveEmptyReason({
    visibleCount: incidents.length,
    totalCount: reachable,
    hasActiveFilters: hasActiveTaskFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תקלות
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {propertyName
            ? `התקלות שדווחו ב״${propertyName}״.`
            : 'התקלות שדווחו בכל הנכסים שבטווח שלך.'}{' '}
          {reachable === 1 ? 'תקלה אחת סה״כ' : `${reachable} תקלות סה״כ`}.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {mayReport && <Button href="/incidents/new">דווח על תקלה</Button>}
      </div>

      <TaskFilterBar
        path="/incidents"
        legend="סינון תקלות"
        // No type axis: every row here is one type by definition, and a select
        // with one option is a control that pretends to do something.
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
          illustration={emptyReason === 'no_results' ? 'search' : 'task'}
          title={
            emptyReason === 'no_results'
              ? 'אין תקלות שתואמות לסינון'
              : 'לא דווחו תקלות'
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
                )}) לא מחזיר תוצאות. תקלות אחרות קיימות במערכת — שינוי או ניקוי הסינון יחזיר אותן.`
              : 'כאן יופיע כל דיווח על משהו שנשבר, דולף או לא עובד — מה דווח, באיזו יחידה, מי דיווח ומי לקח את הטיפול. כל אחד בצוות יכול לדווח, גם מי שאינו רואה את הרשימה הזו.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/incidents" variant="secondary">
                נקה סינון
              </Button>
            ) : mayReport ? (
              <Button href="/incidents/new">דווח על תקלה</Button>
            ) : null
          }
        />
      ) : (
        <>
          {unhandled.length > 0 && (
            <p
              // `alert`: a reported fault nobody has taken is the state this
              // register exists to expose, and it is why somebody opened it.
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {unhandled.length === 1
                  ? 'תקלה אחת ללא מטפל'
                  : `${unhandled.length} תקלות ללא מטפל`}
              </span>{' '}
              — דווחו ואיש לא לקח אותן. תקלה שאיש לא לקח תימצא שוב על ידי האורח
              הבא.
            </p>
          )}

          <IncidentTable
            incidents={incidents}
            caption="התקלות שדווחו ונמצאות בטווח שלך, ממוינות לפי מועד היעד"
          />

          {incidents.length === OPERATIONS_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {OPERATIONS_PAGE_SIZE} התקלות הקרובות ביותר. צמצם את הסינון
              כדי לראות תקלות נוספות.
            </p>
          )}
        </>
      )}
    </div>
  )
}
