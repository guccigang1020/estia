import type { Metadata } from 'next'

import Link from 'next/link'

import {
  ConsoleNotice,
  ConsolePage,
} from '@/components/platform/console-chrome'
import { hebrewMoment } from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import {
  listPlatformAuditEvents,
  PLATFORM_AUDIT_PAGE_SIZE,
  type PlatformAuditEvent,
} from '@/lib/platform'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../_lib/guard'

export const metadata: Metadata = { title: 'יומן הפלטפורמה · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What ESTIA did, across every customer.
 *
 * ══ SEPARATE FROM ANY CUSTOMER'S — AS A FILTER, NOT AS A SECOND TABLE ═════
 *
 * These rows live in the customers' own `audit_events`, signed
 * `actor_type = 'platform_staff'`. That is the choice and it has a
 * consequence: the customer sees each of them in their own audit screen,
 * beside their own employees' rows. A separate platform-only table would have
 * been the version where somebody at ESTIA suspends an account and the
 * customer's trail says nothing happened.
 *
 * "Separate" is therefore enforced by the database rather than by the query
 * below: `audit_events_platform_select` (0041) admits a platform staff member
 * to rows where `actor_type = 'platform_staff'` and to no others. Deleting the
 * `.eq()` in `listPlatformAuditEvents` would not widen this page by one row.
 *
 * ── The asymmetry is deliberate ───────────────────────────────────────────
 *
 * The console can prove what ESTIA did. It cannot read what a customer's own
 * staff did — that needs `audit.view` inside their organization, which no
 * platform role holds and no platform staff member has a membership to hold it
 * with. A support console that could read every customer's whole audit trail
 * is a console that eventually does.
 *
 * ── This page cannot edit or delete a row, and neither can anyone ─────────
 *
 * `audit_events` has no UPDATE and no DELETE privilege for any role —
 * including `service_role` — and two statement-level triggers refuse both
 * regardless. There is no button here, and not because one was left out.
 *
 * GATING. `platform.organization.view`. A support colleague may read what the
 * platform did, which is the point of an accountable back office.
 */
export default async function PlatformAuditPage() {
  await requirePlatformGrant('platform.organization.view')

  const correlationId = crypto.randomUUID()
  let events: readonly PlatformAuditEvent[] = []
  let failure: unknown = null

  try {
    events = await listPlatformAuditEvents(await createClient())
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const atCeiling = events.length === PLATFORM_AUDIT_PAGE_SIZE

  return (
    <ConsolePage
      title="יומן הפלטפורמה"
      lede="כל פעולה שצוות ESTIA ביצע, בכל לקוח. אותן שורות בדיוק מופיעות ביומן הביקורת של הלקוח עצמו."
    >
      <ConsoleNotice title="הרשומה הזאת אינה ניתנת לעריכה" tone="strong">
        ל-<code dir="ltr">audit_events</code> אין הרשאת UPDATE ואין הרשאת DELETE
        לאף תפקיד — גם לא ל-<code dir="ltr">service_role</code> — ושני טריגרים
        ברמת ההוראה מסרבים לשתיהן. אין במסך הזה כפתור פעולה, ולא בגלל שלא הספיקו
        להוסיף אותו.
      </ConsoleNotice>

      {failure !== null ? (
        <ConsoleNotice title="היומן לא נטען" tone="warning">
          מזהה מעקב: <code dir="ltr">{correlationId}</code>. יומן שלא נטען אינו
          יומן ריק, וההפרש בין השניים הוא ההפרש בין &quot;לא בוצעה פעולה&quot;
          לבין &quot;לא הצלחנו להראות מה בוצע&quot;.
        </ConsoleNotice>
      ) : events.length === 0 ? (
        <ConsoleNotice title="ESTIA עוד לא ביצעה אף פעולה">
          השורות כאן נכתבות על ידי הקונסולה תוך כדי עבודה: השהיית חשבון, החזרה
          לפעילות, שינוי יכולות, פתיחת צפייה. היומן ריק כי לא בוצעה פעולה — לא
          כי משהו לא נטען, ולא כי מישהו זרע אותו מראש.
        </ConsoleNotice>
      ) : (
        <>
          <ol className="flex flex-col gap-3">
            {events.map((event) => (
              <li key={event.id}>
                <PlatformAuditEntry event={event} />
              </li>
            ))}
          </ol>

          {atCeiling && (
            <p className="text-sm text-muted-foreground">
              מוצגות {PLATFORM_AUDIT_PAGE_SIZE} השורות האחרונות. היומן ארוך מזה
              — הרשימה נעצרה בתקרה ולא בסופו.
            </p>
          )}
        </>
      )}
    </ConsolePage>
  )
}

function PlatformAuditEntry({ event }: { event: PlatformAuditEvent }) {
  const changed = [
    ...new Set([
      ...Object.keys(event.before ?? {}),
      ...Object.keys(event.after ?? {}),
    ]),
  ].sort()

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-foreground">{event.summary}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {event.actorLabel}
            </span>
            {' · '}
            {hebrewMoment(event.occurredAt)}
            {' · '}
            <Link
              href={`/platform/organizations/${event.organizationId}`}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {event.organizationName}
            </Link>
          </p>
        </div>

        <Badge tone="accent">
          <span dir="ltr" className="font-mono text-[0.6875rem]">
            {event.action}
          </span>
        </Badge>
      </div>

      {event.reason && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">נימוק שנמסר:</span>{' '}
          {event.reason}
        </p>
      )}

      {changed.length > 0 && (
        <details>
          <summary className="cursor-pointer list-none text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {changed.length === 1
              ? 'הצגת השדה שהשתנה'
              : `הצגת ${changed.length} השדות שהשתנו`}
          </summary>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">השדות שהשתנו, לפני ואחרי</caption>
              <thead>
                <tr className="border-b border-border bg-muted">
                  <th
                    scope="col"
                    className="px-3 py-2 text-start font-semibold"
                  >
                    שדה
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-start font-semibold"
                  >
                    לפני
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-start font-semibold"
                  >
                    אחרי
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {changed.map((key) => (
                  <tr key={key}>
                    <th
                      scope="row"
                      className="px-3 py-2 text-start font-mono"
                      dir="ltr"
                    >
                      {key}
                    </th>
                    <td className="px-3 py-2 font-mono" dir="ltr">
                      {renderValue(event.before?.[key])}
                    </td>
                    <td className="px-3 py-2 font-mono" dir="ltr">
                      {renderValue(event.after?.[key])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  )
}

/**
 * A stored value, as text.
 *
 * `undefined` is a key absent from that side — created or removed — and is an
 * em dash. `null` is a stored value and is rendered as the word, because "was
 * set to null" and "was not in this payload" are different facts about a
 * change somebody may be disputing.
 */
function renderValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
