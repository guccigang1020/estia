import type { Metadata } from 'next'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { Notice } from '@/components/management/notice'
import { PageHeader } from '@/components/management/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { hebrewMoment } from '../team/_lib/labels'
import {
  AUDIT_PAGE_SIZE,
  delegatedEvents,
  listAuditEvents,
  type AuditEventItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'יומן ביקורת' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The audit trail.
 *
 * ══ THIS SCREEN MUST NEVER INVENT A ROW ══════════════════════════════════
 *
 * The demo dataset seeds `audit_events` as an empty array, deliberately and
 * with a comment saying why: those rows are written by the product as it runs,
 * and seeding them would be seeding the output of the very code paths a demo
 * exists to exercise. An audit trail nobody performed is the one kind of
 * fiction a product like this cannot ship — a buyer who finds one fabricated
 * event has no reason to believe any of the others.
 *
 * So the empty state below is the honest render of an empty table, and the
 * test beside `_lib/queries.ts` drives this exact query over the demo dataset
 * to prove it returns `[]` rather than raising. "It renders empty" is a claim
 * that has to be checked, because the alternative — a mapper throwing on a
 * column nobody has ever seen populated — looks identical in a code review.
 *
 * ── Read only, because the database says so ───────────────────────────────
 *
 * There is no action on this screen and no write path behind it.
 * `audit_events` has no UPDATE or DELETE privilege for any role, including
 * `service_role`, and two statement-level triggers refuse both regardless. The
 * screen states that rather than leaving it to be inferred from the absence of
 * buttons: an absent button is a missing feature; a stated refusal is a
 * property of the record.
 *
 * ── The delegation column ─────────────────────────────────────────────────
 *
 * `on_behalf_of_user_id` is rendered as what it is — a delegated action —
 * because forging it was a real defect in this product's history. Until 0006
 * the insert policy guarded `actor_user_id` and not this column, so any member
 * could write "ESTIA changed the price, and the owner approved it" and the
 * trail would carry a signature that read exactly like a real one. Folding a
 * delegated event into an ordinary one on screen would undo the fix in the
 * only place a human ever looks.
 *
 * GATING. `requireGrant('audit.view')`, and nothing weaker. The trail carries
 * before and after values from across the whole organization, including money
 * and guest details that most roles are not entitled to — which is why reading
 * it is a permission rather than a consequence of membership.
 * `audit_events_select` requires the same grant independently.
 */
export default async function AuditPage() {
  const [actor, context] = await Promise.all([
    requireGrant('audit.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let events: readonly AuditEventItem[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    events = await listAuditEvents({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    })
  } catch (error) {
    // A trail that failed to load must never look like a trail with nothing in
    // it. Those are opposite statements, and on this screen the difference is
    // the difference between "no one has done anything" and "we cannot show
    // you what was done".
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const delegated = delegatedEvents(events)
  const atCeiling = events.length === AUDIT_PAGE_SIZE

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="יומן ביקורת"
        lede="מי עשה מה, מתי, ובשם מי. כל שורה נכתבת בתוך אותה טרנזקציה שביצעה את הפעולה עצמה — פעולה שהצליחה בלי רישום נחשבת לכישלון של שתיהן."
      />

      <Notice title="הרשומה הזאת אינה ניתנת לעריכה" tone="strong">
        ל-<code dir="ltr">audit_events</code> אין הרשאת UPDATE ואין הרשאת DELETE
        לאף תפקיד — גם לא ל-<code dir="ltr">service_role</code> — ושני טריגרים
        ברמת ההוראה מסרבים לשתיהן בכל מקרה. אין לטבלה עמודת{' '}
        <code dir="ltr">version</code> ואין לה <code dir="ltr">updated_at</code>
        , כי אין דבר שיעדכן אותן. אין במסך הזה כפתור פעולה, ולא בגלל שלא הספיקו
        להוסיף אותו.
      </Notice>

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : events.length === 0 ? (
        <EmptyState
          illustration="invoice"
          title="עוד לא נרשמה אף פעולה"
          body="יומן הביקורת נכתב על ידי המוצר תוך כדי עבודה: כל הזמנה שנפתחת, כל תשלום שנקלט וכל הרשאה שמשתנה מוסיפים לו שורה. הוא ריק כי עוד לא בוצעה פעולה שראויה לתיעוד — ולא כי משהו לא נטען. שורה שלא בוצעה לא תופיע כאן לעולם."
        />
      ) : (
        <>
          {delegated.length > 0 && (
            <Notice title="פעולות שבוצעו בשם מישהו">
              {delegated.length === 1
                ? 'שורה אחת ברשימה נושאת חתימת האצלה'
                : `${delegated.length} שורות ברשימה נושאות חתימת האצלה`}
              : מישהו או משהו ביצע את הפעולה, ואדם אחר ביקש או אישר אותה. אלה
              מסומנות במפורש ולא מוצגות כפעולה רגילה.
            </Notice>
          )}

          <ol className="flex flex-col gap-3">
            {events.map((event) => (
              <li key={event.id}>
                <AuditEntry event={event} />
              </li>
            ))}
          </ol>

          {atCeiling && (
            <p className="text-sm text-muted-foreground">
              מוצגות {AUDIT_PAGE_SIZE} השורות האחרונות. היומן ארוך מזה — הרשימה
              נעצרה בתקרה ולא בסופו.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

/**
 * One event.
 *
 * An `<article>` rather than a table row: an event has a sentence, an actor, a
 * resource and two optional JSON payloads, and cramming that into cells makes
 * the sentence — the part a person actually reads — the narrowest column.
 */
function AuditEntry({ event }: { event: AuditEventItem }) {
  const changed = changedKeys(event.before, event.after)

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
            {event.propertyName ? ` · ${event.propertyName}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={event.actorType === 'user' ? 'neutral' : 'accent'}>
            <span dir="ltr" className="font-mono text-[0.6875rem]">
              {event.actorType}
            </span>
          </Badge>
          <Badge tone="neutral">
            <span dir="ltr" className="font-mono text-[0.6875rem]">
              {event.action}
            </span>
          </Badge>
        </div>
      </div>

      {/* The delegation. Never folded into the actor line above: "who did it"
          and "who asked for it" are two facts, and the second one is the one
          somebody disputes. */}
      {event.onBehalfOfUserId !== null && (
        <p className="rounded-lg border border-primary bg-primary-soft px-3 py-2 text-xs text-primary">
          פעולה שבוצעה בהאצלה —{' '}
          {event.onBehalfOfName ?? 'אדם שהפרופיל שלו אינו קריא לך'} ביקש או אישר
          אותה. חתימת ההאצלה נבדקת במסד הנתונים עצמו: אי אפשר לרשום אישור בשמו
          של אדם אחר.
        </p>
      )}

      {event.reason && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">נימוק שנמסר:</span>{' '}
          {event.reason}
        </p>
      )}

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1.5">
          <dt>משאב</dt>
          <dd dir="ltr" className="font-mono text-foreground">
            {event.resourceType}
            {event.resourceId ? `/${event.resourceId}` : ''}
          </dd>
        </div>
        {event.requestId && (
          <div className="flex gap-1.5">
            <dt>מזהה בקשה</dt>
            <dd dir="ltr" className="font-mono text-foreground">
              {event.requestId}
            </dd>
          </div>
        )}
      </dl>

      {changed.length > 0 && (
        <details>
          <summary className="cursor-pointer list-none text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {changed.length === 1
              ? 'הצגת השדה שהשתנה'
              : `הצגת ${changed.length} השדות שהשתנו`}
          </summary>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">
                השדות שהשתנו בפעולה, לפני ואחרי
              </caption>
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
 * The union of the keys in the two payloads.
 *
 * `diffFields` already reduced whole records to what differed before the row
 * was written, so both objects normally carry the same keys — but a create has
 * only `after` and a delete has only `before`, and taking the union is what
 * renders those correctly instead of showing an empty table.
 */
function changedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): readonly string[] {
  return [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ].sort()
}

/**
 * A stored value, as text.
 *
 * `undefined` means the key is absent from that side — a field that was
 * created or removed — and it is rendered as an em dash. `null` is a stored
 * value and is rendered as the word, because "was set to null" and "was not in
 * this payload" are different facts about a change somebody may be disputing.
 */
function renderValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
