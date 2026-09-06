/**
 * Letting a deferred delivery go, when its quiet window has actually opened.
 *
 * ══ THE DEFECT THIS CLOSES ══════════════════════════════════════════════════
 *
 * `routing.ts` holds a delivery that would wake somebody at 23:40 and writes
 * `status = 'deferred'` with a `scheduled_for` of 07:00. `0043` built
 * `notification_deliveries_due_idx` for the sweep that would drain that queue.
 * Nothing ever swept it. A business that switched quiet hours on to avoid
 * being paged at midnight did not get its alerts an hour late — it stopped
 * getting them at all, and nothing said so.
 *
 * That is worse than the gate it passed through, because a gate that delays is
 * a decision a business made and a gate that silently drops is one nobody
 * chose. This file is the missing half.
 *
 * ══ RE-CHECKING IS THE WHOLE JOB, NOT A PRECAUTION ══════════════════════════
 *
 * A `scheduled_for` written at 22:10 is a claim about a world eight hours old.
 * In between, the organization can widen its quiet hours, switch the channel
 * off entirely, or the recipient can turn that category down. Releasing on the
 * strength of a stale timestamp is how a business that turned messaging off at
 * midnight receives a batch at dawn — which is the same class of failure as
 * not sending at all, pointed the other way.
 *
 * So `planDeliveryRelease` re-runs the SAME three gates `routing.ts` runs,
 * against CURRENT settings and CURRENT preferences, in the same order:
 *
 *   1. `suppressionFor` on the resolved preference — the person and the
 *      organization. `PreferenceSet` is built from today's settings, so a
 *      channel removed from `enabledChannels` since the deferral resolves to
 *      `channel_disabled` here without this file knowing that rule exists.
 *   2. `transports.isConfigured` — checked BEFORE quiet hours, for exactly
 *      the reason `routing.ts` states: re-deferring onto a channel with
 *      nothing behind it produces a queue that never drains.
 *   3. `quietHoursVerdict` — unchanged, un-reimplemented, including its
 *      daylight-saving approximation and its fail-towards-silence rule.
 *
 * Not one of those three rules is restated here. If they are ever wrong they
 * are wrong in one place, which is the only property that keeps a second
 * evaluation of "may this wake somebody" from becoming a second opinion.
 *
 * ══ THE ROW'S OWN STATUS IS THE LOCK ════════════════════════════════════════
 *
 * Two sweeps overlapping — a slow one still running when the next fires, or
 * two instances of the same process — must not both send. There is no
 * advisory lock and no queue table, because there does not need to be: the
 * claim is
 *
 *     update notification_deliveries set … where id = ? and status = 'deferred'
 *
 * and Postgres decides it. The loser's update matches zero rows and it moves
 * on having sent nothing. This is the same argument `dispatch.ts` makes about
 * the unique constraint on `notifications.dedupe_key`: the guarantee is a
 * write the database serialises, not a look-then-write in JavaScript, because
 * every look-then-write has a window between the two halves and a sweep is
 * precisely the thing that runs twice at once.
 *
 * A separate lock would be strictly worse. It would be a second piece of state
 * that can disagree with the row — held for a row already sent, or released
 * for a row still in flight — and reconciling the two would be a job nobody
 * writes.
 *
 * ── Where the two-phase claim is, and where it deliberately is not ────────
 *
 * A decision that asks NOBODY — suppressed, or `not_configured` — is a single
 * conditional update straight from `deferred` to its terminal status. There is
 * no window to protect, so there is no intermediate state to get stuck in.
 *
 * Only a decision that will ask a transport claims first: `deferred` →
 * `pending`, then the send, then `pending` → its outcome. That leaves one
 * honest window: a process that dies between the claim and the settle leaves a
 * row `pending`, which is visible on the settings screen and is covered by
 * `notification_deliveries_due_idx` (the index includes `pending`, not only
 * `deferred`). The alternative — send first, then claim — makes a race send
 * twice, and a colleague paged twice at 03:00 is a worse outcome than a row a
 * person can see is stuck.
 *
 * ══ A STALE DEFERRAL IS ABANDONED, AND SAYS SO ══════════════════════════════
 *
 * `staleAfterMinutes` has no default anywhere in this file. A default would be
 * this module quietly deciding how late is too late for a business it knows
 * nothing about, and the cost of being wrong is a four-day-old alert about a
 * stay that ended arriving as though it were news. The caller states the
 * bound; the sweep records the abandonment as `suppressed` with a reason,
 * because a row silently left `deferred` forever is the same defect one layer
 * down.
 *
 * ══ AND THE WINDOW MAY HAVE RE-CLOSED, WHICH IS NOT A RE-DEFERRAL ═══════════
 *
 * When gate 3 holds again the row is recorded `suppressed` with reason
 * `quiet_hours` rather than being deferred to a new time. Re-deferring reads
 * kinder and is not: a business that keeps widening its window would produce a
 * row that is rescheduled forever, is never sent, and never once says it was
 * not sent — the exact silence this file exists to end. The staleness bound
 * would abandon it in the end anyway, so re-deferral only buys a longer period
 * of a screen saying "waiting" about something that will not go.
 */

