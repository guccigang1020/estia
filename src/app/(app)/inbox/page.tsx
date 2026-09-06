import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import {
  TaskPriorityBadge,
  TaskStatusBadge,
} from '@/components/preparation/task-status'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDayMonth, localDate } from '@/lib/booking/dates'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  INBOX_PAGE_SIZE,
  MISSING_MESSAGING_TABLES,
  listGuestNotes,
  listInternalNotes,
  listRequestTasks,
  type GuestNote,
  type InboxArgs,
  type InternalNote,
  type RequestTask,
} from './_lib/queries'

export const metadata: Metadata = { title: 'תיבת פניות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Guest and team correspondence.
 *
 * ══ WHAT THIS SCREEN IS NOT ═══════════════════════════════════════════════
 *
 * It is not a mailbox, because the product has no messaging tables. The report
 * at the top of the page says so by name, and `_lib/queries.ts` sets out the
 * whole argument. The one thing this screen refuses to do is render
 * `ModuleEmptyState module="messages"` — that preset says "אין שיחות פתוחות"
 * and describes a WhatsApp-and-email inbox that does not exist, which would
 * tell a reader the feature works and this business has simply had no
 * conversations. Both halves are false.
 *
 * WHAT IT SHOWS INSTEAD is three lists of real rows, each labelled as what it
 * actually is: a guest's own words recorded on their booking, a guest request
 * that somebody turned into a job, and a note the team left itself. Only the
 * second is assignable, and it is assignable because `task_assignments` and
 * `task.assign` exist — `message.assign` has nothing to write to, and the
 * screen offers no control that pretends otherwise.
 *
 * GATING. `requireGrant('message.view')` refuses the route — the honest gate,
 * because it is the right a business would give somebody to read guest
 * correspondence. Each list then asks for its own: a guest's words need
 * `guest.view_name` because they are guest data wherever the column sits, a
 * team note needs `booking.note.internal`, work needs `task.view`. Each row is
 * checked again with `can()` against its property, and row level security
 * refuses underneath all of it.
 */
export default async function InboxPage() {
  const [actor, context] = await Promise.all([
    requireGrant('message.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const today = localDate(new Date())
  const db = await createClient()
  const args: InboxArgs = {
    db,
    actor,
    organizationId: actor.organizationId,
    propertyId,
  }

  const [guestNotes, requests, internalNotes] = await Promise.all([
    settle(() => listGuestNotes(args, today)),
    settle(() => listRequestTasks(args)),
    settle(() => listInternalNotes(args, today)),
  ])

  return (
    <ScreenFrame
      title="תיבת פניות"
      lead={
        propertyName
          ? `כל מה שאורח או חבר צוות כתב, ושמור אצלנו, עבור ״${propertyName}״.`
          : 'כל מה שאורח או חבר צוות כתב ושמור אצלנו — ורק במה שאתה רשאי לראות.'
      }
      banner={
        <DomainGap
          title="עמוד השדרה של השיחות נבנה — המסך עדיין קורא את המקורות הישנים"
          body={
            <>
              <p>
                מיגרציה 0063 יצרה את חוט השיחה:{' '}
                <span dir="ltr" className="font-mono text-xs">
                  conversations
                </span>
                , שתי המסירות של הודעה ומצב ״נקרא״ לכל אדם בנפרד. הכלל המרכזי שם
                הוא שהודעה יוצאת אינה נושאת טקסט משלה אלא מפנה לשורה ב־
                <span dir="ltr" className="font-mono text-xs">
                  guest_messages
                </span>
                , כדי שלא יהיו שתי תשובות לשאלה מה נאמר לאורח.
              </p>
              <p className="mt-2">
                מה שעדיין אין הוא השכבה שמריצה את זה — מתאם, פעולות ומסך שיחה —
                ולכן המסך הזה עדיין מציג את שלוש הרשימות הישנות ולא חוטי שיחה.
                וגם כאן לא יוצג ״אין שיחות פתוחות״: המשפט הזה יהיה נכון רק
                כשמשהו באמת יוכל להגיע לתיבה.
              </p>
              <p className="mt-2">
                מה שמוצג למטה הוא שלוש רשימות של רשומות אמיתיות, כל אחת בשמה:
                מילים של האורח ששמורות על ההזמנה, בקשת אורח שהפכה למשימה, והערה
                פנימית שהצוות השאיר לעצמו. רק השנייה ניתנת להקצאה מכאן — כי{' '}
                <span dir="ltr" className="font-mono text-xs">
                  task_assignments
                </span>{' '}
                קיימת. <GrantCode>message.assign</GrantCode> כבר אינה ריקה — יש
                לה{' '}
                <span dir="ltr" className="font-mono text-xs">
                  conversations.assigned_to_user_id
                </span>{' '}
                לכתוב אליו — אבל אין עדיין מסך שמפעיל אותה.
              </p>
            </>
          }
          missingTables={MISSING_MESSAGING_TABLES}
          alreadyBuilt={[
            <>
              ההרשאות <GrantCode>message.view</GrantCode> ·{' '}
              <GrantCode>message.send</GrantCode> ·{' '}
              <GrantCode>message.assign</GrantCode> ·{' '}
              <GrantCode>template.manage</GrantCode>
            </>,
            <>
              נוסח מצב־ריק מוכן ל״שיחות״ ב־
              <span dir="ltr" className="font-mono text-xs">
                empty-presets.ts
              </span>{' '}
              — מכוון שאינו בשימוש כאן, כי הוא היה משקר
            </>,
            <>
              הקצאה אמיתית לעבודה:{' '}
              <span dir="ltr" className="font-mono text-xs">
                task_assignments
              </span>{' '}
              ו־<GrantCode>task.assign</GrantCode>
            </>,
            <>
              שדות טקסט חופשי שכבר נשמרים על ההזמנה:{' '}
              <span dir="ltr" className="font-mono text-xs">
                guest_notes
              </span>
              ,{' '}
              <span dir="ltr" className="font-mono text-xs">
                internal_notes
              </span>
            </>,
          ]}
        />
      }
    >
      {/* ------------------------------------------------- guest requests -- */}
      <Panel
        title="מה שהאורח כתב על ההזמנה"
        description="המילים של האורח עצמו, כפי שנרשמו כשההזמנה נלקחה. אין לזה חותמת זמן משלו — התאריך שמוצג הוא מועד פתיחת ההזמנה."
        count={
          guestNotes.ok && guestNotes.value
            ? guestNotes.value.length
            : undefined
        }
      >
        {!guestNotes.ok ? (
          <ActionError error={guestNotes.error} />
        ) : guestNotes.value === null ? (
          <PanelNote>
            בקשות אורחים סגורות לך. הן מילים של האורח עצמו, ולכן הן נחשבות מידע
            אורח ודורשות <GrantCode>guest.view_name</GrantCode> נוסף על{' '}
            <GrantCode>booking.view</GrantCode> — גם כשהעמודה יושבת על ההזמנה.
          </PanelNote>
        ) : guestNotes.value.length === 0 ? (
          <PanelNote>
            אף אורח לא רשם בקשה על ההזמנות שבטווח שלך. זו תשובה אמיתית: העמודה
            קיימת וריקה, ולא חסרה.
          </PanelNote>
        ) : (
          <>
            <RowList>
              {guestNotes.value.map((note) => (
                <GuestNoteRow key={note.bookingId} note={note} />
              ))}
            </RowList>
            {guestNotes.value.length === INBOX_PAGE_SIZE && <AtCeiling />}
          </>
        )}
      </Panel>

      {/* ---------------------------------------------- requests as work -- */}
      <Panel
        title="בקשות אורח שהפכו למשימה"
        description="החלק היחיד במסך הזה שאפשר להקצות לאדם, והוא ניתן להקצאה כי הוא משימה — לא כי הוא הודעה."
        count={
          requests.ok && requests.value ? requests.value.length : undefined
        }
        action={
          <Button href="/preparation" variant="secondary" size="sm">
            לוח ההכנה
          </Button>
        }
      >
        {!requests.ok ? (
          <ActionError error={requests.error} />
        ) : requests.value === null ? (
          <PanelNote>
            משימות סגורות לך — נדרשת <GrantCode>task.view</GrantCode>.
          </PanelNote>
        ) : requests.value.length === 0 ? (
          <PanelNote>אין בקשת אורח פתוחה כמשימה בטווח שלך.</PanelNote>
        ) : (
          <RowList>
            {requests.value.map((task) => (
              <RequestRow key={task.id} task={task} />
            ))}
          </RowList>
        )}
      </Panel>

      {/* ------------------------------------------------ internal notes -- */}
      <Panel
        title="הערות פנימיות של הצוות"
        description="נכתבו מתוך ידיעה שהאורח לא יקרא אותן, ולכן הן הרשאה נפרדת ולא חלק מצפייה בהזמנה."
        count={
          internalNotes.ok && internalNotes.value
            ? internalNotes.value.length
            : undefined
        }
      >
        {!internalNotes.ok ? (
          <ActionError error={internalNotes.error} />
        ) : internalNotes.value === null ? (
          <PanelNote>
            הערות פנימיות סגורות לך — נדרשת{' '}
            <GrantCode>booking.note.internal</GrantCode>. זו הרשאה נפרדת בכוונה:
            צוות שרואה הזמנה אינו בהכרח צוות שרשאי לקרוא מה נכתב עליה פנימית.
          </PanelNote>
        ) : internalNotes.value.length === 0 ? (
          <PanelNote>לא נכתבה אף הערה פנימית על הזמנה שבטווח שלך.</PanelNote>
        ) : (
          <RowList>
            {internalNotes.value.map((note) => (
              <InternalNoteRow key={note.bookingId} note={note} />
            ))}
          </RowList>
        )}
      </Panel>
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

function AtCeiling() {
  return (
    <p
      role="status"
      className="mt-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
    >
      מוצגות {INBOX_PAGE_SIZE} השורות האחרונות. יש קודמות.
    </p>
  )
}

/* ----------------------------------------------------------------- rows -- */

function GuestNoteRow({ note }: { note: GuestNote }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold text-foreground">
            {note.guestName ?? note.reference}
          </span>
          <BookingStatusBadge status={note.status} />
          {!note.live && <Badge tone="neutral">שהייה שהסתיימה</Badge>}
        </div>
        <p className="text-sm text-foreground">{note.text}</p>
        <p className="text-sm text-muted-foreground">
          {formatDayMonth(note.checkIn)}–{formatDayMonth(note.checkOut)} · נרשם
          עם פתיחת ההזמנה ב־{formatDayMonth(note.writtenOn)}
        </p>
      </div>
      <Button href={`/bookings/${note.bookingId}`} variant="ghost" size="sm">
        {note.reference}
      </Button>
    </Row>
  )
}

function InternalNoteRow({ note }: { note: InternalNote }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold text-foreground">
            {note.reference}
          </span>
          <BookingStatusBadge status={note.status} />
        </div>
        <p className="text-sm text-foreground">{note.text}</p>
        <p className="text-sm text-muted-foreground">
          {formatDayMonth(note.checkIn)}–{formatDayMonth(note.checkOut)}
        </p>
      </div>
      <Button href={`/bookings/${note.bookingId}`} variant="ghost" size="sm">
        לפתיחת ההזמנה
      </Button>
    </Row>
  )
}

function RequestRow({ task }: { task: RequestTask }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <TaskStatusBadge status={task.status} />
          <TaskPriorityBadge priority={task.priority} />
          <span className="font-semibold text-foreground">{task.title}</span>
        </div>
        {task.description && (
          <p className="text-sm text-foreground">{task.description}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {task.assignedToUserId
            ? `הוקצתה ל־${task.assignedToName ?? 'משתמש שאינו פתוח לצפייה'}`
            : 'לא הוקצתה לאיש'}
          {task.dueOn ? ` · ליום ${formatDayMonth(task.dueOn)}` : ''}
        </p>
        {task.cancellationReason && (
          <p className="text-sm text-muted-foreground">
            בוטלה כי: {task.cancellationReason}
          </p>
        )}
      </div>
      {task.bookingId && (
        <Button href={`/bookings/${task.bookingId}`} variant="ghost" size="sm">
          לפתיחת ההזמנה
        </Button>
      )}
    </Row>
  )
}
