/**
 * What this business can actually send, and what it is not sending.
 *
 * ══ THE PANEL THIS MODULE EXISTS TO RENDER ══════════════════════════════════
 *
 * The product has no mailer, no SMS client and no WhatsApp client, because all
 * three need credentials this deployment does not have. The decision not to
 * build half of one is deliberate and is argued in `src/lib/notifications/
 * transport.ts`. What is NOT acceptable is for that decision to be invisible:
 * a business whose staff quietly never receive anything has no way to know
 * whether the product is broken, misconfigured, or working exactly as built.
 *
 * So the gap is a number on a screen. "היינו שולחים 14 הודעות ואין ערוץ
 * מחובר" is an honest sentence and it is also the strongest argument that
 * exists for connecting a channel — it turns an integration nobody asked for
 * into a decision somebody can make with a figure in front of them.
 *
 * ══ WHAT IS COUNTED, AND WHAT IS DELIBERATELY NOT ═══════════════════════════
 *
 * Only `not_configured`. A `suppressed` delivery is somebody having said no,
 * and rolling the two together would make the product argue for buying a
 * channel its own staff switched off. They are shown side by side and named
 * differently, because they call for opposite responses.
 *
 * No `"use client"`: this renders numbers and has no state.
 */

import { Badge } from '@/components/ui/badge'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
} from '@/components/shell-screens/screen'
import {
  CHANNEL_HINT,
  CHANNEL_LABEL,
  DELIVERY_STATUS_LABEL,
  unsentSummary,
} from '@/lib/notifications/labels'
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
} from '@/lib/notifications/types'
import { NOTIFICATION_CHANNELS } from '@/lib/notifications/types'

export type ChannelStatusProps = {
  /** Which channels the organization has switched on. */
  enabled: readonly NotificationChannel[]
  /** Which channels have a transport behind them. In practice: in-app. */
  configured: readonly NotificationChannel[]
  /** How every delivery in the window ended. */
  tally: Record<NotificationDeliveryStatus, number>
  windowDays: number
}

export function ChannelStatus({
  enabled,
  configured,
  tally,
  windowDays,
}: ChannelStatusProps) {
  const enabledSet = new Set(enabled)
  const configuredSet = new Set(configured)
  const unsent = tally.not_configured

  return (
    <Panel
      title="ערוצי שליחה"
      description="מה המערכת יכולה לשלוח בפועל, ומה נרשם ולא נשלח לשום מקום."
    >
      <div className="flex flex-col gap-5">
        <PanelNote tone={unsent > 0 ? 'attention' : 'quiet'}>
          {unsentSummary(unsent, windowDays)}
        </PanelNote>

        <RowList>
          {NOTIFICATION_CHANNELS.map((channel) => {
            const isEnabled = enabledSet.has(channel)
            const isConfigured = configuredSet.has(channel)

            return (
              <Row key={channel} className="items-start">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold text-foreground">
                    {CHANNEL_LABEL[channel]}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {CHANNEL_HINT[channel]}
                  </span>
                </div>

                {/*
                  Three states, never two. "מחובר" and "כבוי" are the business's
                  own choices; "אין חיבור" is the product's gap, and a screen
                  that showed it as "כבוי" would be blaming the customer for
                  something they never had the option to switch on.
                */}
                <Badge
                  tone={
                    isConfigured && isEnabled
                      ? 'brand'
                      : isConfigured
                        ? 'neutral'
                        : 'accent'
                  }
                >
                  {isConfigured
                    ? isEnabled
                      ? 'מחובר ופעיל'
                      : 'מחובר, כבוי'
                    : 'אין חיבור'}
                </Badge>
              </Row>
            )
          })}
        </RowList>

        <DeliveryTally tally={tally} windowDays={windowDays} />
      </div>
    </Panel>
  )
}

/**
 * The raw account of the window.
 *
 * Every state, including the zeros. A tally that hid its empty rows would make
 * "nothing failed" and "we do not measure failures" look identical.
 */
function DeliveryTally({
  tally,
  windowDays,
}: {
  tally: Record<NotificationDeliveryStatus, number>
  windowDays: number
}) {
  const total = Object.values(tally).reduce((sum, count) => sum + count, 0)

  if (total === 0) {
    return (
      <PanelNote>
        {`בטווח ${windowDays} הימים האחרונים לא נרשמו ניסיונות שליחה כלל. זו התשובה הנכונה לעסק שקט, ולא סימן לתקלה.`}
      </PanelNote>
    )
  }

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        {`מה קרה ל-${total} ניסיונות השליחה האחרונים`}
      </h3>
      <dl className="flex flex-col">
        {(Object.entries(tally) as [NotificationDeliveryStatus, number][]).map(
          ([status, count]) => (
            <div
              key={status}
              className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0"
            >
              <dt className="text-sm text-muted-foreground">
                {DELIVERY_STATUS_LABEL[status]}
              </dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">
                {count}
              </dd>
            </div>
          ),
        )}
      </dl>
    </div>
  )
}