import { PreferenceSet, suppressionFor } from './preferences'
import { quietHoursVerdict } from './quiet-hours'
import type { TransportRegistry, TransportResult } from './transport'
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationSettings,
  NotificationSeverity,
  SuppressionReason,
} from './types'

/* --------------------------------------------------------------- reasons -- */

/**
 * Why a deferral was abandoned rather than sent.
 *
 * `notification_deliveries.suppressed_reason` is `text` and not an enum,
 * precisely so a new diagnostic does not need a migration before anybody can
 * write it down — 0043 says so in the column comment. The TypeScript union in
 * `types.ts` has not caught up, and that file is not edited from here, so the
 * value is declared beside the only code that writes it and the local union
 * widens `SuppressionReason` rather than replacing it.
 *
 * Until `SUPPRESSION_REASONS` carries it, `deliveryFromRow` will read this
 * back as `null` and `labels.ts` has no Hebrew for it. Both are reported.
 */
export const STALE_DEFERRAL = 'stale_deferral'

/** Every reason a release can write. The five routed ones, plus staleness. */
export type ReleaseSuppressionReason = SuppressionReason | typeof STALE_DEFERRAL

/* ------------------------------------------------------------------ rows -- */

/**
 * One deferred delivery, with the part of its notification the gates need.
 *
 * Flat, and a projection rather than a `DeliveryRecord` plus a
 * `NotificationRecord`: the planner asks four questions about the parent row —
 * who, which category, how loud, and what to say — and handing it the whole
 * notification would let a future rule reach for a field the sweep has no
 * business reading.
 *
 * `scheduledFor` is `Date` and not `Date | null` because a deferred row
 * without one cannot exist: `notification_deliveries_deferred_has_time`
 * refuses it. The type says what the constraint already guarantees, so nothing
 * downstream needs a non-null assertion to use it.
 */
export interface DueDelivery {
  id: string
  organizationId: string
  notificationId: string
  channel: NotificationChannel
  /** When the deferral said it became sendable. The staleness clock. */
  scheduledFor: Date
  recipientUserId: string
  category: NotificationCategory
  severity: NotificationSeverity
  /** Composed when the notification was raised, and never re-rendered. */
  title: string
  body: string
  actionHref: string | null
  correlationId: string | null
}

/* --------------------------------------------------------------- patches -- */

/**
 * What a release writes onto a row it has claimed.
 *
 * Only the columns a release may change. `channel`, `attempt` and
 * `notification_id` are absent because a release is the same delivery
 * happening later, not a different one.
 *
 * `attempt` in particular stays where it is, and that is a claim worth
 * stating: a deferred row has `attempted_at = null` — nothing was ever asked
 * of a transport — so the release IS attempt one rather than a retry of it.
 * Incrementing would also risk `notification_deliveries_attempt_unique`.
 */
export interface DeliveryPatch {
  status: NotificationDeliveryStatus
  provider: string | null
  providerMessageId: string | null
  errorCode: string | null
  errorDetail: string | null
  /** Text, and the table refuses a `suppressed` row without one. */
  suppressedReason: ReleaseSuppressionReason | null
  attemptedAt: Date | null
  settledAt: Date | null
}

/* ----------------------------------------------------------------- plans -- */

export type DeliveryReleaseDecision =
  /** Claim it, then ask the transport. The only branch that sends. */
  | { action: 'attempt' }
  /**
   * Ask nobody. One conditional update from `deferred` to this, and the
   * patch is built here so a test can assert on exactly what would be
   * written rather than on a description of it.
   */
  | { action: 'settle'; patch: DeliveryPatch }
  /**
   * Its time has not come. Left `deferred`, untouched.
   *
   * The query filters on `scheduled_for <= now`, so this should be
   * unreachable in production — it exists because a planner that is total
   * cannot be handed a row it will release early by accident.
   */
  | { action: 'leave'; detail: string }

export interface DeliveryReleasePlan {
  delivery: DueDelivery
  decision: DeliveryReleaseDecision
}

