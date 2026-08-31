import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { OpenTaskForm } from '@/components/operations/open-task-form'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../../_lib/guard'
import { NO_TARGETS, listTaskTargets, type TaskTargets } from '../_lib/targets'

export const metadata: Metadata = { title: 'משימה חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Opening a task.
 *
 * GATING. `requireGrant('task.create')` refuses the route outright, and
 * `createTaskAction` refuses again with `assertCan` before it reads a row — so
 * reaching this URL without the grant lands on the dashboard with the missing
 * grant named, and posting the action directly is refused regardless.
 *
 * WHAT THE FORM IS GIVEN. The properties, units and teams this membership
 * demonstrably reaches, from `listTaskTargets`. The action re-derives the same
 * set and refuses anything outside it, so the `<select>` is a convenience and
 * not the control — what is not offered is also not accepted.
 *
 * WHAT IS NOT A FIELD. The status. A task is born `new` when nobody is named
 * and `assigned` when somebody is, and the database stamps every later moment
 * from the transition that caused it. A status picker here would let somebody
 * open a task that claims to be finished, and the stamping trigger would then
 * have to invent a completion time for work nobody did.
 */
export default async function NewTaskPage() {
  const actor = await requireGrant('task.create')

  let targets: TaskTargets = NO_TARGETS
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    targets = await listTaskTargets(db, actor)
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/tasks"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת המשימות
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          משימה חדשה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          משימות ניקיון והכנה נפתחות מעצמן לפי היציאות וההגעות. הטופס הזה הוא
          לעבודה חד-פעמית שאיש לא הזמין — תיקון, ביקורת, בקשה של אורח או ספירת
          מלאי.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">פרטי העבודה</CardTitle>
          <CardDescription>
            הסטטוס אינו שדה. משימה נפתחת כ״חדשה״, וכשמוקצה לה אחראי היא הופכת
            ל״הוקצתה״ — כדי שלא יהיה מצב שרשום ״הושלמה״ בלי שמישהו עשה משהו.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <ActionError error={failure.error} />
          ) : (
            <OpenTaskForm mode="task" targets={targets} destination="/tasks" />
          )}
        </div>
      </Card>
    </div>
  )
}
