'use client'

/**
 * Opening a task, and reporting a fault.
 *
 * One component with two modes rather than two components, because the two
 * forms are the same seven fields with three of them fixed — and two copies of
 * a form is two places for a validation rule to disagree with the server's.
 * What differs is declared as props and nothing else:
 *
 *   · `mode="incident"` fixes the type to `maintenance`, drops the team and
 *     assignee controls, and speaks in the language of a person who has just
 *     found something broken.
 *   · `mode="task"` offers the type, the team and the due date, because whoever
 *     opens an ordinary task is planning work rather than reporting a problem.
 *
 * ── Nothing here decides anything ─────────────────────────────────────────
 *
 * The selects are filled from `listTaskTargets`, which is derived from the
 * membership's scope on the server. The *same* function refuses the submission
 * if the property or unit is not in it, so what is not offered is also not
 * accepted and a crafted POST gains nothing. The status is not a field at all:
 * a task is born `new` or `assigned` depending on whether somebody was named,
 * and offering `completed` would ask the database's stamping trigger to invent
 * a completion time for work nobody did.
 *
 * ── Duplicate submission, both halves ─────────────────────────────────────
 *
 * `useAsyncAction` refuses a second run synchronously, which covers the double
 * click. The idempotency key — generated once per form instance — covers what a
 * disabled button cannot: a retry after a timeout, a resubmitted request, a
 * flaky connection. The second request replays the first answer instead of
 * opening a second task. This matters more here than almost anywhere: a cleaner
 * on a weak signal pressing "דווח" twice must not create two identical faults
 * for somebody to triage.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  createTaskAction,
  reportIncidentAction,
} from '@/app/(app)/tasks/_lib/actions'
import type { TaskTargets } from '@/app/(app)/tasks/_lib/targets'
import { ActionError } from '@/components/booking/action-error'
import {
  TASK_PRIORITY_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import {
  TASK_PRIORITIES,
  TASK_TYPES,
  type TaskPriority,
  type TaskType,
} from '@/lib/contracts/states'
import type { SafeErrorBody } from '@/lib/errors'

/** The types an ordinary task may be opened as. `maintenance` is a fault. */
const OPENABLE_TYPES: readonly TaskType[] = TASK_TYPES

export function OpenTaskForm({
  mode,
  targets,
  /** Where to go afterwards. The board the new row will appear on. */
  destination,
}: {
  mode: 'task' | 'incident'
  targets: TaskTargets
  destination: string
}) {
  const router = useRouter()

  const [propertyId, setPropertyId] = useState(targets.properties[0]?.id ?? '')
  const [unitId, setUnitId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [assignedToUserId] = useState('')
  const [taskType, setTaskType] = useState<TaskType>(
    mode === 'incident' ? 'maintenance' : 'cleaning',
  )
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueOn, setDueOn] = useState('')

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [touched, setTouched] = useState(false)

  const submit = useAsyncAction<void>()

  /**
   * One key for the life of this form instance. Regenerated only when the
   * component remounts — which is what makes a resubmission of *this* report a
   * replay, while a genuinely new report gets a new key.
   */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])

  const unitsHere = targets.units.filter(
    (unit) => unit.propertyId === propertyId,
  )

  const issues: string[] = []
  if (propertyId.length === 0) issues.push('יש לבחור נכס.')
  if (title.trim().length < 2) {
    issues.push(
      mode === 'incident'
        ? 'כתוב במשפט אחד מה תקול.'
        : 'כתוב במשפט אחד מה צריך לעשות.',
    )
  }
  const ready = issues.length === 0

  if (targets.properties.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        אין נכס שאתה מגיע אליו, ולכן אין לאן לפתוח את העבודה. טווח ההרשאה שלך
        נקבע בחברות שלך בארגון — פנה למי שמנהל את ההרשאות.
      </p>
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (!ready || submit.pending) return

        setFailure(null)
        void submit.run(async () => {
          const action =
            mode === 'incident' ? reportIncidentAction : createTaskAction

          const result = await action({
            propertyId,
            unitId: unitId.length > 0 ? unitId : null,
            teamId: teamId.length > 0 ? teamId : null,
            assignedToUserId:
              assignedToUserId.length > 0 ? assignedToUserId : null,
            taskType: mode === 'incident' ? 'maintenance' : taskType,
            priority,
            title: title.trim(),
            description:
              description.trim().length > 0 ? description.trim() : null,
            dueOn: dueOn.length > 0 ? dueOn : null,
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          router.push(destination)
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="נכס" required>
          <Select
            value={propertyId}
            onChange={(event) => {
              setPropertyId(event.target.value)
              // The unit belongs to the property. Keeping a stale one would
              // send a pair the database's three-column key would refuse.
              setUnitId('')
            }}
          >
            {targets.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name ?? property.id}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="יחידה"
          description="השאר ריק אם זה שייך לנכס כולו — בריכה, גינה, חדר מכונות."
        >
          <Select
            value={unitId}
            onChange={(event) => setUnitId(event.target.value)}
          >
            <option value="">כל הנכס</option>
            {unitsHere.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={mode === 'incident' ? 'מה תקול' : 'מה צריך לעשות'}
          description="משפט אחד שאפשר לזהות לפיו את העבודה ברשימה."
          required
          error={touched && title.trim().length < 2 ? issues[0] : undefined}
          className="sm:col-span-2"
        >
          <TextInput
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={
              mode === 'incident'
                ? 'למשל: הברז במקלחת של סוויטת הזית דולף'
                : 'למשל: החלפת מצעים בבקתה'
            }
          />
        </Field>

        {mode === 'task' && (
          <Field label="סוג">
            <Select
              value={taskType}
              onChange={(event) => setTaskType(event.target.value as TaskType)}
            >
              {OPENABLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TASK_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="עדיפות"
          description={
            mode === 'incident'
              ? 'קריטית היא תקלה שמונעת מאורח להיכנס או להישאר.'
              : undefined
          }
        >
          <Select
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TASK_PRIORITY_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        {mode === 'task' && targets.teams.length > 0 && (
          <Field
            label="צוות אחראי"
            description="הצוות שהעבודה תופיע אצלו. אפשר להשאיר ריק."
          >
            <Select
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">ללא צוות</option>
              {targets.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'task' && (
          <Field label="מועד" description="היום שבו העבודה אמורה להסתיים.">
            <TextInput
              type="date"
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </Field>
        )}

        <Field
          label="פירוט"
          description={
            mode === 'incident'
              ? 'מה בדיוק קורה, ממתי, והאם זה מונע שימוש ביחידה.'
              : 'כל מה שמי שיבצע צריך לדעת לפני שהוא מגיע.'
          }
          className="sm:col-span-2"
        >
          <Textarea
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>

      {failure && <ActionError error={failure} />}

      {touched && !ready && (
        <ul className="flex flex-col gap-1 text-sm text-danger" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submit.pending}>
          {submit.pending
            ? 'שולח…'
            : mode === 'incident'
              ? 'דווח על התקלה'
              : 'פתח משימה'}
        </Button>
        <Button href={destination} variant="ghost">
          ביטול
        </Button>
        <span aria-live="polite" className="sr-only">
          {submit.pending ? 'שולח את הטופס' : ''}
        </span>
      </div>
    </form>
  )
}