/**
 * What should happen to each of these rows, given the world as it is now.
 *
 * Pure. No repository, no transport call, no clock of its own — the same split
 * `routing.ts` and `delivery.ts` make, and for the same reason: every rule
 * below is a table of inputs, and the runner underneath is left with nothing
 * but sequencing and writes.
 */
export function planDeliveryRelease(args: {
  rows: readonly DueDelivery[]
  settings: NotificationSettings
  /**
   * That person's preferences, as they are NOW.
   *
   * A function rather than a map so the runner decides how to resolve them
   * and this stays pure; a `PreferenceSet` built from an empty list is the
   * correct answer for somebody who has never expressed an opinion, which is
   * why there is no "unknown recipient" branch below.
   */
  preferenceFor: (userId: string) => PreferenceSet
  transports: TransportRegistry
  now: Date
  /**
   * How long after its due time a deferral stops being worth sending.
   *
   * No default, deliberately. See the header.
   */
  staleAfterMinutes: number
}): readonly DeliveryReleasePlan[] {
  const { rows, settings, preferenceFor, transports, now, staleAfterMinutes } =
    args

  return rows.map((delivery) => ({
    delivery,
    decision: decide({
      delivery,
      settings,
      preference: preferenceFor(delivery.recipientUserId),
      transports,
      now,
      staleAfterMinutes,
    }),
  }))
}

function decide(args: {
  delivery: DueDelivery
  settings: NotificationSettings
  preference: PreferenceSet
  transports: TransportRegistry
  now: Date
  staleAfterMinutes: number
}): DeliveryReleaseDecision {
  const { delivery, settings, preference, transports, now, staleAfterMinutes } =
    args

  const lateBy = now.getTime() - delivery.scheduledFor.getTime()

  if (lateBy < 0) {
    return {
      action: 'leave',
      detail: `not due until ${delivery.scheduledFor.toISOString()}`,
    }
  }

  // Staleness is asked FIRST, before any gate. A four-day-old alert about a
  // stay that has since ended is not made appropriate by the channel being
  // configured and the window being open — and asking the gates first would
  // mean a stale row could be recorded as `channel_disabled`, which sends
  // somebody to fix a setting that was never the reason.
  if (lateBy > staleAfterMinutes * 60_000) {
    return {
      action: 'settle',
      patch: {
        status: 'suppressed',
        provider: null,
        providerMessageId: null,
        errorCode: null,
        errorDetail:
          `deferred until ${delivery.scheduledFor.toISOString()}, ` +
          `released ${Math.round(lateBy / 60_000)} minutes late, ` +
          `past the ${staleAfterMinutes}-minute bound; not sent`,
        suppressedReason: STALE_DEFERRAL,
        // Nothing was attempted, so nothing may claim it was.
        attemptedAt: null,
        settledAt: now,
      },
    }
  }

  // Gate 4 in `routing.ts`, run again against today's rows. A channel the
  // organization has since switched off resolves to `channel_disabled` in
  // here, because `PreferenceSet` was built with the current settings.
  const suppression = suppressionFor(
    preference.resolve(delivery.category, delivery.channel),
    delivery.severity,
  )
  if (suppression) {
    return {
      action: 'settle',
      patch: {
        status: 'suppressed',
        provider: null,
        providerMessageId: null,
        errorCode: null,
        errorDetail:
          'the recipient or the organization said no since it was deferred',
        suppressedReason: suppression,
        attemptedAt: null,
        settledAt: now,
      },
    }
  }

  // Before quiet hours, exactly as `routing.ts` orders them.
  if (!transports.isConfigured(delivery.channel)) {
    return {
      action: 'settle',
      patch: {
        status: 'not_configured',
        provider: null,
        providerMessageId: null,
        errorCode: null,
        errorDetail: `no transport is configured for ${delivery.channel}`,
        suppressedReason: null,
        attemptedAt: null,
        settledAt: now,
      },
    }
  }

  // Gate 5. The window may have been widened while this row waited.
  const verdict = quietHoursVerdict({
    channel: delivery.channel,
    severity: delivery.severity,
    settings,
    now,
  })
  if (verdict.held) {
    return {
      action: 'settle',
      patch: {
        status: 'suppressed',
        provider: null,
        providerMessageId: null,
        errorCode: null,
        errorDetail:
          'the quiet window had closed again by the time the sweep ran; ' +
          `it would next open at ${verdict.until.toISOString()}`,
        suppressedReason: 'quiet_hours',
        attemptedAt: null,
        settledAt: now,
      },
    }
  }

  return { action: 'attempt' }
}

/* ------------------------------------------------------------------ port -- */

