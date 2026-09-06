import { Card } from '@/components/ui/card'
import { describeAge } from '@/lib/channels/health'
import {
  CAPABILITY_LABEL,
  CHANNEL_LABEL,
  type Connector,
  type ConnectorCapability,
  type SyncStatus,
} from '@/lib/channels/types'

import { SyncBadge } from './sync-badge'

/**
 * One channel, and whether it is actually working.
 *
 * ── The two timestamps are the headline, not the badge ────────────────────
 *
 * "מסונכרן" over a channel whose last outbound push was four hours ago is a
 * sentence a business plans its week around. So the card leads with *when*
 * each direction last ran, with the direction named — and says "מעולם לא"
 * rather than leaving a blank, because a blank reads as fine.
 *
 * ── Capabilities are shown, and their absence is shown too ────────────────
 *
 * A channel that cannot take a rate push is a channel where the price on this
 * screen and the price the guest is quoted are two different numbers. That is
 * not a footnote for the integration's author; it is something the owner has
 * to know, so the card names what this channel will not do as plainly as what
 * it will.
 */
export function ConnectorCard({
  connector,
  status,
}: {
  connector: Connector
  status: SyncStatus
}) {
  const missing = MEANINGFUL_CAPABILITIES.filter(
    (capability) => !connector.capabilities.includes(capability),
  )

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-display text-lg font-bold text-foreground">
            {CHANNEL_LABEL[connector.channelCode]}
          </h3>
          <p className="text-xs text-muted-foreground">
            {connector.externalAccountId
              ? `חשבון ${connector.externalAccountId}`
              : 'לא מחובר לחשבון בערוץ'}
          </p>
        </div>
        <SyncBadge state={status.state} />
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <Fact label="הזמנות נמשכו לאחרונה" at={status.lastInboundSyncAt} />
        <Fact label="זמינות נשלחה לאחרונה" at={status.lastOutboundSyncAt} />
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">ממתין לשליחה</dt>
          <dd className="font-semibold text-foreground">
            {status.pendingOutbound === 0
              ? 'אין'
              : `${status.pendingOutbound} עדכונים`}
          </dd>
        </div>
      </dl>

      {status.concerns.length > 0 && (
        <ul className="flex flex-col gap-2 border-t border-border pt-3 text-sm text-foreground">
          {status.concerns.map((concern) => (
            <li key={concern} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{concern}</span>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          {'הערוץ הזה אינו תומך ב'}
          {missing.map((capability) => CAPABILITY_LABEL[capability]).join(', ')}
          {'. פעולות אלה לא יישלחו אליו כלל — יש לבצע אותן ישירות בערוץ.'}
        </p>
      )}
    </Card>
  )
}

function Fact({ label, at }: { label: string; at: Date | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">
        {/* Never a blank. A blank reads as "fine". */}
        {at === null ? 'מעולם לא' : `לפני ${ageOf(at)}`}
      </dd>
    </div>
  )
}

function ageOf(at: Date): string {
  return describeAge(Math.floor((Date.now() - at.getTime()) / 60_000))
}

/**
 * The capabilities whose absence changes what a person must do by hand.
 *
 * `discover_listings` and `receive_webhooks` are deliberately not here: a
 * channel that must be polled rather than pushed to is slower and is not
 * something an owner acts on, and discovery not existing only means the
 * mapping screen asks for an id instead of offering a list.
 */
const MEANINGFUL_CAPABILITIES: readonly ConnectorCapability[] = [
  'push_availability',
  'push_rates',
  'push_restrictions',
  'pull_reservations',
]
