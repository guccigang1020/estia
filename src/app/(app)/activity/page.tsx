import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonthYear, PROPERTY_TIME_ZONE } from '@/lib/booking/dates'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireActivityAccess } from './_lib/access'
import {
  ACTIVITY_PAGE_SIZE,
  byDay,
  listAuditEvents,
  listBookingTransitions,
  mergeActivity,
  type ActivityArgs,
  type ActivityEntry,
} from './_lib/queries'

export const metadata: Metadata = { title: 'פעילות אחרונה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What has happened here lately.
 *
 * WHAT IS ON THIS SCREEN. Two records, merged by time and labelled by source
 * on every row: `audit_events`, the trail the product writes as operations run,
 * and `booking_status_history`, the booking domain's own append-only log of
 * transitions. They have different completeness guarantees, so the label is not
 * decoration — a reader must be able to tell an audited event from a status
 * change, because only one of the two claims to be a complete record of what
 * was done.
 *
 * WHAT IS NEVER SHOWN. `audit_events.before` and `audit_events.after` are open
 * jsonb snapshots of arbitrary rows and are not even fetched — see the header
 * of `_lib/queries.ts`. What is rendered is `summary`, the sentence the writer
 * composed for a human, and `reason` where the action required one.
 *
 * GATING. `requireActivityAccess` admits on `booking.view` **or** `audit.view`
 * — two records, two grants. Each list asks `holdsGrant` for its own before it
 * queries, and the screen says which of the two it is not showing this reader
 * rather than silently rendering a shorter feed. `audit_events_select` and
 * `booking_status_history`'s policy refuse independently underneath.
 *
 * AN EMPTY TRAIL IS A FACT. In demo mode `audit_events` is seeded as an empty
 * array on purpose, because an audit trail nobody performed is fiction. The
 * screen says so in those words rather than rendering a blank that looks like a
 * failure — and a failure, when there is one, is rendered as a failure.
 */
export default async function ActivityPage() {
  const access = await requireActivityAccess()
  const { actor, organizationId, propertyId, propertyName } = access

  const db = await createClient()
  const args: ActivityArgs = { db, actor, organizationId, propertyId }

  const [audit, transitions] = await Promise.all([
    settle(() => listAuditEvents(args)),
    settle(() => listBookingTransitions(args)),
  ])

  const entries = mergeActivity([
    audit.ok ? audit.value : null,
    transitions.ok ? transitions.value : null,
  ])

  const days = byDay(entries)

  const maySeeAudit = holdsGrant(actor, 'audit.view')
  const maySeeBookings = holdsGrant(actor, 'booking.view')

  return (
    <ScreenFrame
      title="פעילות אחרונה"
      lead={
        propertyName
          ? `מה נעשה לאחרונה ב״${propertyName}״, לפי שתי הרשומות שהמוצר כותב.`
          : 'מה נעשה לאחרונה בארגון, לפי שתי הרשומות שהמוצר כותב — ורק במה שאתה רשאי לראות.'
      }
      banner={
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">יומן הביקורת</span>{' '}
            הוא הרשומה הרשמית: מי עשה מה, מתי, ומאיזה טעם. הוא נשמר גם אחרי
            שהחשבון נמחק.{' '}
            <span className="font-semibold text-foreground">
              מעברי סטטוס של הזמנות
            </span>{' '}
            הם יומן של מודול ההזמנות בלבד — הוא שלם לגבי הזמנות ושותק לגבי כל
            השאר.
          </p>
          <p>
            תמונות ה־before/after של יומן הביקורת אינן נשלפות כלל למסך הזה: הן
            מכילות עמודות שרירותיות מכל טבלה, ואין כלל שדות שאפשר לכתוב מעל צורה
            פתוחה.
          </p>
        </div>
      }
    >
      {!maySeeAudit && (
        <PanelNote>
          יומן הביקורת סגור לך — הוא דורש{' '}
          <span dir="ltr" className="font-mono text-xs">
            audit.view
          </span>
          . מה שמופיע כאן הוא מעברי הסטטוס של ההזמנות בלבד, ולא כל מה שנעשה
          בארגון.
        </PanelNote>
      )}
      {!maySeeBookings && (
        <PanelNote>
          מעברי הסטטוס של ההזמנות סגורים לך — הם דורשים{' '}
          <span dir="ltr" className="font-mono text-xs">
            booking.view
          </span>
          .
        </PanelNote>
      )}

      {!audit.ok && <ActionError error={audit.error} />}
      {!transitions.ok && <ActionError error={transitions.error} />}

      {audit.ok && audit.value !== null && audit.value.length === 0 && (
        <PanelNote>
          יומן הביקורת ריק. הוא אינו נזרע מראש ואינו מיובא — המוצר כותב אליו
          שורה בכל פעולה שמתבצעת בפועל, ולכן יומן ריק פירושו שעדיין לא בוצעה
          פעולה שנרשמת, ולא שמשהו נכשל.
        </PanelNote>
      )}

      {days.length === 0 ? (
        audit.ok &&
        transitions.ok &&
        (audit.value !== null || transitions.value !== null) ? (
          <PanelNote>אין פעילות רשומה בטווח שאתה רואה.</PanelNote>
        ) : null
      ) : (
        days.map(({ day, entries: group }) => (
          // One panel per property-local day. The source is labelled on each
          // row rather than in the heading, because a day mixes both.
          <Panel key={day} title={formatDayMonthYear(day)} count={group.length}>
            <RowList>
              {group.map((entry) => (
                <ActivityRow
                  key={`${entry.source}-${entry.id}`}
                  entry={entry}
                />
              ))}
            </RowList>
          </Panel>
        ))
      )}

      {entries.length === ACTIVITY_PAGE_SIZE && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          מוצגות {ACTIVITY_PAGE_SIZE} הרשומות האחרונות. יש קודמות — הרשימה נעצרת
          כאן ולא נגמרת כאן.
        </p>
      )}
    </ScreenFrame>
  )
}

