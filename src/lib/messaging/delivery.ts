/**
 * What may happen to a message, decided before anything is written or sent.
 *
 * Pure. No repository, no provider call, no clock of its own — the same split
 * `notifications/routing.ts` makes for the same reason: every rule below can
 * be asserted against a table of inputs, and `operations.ts` is left with
 * sequencing.
 *
 * ══ THE ORDER OF THE TWO GATES, AND WHY IT IS THIS WAY ══════════════════════
 *
 *   1. **Is there anything behind this channel?** If not, `not_configured`,
 *      and the quiet-hours question is never asked. Deferring a message to
 *      seven in the morning on a channel that does not exist would produce a
 *      queue of things that will never be sent and a screen saying "waiting"
 *      about them forever. `notifications/routing.ts` orders these two the
 *      same way and says so in the same words; this is that rule applied to
 *      the outward half rather than a second opinion about it.
 *
 *   2. **May it reach somebody now?** `quietHoursVerdict` from
 *      `notifications/quiet-hours.ts`, unchanged and un-reimplemented,
 *      including its daylight-saving approximation and its "an unparseable
 *      window fails towards silence" rule.
 *
 * ══ QUIET HOURS APPLY OUTWARD AND NEVER INTERNALLY ══════════════════════════
 *
 * Not because a member of staff matters less. Because an internal message's
 * quiet-hours decision has ALREADY been made, per recipient and per channel,
 * by `notifications/routing.ts` — which knows that person's preferences, their
 * severity floor, and that `in_app` is pull and is never held. Evaluating it a
 * second time here would be a second opinion that can disagree with the first,
 * and the failure mode of two opinions about silence is a message that neither
 * layer thinks it dropped.
 *
 * A guest has none of that. There is no preference row, no severity floor and
 * no bell panel to fall back on, so the outward gate is evaluated here and
 * here only. `quietHoursHold` is the one function that states both halves, so
 * the asymmetry is a line of code rather than a convention.
 */

import { quietHoursVerdict } from '../notifications/quiet-hours'
import type { QuietHoursVerdict } from '../notifications/quiet-hours'
import type {
  NotificationChannel,
  NotificationSettings,
  NotificationSeverity,
} from '../notifications/types'

import type { MessageProviderRegistry } from './provider'
import {
  KIND_SEVERITY,
  type GuestChannel,
  type GuestMessageKind,
} from './types'

/* ------------------------------------------------------------- direction -- */

/**
 * Who the message leaves towards.
 *
 * `outward` crosses the boundary of the business — a guest, on a channel a
 * provider carries. `internal` stays inside it and reaches a colleague through
 * the notifications engine.
 */
export type MessageDirection = 'outward' | 'internal'

/**
 * May this be held until the quiet window ends?
 *
 * See the header for why `internal` is never held HERE. It is emphatically not
 * "internal messages ignore quiet hours" — `notifications` holds them, with
 * that person's own settings, on the channels that interrupt.
 */
export function quietHoursHold(args: {
  direction: MessageDirection
  channel: NotificationChannel
  severity: NotificationSeverity
  settings: Pick<
    NotificationSettings,
    | 'quietHoursEnabled'
    | 'quietHoursStart'
    | 'quietHoursEnd'
    | 'timezone'
    | 'urgentOverridesQuietHours'
  >
  now: Date
}): QuietHoursVerdict {
  if (args.direction === 'internal') return { held: false }

  return quietHoursVerdict({
    channel: args.channel,
    severity: args.severity,
    settings: args.settings,
    now: args.now,
  })
}

/* ------------------------------------------------------------------ plan -- */

/**
 * What the operation should do with one outward message.
 *
 * Deliberately three cases and not a boolean plus a nullable date. A caller
 * that has to remember "if scheduledFor is set then do not call the provider"
 * is a caller that will one day forget, and forgetting means a guest receives
 * a payment reminder at half past two in the morning.
 */
export type OutwardPlan =
  /** Ask the provider now. Nothing else has refused. */
  | { action: 'send'; outcome: 'pending'; scheduledFor: null; detail: null }
  /** Hold it. `scheduledFor` is when it becomes sendable. Not dropped. */
  | {
      action: 'hold'
      outcome: 'deferred'
      scheduledFor: Date
      detail: string
    }
  /** Record it and ask nobody. Nothing is behind this channel. */
  | {
      action: 'record'
      outcome: 'not_configured'
      scheduledFor: null
      detail: string
    }

export function planOutward(args: {
  kind: GuestMessageKind
  channel: GuestChannel
  providers: MessageProviderRegistry
  settings: Pick<
    NotificationSettings,
    | 'quietHoursEnabled'
    | 'quietHoursStart'
    | 'quietHoursEnd'
    | 'timezone'
    | 'urgentOverridesQuietHours'
  >
  now: Date
}): OutwardPlan {
  const { kind, channel, providers, settings, now } = args

  // Gate 1. Asked of the registry rather than by calling `send` and reading
  // the answer, because `configured` is a fact about configuration and must be
  // answerable without a network call — see the port.
  if (!providers.isConfigured(channel)) {
    return {
      action: 'record',
      outcome: 'not_configured',
      scheduledFor: null,
      detail: `no provider is configured for ${channel}`,
    }
  }

  // Gate 2.
  const verdict = quietHoursHold({
    direction: 'outward',
    channel,
    severity: KIND_SEVERITY[kind],
    settings,
    now,
  })

  if (verdict.held) {
    return {
      action: 'hold',
      outcome: 'deferred',
      scheduledFor: verdict.until,
      detail: 'held by quiet hours',
    }
  }

  return {
    action: 'send',
    outcome: 'pending',
    scheduledFor: null,
    detail: null,
  }
}