/**
 * The two reads and one write a release needs, and nothing else.
 *
 * Deliberately narrow rather than the whole `NotificationRepository`: a sweep
 * that could reach `insertNotification` is a sweep that could invent a
 * notification, and the smallest port is the one a reviewer can hold in their
 * head while asking whether it can send twice.
 *
 * The real adapter belongs in `repository.ts` beside every other statement
 * about these tables — this file writes nothing directly. See the module
 * report.
 */
export interface DeliveryReleaseStore {
  /**
   * Deferred rows whose time has passed, oldest first, at most `limit` of
   * them.
   *
   * Bounded because a sweep that tried to release nine thousand rows in one
   * pass is a sweep that never finishes and holds the table while not
   * finishing. `scanned === limit` in the summary is how a caller knows to
   * run again.
   */
  listDueDeliveries(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueDelivery[]>

  /**
   * Move one row, and only if it is still where the caller thinks it is.
   *
   * `false` means the conditional update matched nothing — another sweep got
   * there first. It is the ordinary outcome of two overlapping runs and not a
   * failure. Implementations MUST include `status = from` in the predicate;
   * an implementation that updated unconditionally would make this whole file
   * a race.
   */
  transitionDelivery(args: {
    organizationId: string
    deliveryId: string
    from: NotificationDeliveryStatus
    patch: DeliveryPatch
  }): Promise<boolean>
}

/* --------------------------------------------------------------- summary -- */

export interface DeliveryReleaseSummary {
  /** Rows the query returned. Equal to `limit` means there may be more. */
  scanned: number
  /** Rows this sweep claimed and settled. */
  released: number
  /** Rows another sweep had already claimed. This one sent nothing for them. */
  lost: number
  /** Rows whose time had not come. Left `deferred`. */
  left: number
  /**
   * Rows this sweep sent and could not then write the outcome for.
   *
   * Counted rather than swallowed. It should be zero; if it is not, a row is
   * sitting in `pending` after something left the building, and that is a
   * fact somebody has to be able to see.
   */
  unsettled: number
  /** How every row this sweep released ended up. */
  tally: Record<NotificationDeliveryStatus, number>
}

/**
 * The claim, written as its own value so the two-phase path reads as two
 * phases.
 *
 * `attempted_at` is set here rather than at settle time: this instant is when
 * the transport is about to be asked, and a row that dies mid-flight should
 * say when it was picked up.
 */
function claimPatch(now: Date): DeliveryPatch {
  return {
    status: 'pending',
    provider: null,
    providerMessageId: null,
    errorCode: null,
    errorDetail: null,
    suppressedReason: null,
    attemptedAt: now,
    settledAt: null,
  }
}

/* ---------------------------------------------------------------- runner -- */

/**
 * Release everything due for one organization, one row at a time.
 *
 * Per organization rather than across all of them, because
 * `notification_deliveries_due_idx` is `(organization_id, scheduled_for)` and
 * because the settings and preferences a release re-checks are per
 * organization — a global sweep would resolve both per row or cache them
 * badly. A scheduler iterating organizations pays one extra query each and
 * gets a bounded, resumable, tenant-scoped unit of work in exchange.
 *
 * Sequential rather than concurrent, deliberately. The rows in one pass are
 * few by construction (the index is partial), and a `Promise.all` here would
 * open one transport connection per deferred alert at 07:00 sharp.
 */
export async function releaseDueDeliveries(args: {
  organizationId: string
  store: DeliveryReleaseStore
  transports: TransportRegistry
  /** The organization's settings as they are NOW. Never the ones at deferral. */
  settings: NotificationSettings
  /** That person's preference rows as they are NOW. Resolved once each. */
  loadPreferences: (userId: string) => Promise<PreferenceSet>
  now: Date
  /** How many rows this pass may take. Required — see the port. */
  limit: number
  /** How late is too late. Required — see the header. */
  staleAfterMinutes: number
}): Promise<DeliveryReleaseSummary> {
  const {
    organizationId,
    store,
    transports,
    settings,
    loadPreferences,
    now,
    limit,
    staleAfterMinutes,
  } = args

  const rows = await store.listDueDeliveries({
    organizationId,
    dueBefore: now,
    limit,
  })

  const summary: DeliveryReleaseSummary = {
    scanned: rows.length,
    released: 0,
    lost: 0,
    left: 0,
    unsettled: 0,
    tally: {} as Record<NotificationDeliveryStatus, number>,
  }

  if (rows.length === 0) return summary

  // Once per distinct recipient rather than once per row. A person with four
  // deferred alerts is one read, and every one of those four is then judged
  // against the same answer — which also means they cannot disagree.
  const preferences = new Map<string, PreferenceSet>()
  for (const userId of new Set(rows.map((row) => row.recipientUserId))) {
    preferences.set(userId, await loadPreferences(userId))
  }

  const empty = new PreferenceSet([], settings)
  const plans = planDeliveryRelease({
    rows,
    settings,
    preferenceFor: (userId) => preferences.get(userId) ?? empty,
    transports,
    now,
    staleAfterMinutes,
  })

  const count = (status: NotificationDeliveryStatus) => {
    summary.tally[status] = (summary.tally[status] ?? 0) + 1
  }

  for (const plan of plans) {
    if (plan.decision.action === 'leave') {
      summary.left += 1
      continue
    }

    if (plan.decision.action === 'settle') {
      const claimed = await store.transitionDelivery({
        organizationId,
        deliveryId: plan.delivery.id,
        from: 'deferred',
        patch: plan.decision.patch,
      })

      if (!claimed) {
        summary.lost += 1
        continue
      }

      summary.released += 1
      count(plan.decision.patch.status)
      continue
    }

    // The send path, and the only one that claims before it acts.
    const claimed = await store.transitionDelivery({
      organizationId,
      deliveryId: plan.delivery.id,
      from: 'deferred',
      patch: claimPatch(now),
    })

    if (!claimed) {
      summary.lost += 1
      continue
    }

    const patch = fromResult(
      await sendThrough({
        transport: transports.for(plan.delivery.channel),
        delivery: plan.delivery,
      }),
      now,
    )

    const settled = await store.transitionDelivery({
      organizationId,
      deliveryId: plan.delivery.id,
      from: 'pending',
      patch,
    })

    summary.released += 1
    count(patch.status)
    if (!settled) summary.unsettled += 1
  }

  return summary
}

/* ------------------------------------------------------------- transport -- */

/**
 * Ask the transport, and never let it break the sweep.
 *
 * The port forbids `send` from throwing. "The port forbids it" is not a
 * runtime guarantee, and a throw from one channel here would abandon every
 * remaining row in the pass — a single broken transport would stop the whole
 * queue draining, which is the defect this file closes, reintroduced. Same
 * wrapper and same `transport_threw` code as `dispatch.ts`.
 */
async function sendThrough(args: {
  transport: ReturnType<TransportRegistry['for']>
  delivery: DueDelivery
}): Promise<TransportResult> {
  const { transport, delivery } = args

  try {
    return await transport.send({
      organizationId: delivery.organizationId,
      notificationId: delivery.notificationId,
      channel: delivery.channel,
      to: { userId: delivery.recipientUserId },
      severity: delivery.severity,
      subject: delivery.title,
      body: delivery.body,
      actionHref: delivery.actionHref,
      correlationId: delivery.correlationId,
    })
  } catch (cause) {
    return {
      status: 'failed',
      provider: delivery.channel,
      errorCode: 'transport_threw',
      errorDetail: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
    }
  }
}

/**
 * A transport's answer, as columns.
 *
 * Mirrors `fromResult` in `dispatch.ts` — same statuses, same reasoning about
 * `settled_at` and `attempted_at` — over the narrower `DeliveryPatch` shape,
 * because a release may not touch `channel`, `attempt` or `scheduled_for` and
 * a patch that carried them could. The duplication is deliberate and small;
 * exporting the one in `dispatch.ts` would be better and is requested.
 */
function fromResult(result: TransportResult, now: Date): DeliveryPatch {
  const base = {
    providerMessageId: null,
    errorCode: null,
    errorDetail: null,
    suppressedReason: null,
    attemptedAt: now,
  }

  switch (result.status) {
    case 'sent':
      return {
        ...base,
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        // Not settled: a provider that accepted a message may still report a
        // bounce, and closing the row now would close something that has not
        // finished happening.
        settledAt: null,
      }

    case 'delivered':
      return {
        ...base,
        status: 'delivered',
        provider: result.provider,
        settledAt: now,
      }

    case 'failed':
      return {
        ...base,
        status: 'failed',
        provider: result.provider,
        errorCode: result.errorCode,
        errorDetail: result.errorDetail,
        settledAt: now,
      }

    case 'not_configured':
      // A transport that reported itself configured and then refused. The
      // release records what the original attempt would have recorded and
      // invents no delivery.
      return {
        ...base,
        status: 'not_configured',
        provider: null,
        // Nothing was attempted, so no timestamp claims one was.
        attemptedAt: null,
        errorDetail: result.reason,
        settledAt: now,
      }
  }
}
