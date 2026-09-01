/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The guest journey, from the desk.
 *
 * ── Mount this on the booking detail screen ───────────────────────────────
 *
 *     import { GuestJourneyTab } from '@/components/guest/journey-tab'
 *     …
 *     <GuestJourneyTab bookingId={booking.id} actor={actor} />
 *
 * It is a component rather than a route because it belongs INSIDE the booking,
 * beside the price and the status — a separate page for "did the guest open
 * the link" is a page nobody opens. `src/app/(app)/bookings/**` belongs to
 * another worker this wave, so the one line above is the coordinator's to add.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * "Sent and never opened" against "opened three times and still not
 * confirmed". Two different problems, two different actions — a wrong number
 * versus a guest with an unasked question — and the pair of timestamps 0033
 * added exists precisely so a person can tell them apart at a glance. That
 * distinction leads the card, above every other fact.
 *
 * ── Only the steps that apply ─────────────────────────────────────────────
 *
 * The same rule as the guest's own progress list. A business with no contract
 * gets no contract row here either: an operations screen showing "חוזה: לא
 * נחתם" for a business that has no contract is a permanent false alarm, and
 * the third time somebody chases it they stop reading the card.
 */

import { SendPanel } from '@/components/guest/send-panel'
import { Badge } from '@/components/ui/badge'
import type { Actor } from '@/lib/authz/can'
import { can } from '@/lib/authz/can'
import { formatDayMonthYear } from '@/lib/booking/dates'
import { GUEST_LINK_CHANNEL_LABEL } from '@/lib/guest-journey/types'
import type { AdminJourneyView } from '@/lib/guest-journey/admin-view'

function when(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  }).format(date)
}

/**
 * One line of the journey.
 *
 * `done` carries a date, `waiting` carries what is being waited for. Neither
 * is ever a bare colour: an operations screen read at a glance on a laptop in
 * a lobby has to survive being read badly.
 */
function Line({
  label,
  at,
  waitingLabel,
  tone = 'neutral',
}: {
  label: string
  at: string | null
  waitingLabel: string
  tone?: 'neutral' | 'warn'
}) {
  const stamp = when(at)

  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {stamp ? (
        <span className="text-end text-sm font-medium text-foreground">
          {stamp}
        </span>
      ) : (
        <span
          className={
            tone === 'warn'
              ? 'text-end text-sm font-medium text-warning'
              : 'text-end text-sm text-muted-foreground'
          }
        >
          {waitingLabel}
        </span>
      )}
    </div>
  )
}

export function GuestJourneyTab({
  view,
  actor,
  guestLink,
  organizationName,
  propertyName,
  checkIn,
  checkOut,
  /** Which steps this business actually requires. Omit a step, omit its line. */
  requires,
}: {
  view: AdminJourneyView
  actor: Actor
  guestLink: string
  organizationName: string
  propertyName: string | null
  checkIn: string
  checkOut: string
  requires: {
    confirmation: boolean
    contract: boolean
    details: boolean
  }
}) {
  const opened = view.firstOpenedAt !== null

  // The headline distinction. Everything else on the card is detail.
  const headline = view.revokedAt
    ? { text: 'הקישור בוטל', tone: 'neutral' as const }
    : view.sentAt === null
      ? { text: 'הקישור עוד לא נשלח', tone: 'warn' as const }
      : !opened
        ? { text: 'נשלח — ועדיין לא נפתח', tone: 'warn' as const }
        : requires.confirmation && view.confirmedAt === null
          ? { text: 'נפתח — ועדיין לא אושר', tone: 'warn' as const }
          : { text: 'האורח בתהליך', tone: 'neutral' as const }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-xl font-bold text-foreground">
          מסע האורח
        </h2>
        <Badge tone={headline.tone === 'warn' ? 'accent' : 'neutral'}>
          {headline.text}
        </Badge>
      </div>

      <dl className="flex flex-col rounded-xl border border-border bg-surface px-4 py-1">
        <Line
          label="הקישור נשלח"
          at={view.sentAt}
          waitingLabel="טרם נשלח"
          tone="warn"
        />
        <Line
          label="נפתח לראשונה"
          at={view.firstOpenedAt}
          waitingLabel={view.sentAt ? 'עדיין לא נפתח' : '—'}
          tone={view.sentAt ? 'warn' : 'neutral'}
        />
        {/* Only useful once it differs from the first open — otherwise it is a
            duplicate row on a card that has to be read quickly. */}
        {view.lastOpenedAt && view.lastOpenedAt !== view.firstOpenedAt && (
          <Line label="נפתח לאחרונה" at={view.lastOpenedAt} waitingLabel="—" />
        )}

        {requires.confirmation && (
          <Line
            label="האורח אישר"
            at={view.confirmedAt}
            waitingLabel={opened ? 'ממתין לאישור' : 'טרם'}
            tone={opened ? 'warn' : 'neutral'}
          />
        )}

        {requires.contract && (
          <Line
            label="חוזה נחתם"
            at={view.contractSignedAt}
            waitingLabel="ממתין לחתימה"
            tone="warn"
          />
        )}

        {requires.details && (
          <Line
            label="פרטי אורחים"
            at={view.detailsSubmittedAt}
            waitingLabel="חסרים"
            tone="warn"
          />
        )}

        {view.manualReleasedAt && (
          <Line
            label="פרטי הגעה שוחררו ידנית"
            at={view.manualReleasedAt}
            waitingLabel="—"
          />
        )}

        {view.checkoutDeclaredAt && (
          <Line
            label="האורח הצהיר שיצא"
            at={view.checkoutDeclaredAt}
            waitingLabel="—"
          />
        )}

        {view.totalRequests > 0 && (
          <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
            <span className="text-sm text-muted-foreground">בקשות אורח</span>
            <span className="text-end text-sm font-medium text-foreground">
              {view.openRequests > 0
                ? `${view.openRequests} פתוחות מתוך ${view.totalRequests}`
                : `${view.totalRequests} — כולן טופלו`}
            </span>
          </div>
        )}
      </dl>

      {!view.journeyTablesReady && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        >
          אישור, חתימה ובקשות אינם זמינים עדיין במסד הנתונים הזה. נתוני השליחה
          והפתיחה מלאים.
        </p>
      )}

      {view.sends.length > 0 && (
        <details className="rounded-xl border border-border bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            היסטוריית שליחות ({view.sends.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {view.sends.map((send) => (
              <li
                key={send.id}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <span className="text-foreground">
                  {GUEST_LINK_CHANNEL_LABEL[send.channel]}
                  {send.recipientMasked && (
                    <span
                      dir="ltr"
                      className="ms-2 font-mono text-muted-foreground"
                    >
                      {send.recipientMasked}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {when(send.sentAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="rounded-xl border border-border bg-surface px-4 py-4">
        <SendPanel
          bookingId={view.bookingId}
          guestLink={guestLink}
          guestFirstName={view.guestName?.split(' ')[0] ?? null}
          guestPhone={view.guestPhone}
          guestEmail={view.guestEmail}
          organizationName={organizationName}
          propertyName={propertyName}
          checkIn={formatDayMonthYear(checkIn)}
          checkOut={formatDayMonthYear(checkOut)}
          sendCount={view.sendCount}
          revokedAt={view.revokedAt}
          canSend={can(actor, 'message.send', {
            organizationId: actor.organizationId,
          })}
          canManage={can(actor, 'booking.update', {
            organizationId: actor.organizationId,
          })}
        />
      </div>
    </div>
  )
}