/* ------------------------------------------------------------- plumbing -- */

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof toSafeResponse>['error'] }

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

/* ----------------------------------------------------------------- rows -- */

const SOURCE_LABEL = {
  audit: 'יומן ביקורת',
  booking_status: 'מעבר סטטוס',
} as const

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone={entry.source === 'audit' ? 'brand' : 'neutral'}>
            {SOURCE_LABEL[entry.source]}
          </Badge>
          {entry.source === 'booking_status' && entry.toStatus && (
            <span className="flex flex-wrap items-baseline gap-1.5">
              {entry.fromStatus ? (
                <BookingStatusBadge status={entry.fromStatus} />
              ) : (
                <Badge tone="neutral">נפתחה</Badge>
              )}
              <span aria-hidden="true" className="text-muted-foreground">
                ←
              </span>
              <BookingStatusBadge status={entry.toStatus} />
            </span>
          )}
          <span className="font-semibold text-foreground">{entry.summary}</span>
        </div>

        {entry.reason && (
          <p className="text-sm text-foreground">טעם: {entry.reason}</p>
        )}

        <p className="text-sm text-muted-foreground">
          {entry.actorLabel ?? 'משתמש שאינו זמין לצפייה'}
          {entry.actorType && entry.actorType !== 'user'
            ? ` (${entry.actorType})`
            : ''}{' '}
          · <span dir="ltr">{timeOf(entry.occurredAt)}</span> ·{' '}
          <span dir="ltr" className="font-mono text-xs">
            {entry.resourceType}
          </span>
        </p>
      </div>

      {entry.source === 'booking_status' && entry.resourceId && (
        <Button
          href={`/bookings/${entry.resourceId}`}
          variant="ghost"
          size="sm"
        >
          לפתיחת ההזמנה
        </Button>
      )}
    </Row>
  )
}

/**
 * The wall-clock time at the property.
 *
 * The date is already the group heading, so the row shows only the hour — and
 * it is the *property's* hour, converted the same way the day was, rather than
 * the browser's or UTC's.
 */
function timeOf(instant: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    // `PROPERTY_TIME_ZONE`, not a literal and not the browser's: the day
    // heading above was computed against it too, and an hour rendered in a
    // different zone from the day it sits under is wrong for three hours a day.
    timeZone: PROPERTY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instant))
}
