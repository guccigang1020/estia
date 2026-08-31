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
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../../_lib/guard'
import {
  NO_TARGETS,
  listTaskTargets,
  type TaskTargets,
} from '../../tasks/_lib/targets'

export const metadata: Metadata = { title: 'דיווח על תקלה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Reporting a fault.
 *
 * ── The narrowest door in the product, and it is meant to be wide ─────────
 *
 * `requireGrant('incident.create')` and nothing else. A cleaner holds this
 * grant and holds `incident.view` — the register — not at all, so this page is
 * the whole of her incidents module. She reaches it from the sidebar, from the
 * "+" menu, and from `/incidents` itself, which redirects nobody and instead
 * explains that the register is not hers.
 *
 * ── Where she may report ─────────────────────────────────────────────────
 *
 * `listTaskTargets` derives the properties and units from the tasks she already
 * holds, because her membership is scoped to a team and a *property* carries no
 * team for `scopeReaches` to match on. Nothing is read that she could not
 * already read on `/tasks`, and `reportIncidentAction` re-derives exactly the
 * same set before it writes — so a crafted POST naming a property she does not
 * work in is refused with a sentence rather than a database constraint.
 *
 * ── What happens to the report ───────────────────────────────────────────
 *
 * It becomes a `maintenance` task, because there is no `public.incidents` table
 * — see `tasks/_lib/queries.ts`. It carries no team, which is deliberate: a
 * fault nobody has triaged has no responsible team yet, and inventing one would
 * put it on a board somebody would then assume was watching it. It publishes
 * `incident.opened`, which is in `ALERT_EVENTS` — the list of things a person is
 * meant to be told about.
 */
export default async function NewIncidentPage() {
  const actor = await requireGrant('incident.create')

  let targets: TaskTargets = NO_TARGETS
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    targets = await listTaskTargets(db, actor)
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  // Somebody who may read the register goes back to it; somebody who may not
  // goes back to their own work. An offered link that redirects is worse than
  // no link.
  const destination = holdsGrant(actor, 'incident.view')
    ? '/incidents'
    : '/tasks'

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href={destination}
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {destination === '/incidents'
            ? '← חזרה לרשימת התקלות'
            : '← חזרה למשימות שלי'}
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          דיווח על תקלה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          כל דבר שנשבר, דולף, לא עובד או חסר. הדיווח נפתח כעבודת תחזוקה ומופיע
          למי שאחראי לטפל בה — גם אם רשימת התקלות עצמה אינה פתוחה לך.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle as="h2">מה קרה</CardTitle>
          <CardDescription>
            אין צורך לדעת מי אמור לתקן. הדיווח נפתח בלי צוות אחראי, ומי שמנהל את
            התחזוקה משייך אותו. עדיף לדווח פעמיים מאשר לא לדווח.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <ActionError error={failure.error} />
          ) : (
            <OpenTaskForm
              mode="incident"
              targets={targets}
              destination={destination}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
