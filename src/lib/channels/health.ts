/**
 * Is this channel actually working?
 *
 * ── The failure mode this file exists to prevent ──────────────────────────
 *
 * A channel manager that is broken looks exactly like a channel manager that
 * has nothing to do. Both are quiet. The sync ran at 04:00 and failed, nobody
 * was told, and at 11:00 the same Friday is on sale in two places — and the
 * screen still says "Booking.com" with no red on it, because nothing *happened*
 * to draw. Silence is the most dangerous state this module has, so health is
 * computed from **elapsed time and queue depth**, not from the presence of an
 * error. A sync that has not run is a finding. A queue that only grows is a
 * finding. An empty error list proves nothing at all.
 *
 * ── Inbound and outbound are separate, and they fail differently ──────────
 *
 *   · **Inbound behind** — bookings the channel already took are missing here.
 *     Somebody will sell those nights directly.
 *   · **Outbound behind** — nights that are gone are still on sale there.
 *     Somebody else will sell them.
 *
 * Both are drift. Only the second one is drift the business is actively
 * advertising, which is why its staleness threshold is the tighter of the two.
 *
 * ── Every state has a sentence ────────────────────────────────────────────
 *
 * `concerns` is Hebrew and specific: "לא נשלח עדכון זמינות כבר 4 שעות" rather
 * than "degraded". A status word with no sentence behind it is a colour, and a
 * colour is not something anybody can act on at nine in the morning.
 */

import type { ConnectorHealthReport } from './connector'
import {
  CHANNEL_LABEL,
  type Connector,
  type SyncState,
  type SyncStatus,
} from './types'

/* ------------------------------------------------------------ thresholds -- */

export interface HealthThresholds {
  /** Nothing pulled for this long is a concern. */
  inboundStaleMinutes: number
  /** Tighter than inbound — see the header. */
  outboundStaleMinutes: number
  /** A channel that pushes to us and has gone quiet. */
  webhookStaleMinutes: number
  /** A queue deeper than this is not draining. */
  pendingQueueWarning: number
  /** Failures inside the window before the state becomes `failing`. */
  failureThreshold: number
  /** Warn this many days before a credential stops working. */
  credentialWarningDays: number
}

/**
 * Defaults, and why each is what it is.
 *
 * Not tuned against production — there is no production integration to tune
 * against — so they are stated as the reasoning rather than presented as
 * measurements. Every one of them is a caller-overridable parameter precisely
 * because the first real channel will disagree with at least two of them.
 */
export const DEFAULT_THRESHOLDS: HealthThresholds = {
  // An hour of missing bookings is roughly the window in which somebody takes
  // a phone booking for a night an OTA already sold.
  inboundStaleMinutes: 60,
  // Half that. An unsent availability update is a night on sale that is gone.
  outboundStaleMinutes: 30,
  // Webhooks are bursty and a quiet afternoon is normal; three hours of
  // silence from a channel that normally talks is not.
  webhookStaleMinutes: 180,
  pendingQueueWarning: 25,
  // One failure is weather. Three is a pattern.
  failureThreshold: 3,
  credentialWarningDays: 7,
}

/* ----------------------------------------------------------------- input -- */

export interface HealthInput {
  connector: Connector
  /** Entities waiting to go out to this channel. */
  pendingOutbound: number
  /** Failed sync runs inside the health window. */
  recentFailures: number
  /** The specific listings or dates that would not push. */
  failedEntities: readonly string[]
  /** Open plus acknowledged. Resolved ones are not a health signal. */
  openExceptions: number
  /**
   * What the connector itself said when asked.
   *
   * `null` when nobody asked, which is different from a connector that
   * answered "unreachable" — the first is an unknown and the second is a fact,
   * and only the second is allowed to make the state `failing`.
   */
  probe?: ConnectorHealthReport | null
  now: Date
  thresholds?: Partial<HealthThresholds>
}

