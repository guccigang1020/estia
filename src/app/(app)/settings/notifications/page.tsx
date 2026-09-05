import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { ChannelStatus } from '@/components/notifications/channel-status'
import {
  NotificationList,
  type NotificationRow,
} from '@/components/notifications/notification-list'
import {
  PreferenceMatrix,
  SingleChannelNote,
} from '@/components/notifications/preference-matrix'
import { QuietHoursForm } from '@/components/notifications/quiet-hours-form'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { toSafeResponse } from '@/lib/errors'
import { unreadCount } from '@/lib/notifications'
import type { NotificationChannel } from '@/lib/notifications/types'

import { shellContext } from '../../_lib/context'
import { loadNotificationSettings, TALLY_WINDOW_DAYS } from './_lib/queries'

export const metadata: Metadata = { title: 'התראות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What this business is told, and what
 * it is not sending.
 *
 * ══ THIS SCREEN IS FOR SOMEBODY WITH NO E-MAIL PROVIDER ══════════════════
 *
 * Which is every customer today, and the screen is built for them rather than
 * for the exception. There is no "connect a provider" banner and no disabled
 * integration panel implying a setup step was skipped. The first panel says,
 * in a number, exactly what the absence costs: how many messages would have
 * gone out and did not. That figure is honest and it is also the only argument
 * for connecting a channel that a business can act on.
 *
 * The in-app channel is complete. It needs no credential, the notification row
 * IS the delivery, and everything below the first panel works today.
 *
 * ══ GATING, AND WHY THE SCREEN IS NOT ALL ONE GRANT ══════════════════════
 *
 * The route is NOT gated on `organization.settings.edit`. The inbox and the
 * personal preference grid belong to whoever is signed in — a cleaner must be
 * able to read their own alerts and mute their own SMS — and gating the route
 * would put those behind an authority almost nobody has.
 *
 * So the route is open to any active member, and the ORGANIZATION panel is
 * gated inside it, on the same grant the Server Action asserts and the
 * database demands. Somebody without it sees their own notifications, their
 * own preferences, and a sentence saying who decides the rest.
 */
export default async function NotificationSettingsPage() {
  const context = await shellContext()

  // Not `requireGrant`: this route has no single grant. Membership is the gate,
  // and it is the same one every screen in the shell already applies.
  if (!context) redirect('/sign-in')
  if (context.status !== 'ready') redirect('/dashboard')

  const { actor } = context

  let view
  try {
    view = await loadNotificationSettings(actor)
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="התראות" lead="" width="prose">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  const mayConfigure = actor.grants.has('organization.settings.edit')
  const configured = view.configuredChannels as readonly NotificationChannel[]
  const unread = unreadCount(view.inbox)

  const rows: NotificationRow[] = view.inbox.map((notification) => ({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    actionHref: notification.actionHref,
    category: notification.category,
    severity: notification.severity,
    // Formatted here rather than in the client component: a `Date` does not
    // cross the boundary intact, and formatting on the server means one Hebrew
    // rendering rather than one per browser locale.
    occurredAtLabel: new Intl.DateTimeFormat('he-IL', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: view.settings.timezone,
    }).format(notification.occurredAt),
    isRead: notification.readAt !== null,
    isActed: notification.actedAt !== null,
    escalationLevel: notification.escalationLevel,
  }))

  return (
    <ScreenFrame
      title="התראות"
      lead="מה המערכת מודיעה לך, באיזה ערוץ, ומתי היא נשארת בשקט."
      width="prose"
    >
      {view.unseeded && (
        <PanelNote tone="attention">
          טבלאות ההתראות טרם נוספו לנתוני ההדגמה, ולכן המסך מוצג על ברירות המחדל
          ואין בו רשומות. זו הגדרה חסרה בהדגמה בלבד — לא מצב של המוצר.
        </PanelNote>
      )}

      <Panel
        title="ההתראות שלי"
        description="הערוץ במערכת עובד במלואו ואינו דורש שום חיבור חיצוני. זה מה שממתין לך עכשיו."
        count={unread}
      >
        <NotificationList rows={rows} />
      </Panel>

      <Panel
        title="מה יגיע אליי, ואיפה"
        description="לפי קטגוריה ולפי ערוץ. שינוי נשמר מיד, שורה שורה."
      >
        <div className="flex flex-col gap-4">
          {view.settings.enabledChannels.length === 1 && <SingleChannelNote />}
          <PreferenceMatrix
            channels={view.settings.enabledChannels}
            cells={view.grid.map((cell) => ({
              category: cell.category,
              channel: cell.channel,
              enabled: cell.enabled,
              minSeverity: cell.minSeverity,
              explicit: cell.explicit,
            }))}
          />
        </div>
      </Panel>

      <ChannelStatus
        enabled={view.settings.enabledChannels}
        configured={configured}
        tally={view.tally}
        windowDays={TALLY_WINDOW_DAYS}
      />

      <Panel
        title="הגדרות הארגון"
        description="ערוצים פעילים, שעות שקט והזמן שעובר עד שהתראה שלא טופלה עולה דרג."
      >
        {mayConfigure ? (
          <div className="flex flex-col gap-4">
            {view.usingDefaults && (
              <PanelNote>
                עדיין לא נשמרו כאן הגדרות, ולכן פועלות ברירות המחדל שמוצגות
                למטה. זו הגדרה שלמה, לא חסרה.
              </PanelNote>
            )}
            <QuietHoursForm
              initial={{
                enabledChannels: view.settings.enabledChannels,
                quietHoursEnabled: view.settings.quietHoursEnabled,
                quietHoursStart: view.settings.quietHoursStart,
                quietHoursEnd: view.settings.quietHoursEnd,
                timezone: view.settings.timezone,
                urgentOverridesQuietHours:
                  view.settings.urgentOverridesQuietHours,
                defaultEscalationMinutes:
                  view.settings.defaultEscalationMinutes,
                retainReadDays: view.settings.retainReadDays,
              }}
              configured={configured}
            />
          </div>
        ) : (
          <PanelNote>
            {`ההגדרות האלה נקבעות ברמת הארגון. כרגע פועלות שעות שקט ${view.settings.quietHoursStart}–${view.settings.quietHoursEnd}, והן משפיעות רק על ערוצים חיצוניים — ההתראות עצמן נשמרות תמיד ומופיעות למעלה.`}
          </PanelNote>
        )}
      </Panel>
    </ScreenFrame>
  )
}
