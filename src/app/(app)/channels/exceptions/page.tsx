import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { ExceptionRow } from '@/components/channels/exception-row'
import { PlanLock } from '@/components/distribution/plan-lock'
import { EmptyState } from '@/components/states/empty-state'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { CHANNEL_LABEL } from '@/lib/channels/types'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireDistributionGrant } from '../../agents/_lib/gate'
import { channelManagerState, type ChannelManagerState } from '../_lib/manager'

export const metadata: Metadata = { title: 'חריגות ערוצים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The exception centre.
 *
 * ══ EVERY ROW HERE IS SOMETHING THE SYSTEM REFUSED TO DECIDE ═══════════════
 *
 * A reservation for a listing nothing is mapped to. Two mappings claiming one
 * listing. An OTA changing dates a manager already changed after a phone call.
 * A cancellation for a guest who is currently asleep in the room. In each of
 * those the automatic answer is a guess, and every guess available either
 * drops a booking somebody paid for or sells one night to two families.
 *
 * So the system stops, writes a row, and says what to do about it. The steps
 * come from `EXCEPTION_PLAYBOOK` — a total record over the exception kinds, so
 * a kind cannot be added without somebody writing down how it is cleared.
 *
 * ── Ordered by danger, then by age ────────────────────────────────────────
 *
 * `bySeverityThenAge`, and the second half is the part that is easy to get
 * backwards: inside one severity the OLDEST is first. An unmapped reservation
 * from Tuesday is more dangerous than the identical one from ten minutes ago,
 * because the dates it failed to block are four days closer.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * No guest name, no phone, no email, no booking total. A person who may
 * configure channels is not thereby a person who may read a guest's details,
 * and an exception is actionable from the reservation id and the listing id
 * alone — which is exactly what the row carries.
 *
 * Resolution is not yet an action on this screen. The settle path exists in
 * the repository and needs a domain command behind it before a button here can
 * do anything, and a button that silently did nothing would be worse than its
 * absence. Named here rather than mimed.
 */
export default async function ChannelExceptionsPage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('channel.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="ערוצי הפצה אינם כלולים בחבילה שלך"
        body="מרכז החריגות הוא חלק ממנהל הערוצים, ומנהל הערוצים אינו כלול בחבילה הנוכחית."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let state: ChannelManagerState = { kind: 'not_provisioned' }
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    state = await channelManagerState({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  // Read once and passed down, so every row on the page measures its age
  // against the same instant. Two rows disagreeing about "now" is a small
  // thing that makes a queue look untrustworthy.
  const now = new Date()

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          חריגות ערוצים
        </h1>
        <p className="text-muted-foreground">
          כל שורה כאן היא משהו שהמערכת סירבה להחליט לבד, כי כל החלטה אוטומטית
          הייתה ניחוש — וניחוש כאן עולה מיטה או הזמנה.
        </p>
        <Link
          href="/channels"
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          חזרה למצב הערוצים
        </Link>
      </header>

      {failure ? (
        <ActionError error={failure.error} />
      ) : state.kind === 'not_readable' ? (
        <div
          role="status"
          className="rounded-xl border border-border bg-surface px-4 py-4 text-sm text-muted-foreground"
        >
          אין לך הרשאה לנהל ערוצי הפצה, ולכן החריגות אינן מוצגות.
        </div>
      ) : state.kind === 'not_provisioned' ? (
        <div
          role="status"
          className="rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
        >
          <p className="font-display text-base font-bold">
            מנהל הערוצים אינו מותקן בהתקנה הזו.
          </p>
          <p className="mt-1">
            אין טבלת חריגות ואין מה להציג. זו אינה טענה שאין בעיות בערוצים — זו
            טענה שהמערכת עדיין לא יכולה לראות אותן.
          </p>
        </div>
      ) : state.exceptions.length === 0 ? (
        <EmptyState
          illustration="calendar"
          title="אין חריגות פתוחות"
          body="כל ההזמנות שהגיעו מהערוצים נקלטו, כל המודעות ממופות, ואין מחלוקת פתוחה בין היומן שלך ליומן בערוץ."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-4 rounded-xl border border-border bg-surface px-4 py-4 text-sm sm:px-5">
            <Tally label="סה״כ פתוחות" value={state.tally.open} />
            <Tally
              label="קריטיות"
              value={state.tally.critical}
              tone="text-danger"
            />
            <Tally
              label="דחופות"
              value={state.tally.urgent}
              tone="text-warning"
            />
            <Tally label="לתשומת לב" value={state.tally.warning} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle as="h2">ממתין להחלטה</CardTitle>
            </CardHeader>
            <ul className="mt-2 flex flex-col divide-y divide-border">
              {state.exceptions.map((exception) => (
                <ExceptionRow
                  key={exception.id}
                  exception={exception}
                  now={now}
                />
              ))}
            </ul>
            <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground">
              סגירת חריגה מתבצעת כרגע דרך תיקון הסיבה עצמה — מיפוי מודעה, שינוי
              בהזמנה, או החלטה מול הערוץ. כפתור ״סמן כטופל״ עדיין אינו קיים כאן,
              ולא הוספנו כפתור שלא עושה דבר.
            </p>
          </Card>

          <ByChannel state={state} />
        </>
      )}
    </div>
  )
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`font-display text-xl font-bold ${tone ?? 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * Which channel is producing the problems.
 *
 * One line per connector, because "eleven exceptions" is a number and "nine of
 * them are Booking.com" is the sentence somebody acts on.
 */
function ByChannel({
  state,
}: {
  state: Extract<ChannelManagerState, { kind: 'ready' }>
}) {
  if (state.connectors.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">לפי ערוץ</CardTitle>
      </CardHeader>
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {state.connectors.map((view) => (
          <li
            key={view.connector.id}
            className="flex items-center justify-between gap-3 py-3 text-sm"
          >
            <span className="font-semibold text-foreground">
              {CHANNEL_LABEL[view.connector.channelCode]}
            </span>
            <span className="text-muted-foreground">
              {view.status.openExceptions === 0
                ? 'אין חריגות'
                : `${view.status.openExceptions} חריגות`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