/* ---------------------------------------------------------------- engine -- */

export function connectorHealth(input: HealthInput): SyncStatus {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) }
  const { connector, now } = input

  const concerns: string[] = []

  const inboundAge = minutesSince(connector.lastInboundSyncAt, now)
  const outboundAge = minutesSince(connector.lastOutboundSyncAt, now)
  const webhookAge = minutesSince(connector.lastWebhookAt, now)

  const stopped =
    connector.state === 'paused' || connector.state === 'disconnected'

  const neverSynced =
    connector.lastInboundSyncAt === null &&
    connector.lastOutboundSyncAt === null

  const credentialsDead =
    connector.credentialsExpireAt !== null &&
    connector.credentialsExpireAt.getTime() <= now.getTime()

  const credentialsSoon =
    connector.credentialsExpireAt !== null &&
    !credentialsDead &&
    connector.credentialsExpireAt.getTime() - now.getTime() <=
      thresholds.credentialWarningDays * 86_400_000

  // ── Concerns, in the order somebody should read them ──────────────────

  if (connector.state === 'draft') {
    concerns.push(
      `החיבור ל-${CHANNEL_LABEL[connector.channelCode]} נוצר ולא הופעל. ` +
        'לא נשלח ולא נמשך דבר.',
    )
  }

  if (connector.state === 'paused') {
    concerns.push(
      'החיבור מושהה על ידי מישהו כאן. היומן בערוץ אינו מתעדכן כל עוד הוא מושהה.',
    )
  }

  if (connector.state === 'disconnected') {
    concerns.push(
      'הערוץ ניתק את החיבור. זה לא משהו שאפשר לתקן מכאן — יש להתחבר מחדש.',
    )
  }

  if (credentialsDead) {
    concerns.push('פרטי הגישה לערוץ פגו. שום בקשה לא תתקבל עד שיחודשו.')
  } else if (credentialsSoon && connector.credentialsExpireAt) {
    concerns.push(
      `פרטי הגישה לערוץ פגים ב-${isoDay(connector.credentialsExpireAt)}. ` +
        'חדש אותם לפני כן, אחרת הסנכרון ייעצר בלי אזהרה נוספת.',
    )
  }

  if (input.probe && !input.probe.reachable) {
    concerns.push(...input.probe.notes)
  }

  if (!stopped && !neverSynced) {
    if (outboundAge !== null && outboundAge > thresholds.outboundStaleMinutes) {
      concerns.push(
        `לא נשלח עדכון זמינות כבר ${describeAge(outboundAge)}. ` +
          'לילות שנמכרו כאן עדיין מוצעים שם.',
      )
    }
    if (inboundAge !== null && inboundAge > thresholds.inboundStaleMinutes) {
      concerns.push(
        `לא נמשכו הזמנות כבר ${describeAge(inboundAge)}. ` +
          'ייתכן שנמכרו שם לילות שאינם חסומים כאן.',
      )
    }
    if (
      connector.capabilities.includes('receive_webhooks') &&
      webhookAge !== null &&
      webhookAge > thresholds.webhookStaleMinutes
    ) {
      concerns.push(
        `הערוץ לא שלח עדכון יזום כבר ${describeAge(webhookAge)}. ` +
          'ייתכן שהרישום לעדכונים נותק בצד שלהם.',
      )
    }
  }

  if (input.pendingOutbound > thresholds.pendingQueueWarning) {
    concerns.push(
      `${input.pendingOutbound} עדכונים ממתינים לשליחה. תור שרק גדל פירושו ` +
        'שהשליחה אינה מצליחה.',
    )
  }

  if (input.recentFailures > 0) {
    concerns.push(
      `${input.recentFailures} ניסיונות סנכרון נכשלו לאחרונה` +
        (input.failedEntities.length > 0
          ? ` (${input.failedEntities.slice(0, 5).join(', ')}${
              input.failedEntities.length > 5 ? ', ועוד' : ''
            })`
          : '') +
        '.',
    )
  }

  if (input.openExceptions > 0) {
    concerns.push(
      `${input.openExceptions} חריגות פתוחות ממתינות להחלטה של אדם.`,
    )
  }

  // ── The state ─────────────────────────────────────────────────────────

  const state = resolveState({
    stopped,
    neverSynced,
    credentialsDead,
    unreachable: input.probe ? !input.probe.reachable : false,
    recentFailures: input.recentFailures,
    failureThreshold: thresholds.failureThreshold,
    degraded: concerns.length > 0,
  })

  return {
    connectorId: connector.id,
    channelCode: connector.channelCode,
    state,
    lastInboundSyncAt: connector.lastInboundSyncAt,
    lastOutboundSyncAt: connector.lastOutboundSyncAt,
    lastWebhookAt: connector.lastWebhookAt,
    pendingOutbound: input.pendingOutbound,
    recentFailures: input.recentFailures,
    failedEntities: input.failedEntities,
    credentialsExpireAt: connector.credentialsExpireAt,
    openExceptions: input.openExceptions,
    concerns,
  }
}

/**
 * The state, decided in one place.
 *
 * `stopped` outranks everything, including failure: a paused connector that
 * has not synced for a week is not failing, it is off, and rendering it red
 * teaches people that red means nothing.
 */
function resolveState(args: {
  stopped: boolean
  neverSynced: boolean
  credentialsDead: boolean
  unreachable: boolean
  recentFailures: number
  failureThreshold: number
  degraded: boolean
}): SyncState {
  if (args.stopped) return 'stopped'
  if (args.credentialsDead || args.unreachable) return 'failing'
  if (args.recentFailures >= args.failureThreshold) return 'failing'
  if (args.neverSynced) return 'never_synced'
  return args.degraded ? 'degraded' : 'healthy'
}

/* ----------------------------------------------------------------- fleet -- */

export interface FleetHealth {
  connectors: number
  healthy: number
  degraded: number
  failing: number
  stopped: number
  neverSynced: number
  /** The worst state present. What the header colour is. */
  worst: SyncState
  totalOpenExceptions: number
}

/**
 * Every channel at once, for the top of the health centre.
 *
 * `worst` and not an average. Three healthy channels and one failing one is a
 * business with a double booking coming, and a summary that reports "75%
 * healthy" is a summary designed to be ignored.
 */
export function fleetHealth(statuses: readonly SyncStatus[]): FleetHealth {
  const counts = {
    healthy: 0,
    degraded: 0,
    failing: 0,
    stopped: 0,
    never_synced: 0,
  }

  let exceptions = 0
  for (const status of statuses) {
    counts[status.state] += 1
    exceptions += status.openExceptions
  }

  const worst: SyncState =
    counts.failing > 0
      ? 'failing'
      : counts.degraded > 0
        ? 'degraded'
        : counts.never_synced > 0
          ? 'never_synced'
          : counts.stopped > 0 && counts.healthy === 0
            ? 'stopped'
            : 'healthy'

  return {
    connectors: statuses.length,
    healthy: counts.healthy,
    degraded: counts.degraded,
    failing: counts.failing,
    stopped: counts.stopped,
    neverSynced: counts.never_synced,
    worst,
    totalOpenExceptions: exceptions,
  }
}

/* ------------------------------------------------------------- internals -- */

function minutesSince(at: Date | null, now: Date): number | null {
  if (at === null) return null
  return Math.floor((now.getTime() - at.getTime()) / 60_000)
}

/** Hebrew, and rounded the way a person would say it. */
export function describeAge(minutes: number): string {
  if (minutes < 1) return 'פחות מדקה'
  if (minutes < 60) return `${minutes} דקות`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'שעה' : `${hours} שעות`

  const days = Math.floor(hours / 24)
  return days === 1 ? 'יום' : `${days} ימים`
}

function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}
