/**
 * Letting a deferred guest message go, when its quiet window has actually
 * opened.
 *
 * ══ THE DEFECT THIS CLOSES ══════════════════════════════════════════════════
 *
 * `planOutward` holds an outward message that would reach a guest at 23:40 and
 * the operation writes `outcome = 'deferred'` with a `scheduled_for` of 07:00.
 * `0053` built `guest_messages_due_idx` for the sweep that would drain that
 * queue and said, in its own header, that nothing sweeps it. Nothing did. A
 * guesthouse that switched quiet hours on so as not to wake guests at midnight
 * did not send its payment reminders and arrival instructions late — it
 * stopped sending them at all, and nothing told anybody.
 *
 * A guest standing outside a locked door because the arrival information was
 * "held until seven" eleven hours ago is the failure this file exists to make
 * impossible. It is the outward twin of `notifications/release.ts`; the two
 * are separate files because the two tables are separate, and the arguments
 * that differ are the ones written out below.
 *
 * ══ RE-CHECKING IS THE WHOLE JOB ════════════════════════════════════════════
 *
 * A `scheduled_for` written at 22:10 is a claim about a world eight hours old.
 * In between the organization can widen its quiet hours or switch the channel
 * off, and — the case that has no equivalent on the internal side — the GUEST
 * can withdraw marketing consent, lose their telephone number from the card,
 * or have their booking removed. Releasing on the strength of the timestamp is
 * how a business that turned messaging off at midnight sends a batch at dawn.
 *
 * So the gate is re-run rather than assumed, and it is re-run by calling
 * `planOutward` — the same function that decided the deferral in the first
 * place, with today's registry and today's settings. Not one line of the two
 * gates or of `quietHoursVerdict` is restated here. A release that made its
 * own decision about whether the window is open would be a second opinion
 * about silence, and the failure mode of two opinions about silence is a
 * message neither layer thinks it dropped.
 *
 * The three checks that come BEFORE `planOutward` — the booking still exists,
 * the guest still consents, the address is still usable — are the same three
 * `operations.ts` makes, in the same order. There they are `BusinessRuleError`
 * refusals, because a person asked for something impossible; here they are
 * recorded outcomes, because nobody asked for anything: the sweep found a row
 * whose world had changed underneath it, and there is no caller to refuse.
 *
 * ══ THE ROW'S OWN OUTCOME IS THE LOCK ═══════════════════════════════════════
 *
 * Two sweeps overlapping must not both send a guest the same reminder. There
 * is no advisory lock and no queue table, because there does not need to be:
 * the claim is
 *
 *     update guest_messages set … where id = ? and outcome = 'deferred'
 *
 * and Postgres decides it. The loser's update matches zero rows and it moves
 * on having sent nothing. This is the same argument `repository.ts` makes
 * about `guest_messages_dedupe_key`, and `dispatch.ts` about
 * `notifications.dedupe_key`: the guarantee is a write the database
 * serialises, never a look-then-write in JavaScript, because every
 * look-then-write has a window between its halves and a sweep is exactly the
 * thing that runs twice at once.
 *
 * A separate lock would be strictly worse — a second piece of state that can
 * disagree with the row, held for a message already sent or released for one
 * still in flight, and reconciling the two is a job nobody writes.
 *
 * ── Where the two-phase claim is, and where it deliberately is not ────────
 *
 * A decision that asks NOBODY — suppressed, or `not_configured` — is a single
 * conditional update straight from `deferred` to its terminal outcome. No
 * window, so no intermediate state to get stuck in.
 *
 * Only a decision that will ask a provider claims first: `deferred` →
 * `pending`, then the send, then `pending` → its outcome. The honest cost is
 * that a process dying between the two leaves a `pending` row, and
 * `guest_messages_due_idx` is partial on `outcome = 'deferred'` so it does not
 * cover one — that gap is reported rather than papered over. The alternative,
 * sending before claiming, makes a race send a guest two payment reminders,
 * and there is no version of that which is better than a row somebody can see
 * is stuck.
 *
 * ══ CLEARING `scheduled_for` IS NOT TIDYING, IT IS THE CONSTRAINT ═══════════
 *
 * `guest_messages_scheduled_only_when_deferred` refuses any row that is not
 * `deferred` and still carries a time. So every transition out of `deferred`
 * must null it in the same statement — a patch that left it would fail the
 * write, not merely look untidy. The fact it carried is preserved in
 * `outcome_detail`, which is why each detail below names the instant.
 *
 * ══ A STALE DEFERRAL IS ABANDONED, AND SAYS SO ══════════════════════════════
 *
 * `staleAfterMinutes` has no default. A default would be this module quietly
 * deciding how late is too late on behalf of a business it knows nothing
 * about, and the cost of being wrong is a payment reminder arriving after the
 * guest has checked out — which is worse than never sending it, because it
 * reads as a bill for a stay that is over. The caller states the bound; the
 * sweep records the abandonment as `suppressed` with the reason in
 * `outcome_detail`, because a row left `deferred` forever is the same defect
 * one layer down.
 *
 * ══ NOTHING HERE INVENTS A DELIVERY ═════════════════════════════════════════
 *
 * With no provider configured — every deployment today — a released message
 * records `not_configured`, exactly as the original attempt would have.
 * `sent` is written only when a provider answered `sent`, and `delivered` is
 * never written at all: 0053's `guest_messages_never_claims_delivery` forbids
 * it, and nothing in this product can confirm a guest received anything.
 *
 * Every string this file writes is an English diagnostic, by the table's own
 * rule — `outcome_detail` is for whoever reads the row, and the Hebrew a
 * person sees comes from `notifications/labels.ts`. A provider's own words
 * never reach a screen, and neither do this file's.
 */

import type { NotificationSettings } from '../notifications/types'

import { isUsableAddress, recipientAddress } from './compose'
import { planOutward } from './delivery'
import type { GuestMessageSource } from './operations'
import type {
  MessageProvider,
  MessageProviderRegistry,
  ProviderResult,
} from './provider'
import type {
  GuestMessageRecord,
  GuestRecipient,
  MessageOutcome,
} from './types'
import { requiresMarketingConsent } from './types'

/* ------------------------------------------------------------------ rows -- */

/**
 * One deferred outward message, as the sweep reads it back.
 *
 * `GuestMessageRecord` narrowed rather than redeclared, so a column added to
 * the record arrives here without a second shape to update. The two narrowings
 * are both facts the table already guarantees, stated in the type so nothing
 * downstream needs a non-null assertion to use them:
 *
 *   · `outcome` is `deferred` — it is what the query filters on.
 *   · `scheduledFor` is a `Date` and never null —
 *     `guest_messages_deferred_has_time` refuses a deferral without one.
 */
export type DueGuestMessage = Omit<
  GuestMessageRecord,
  'outcome' | 'scheduledFor'
> & {
  outcome: 'deferred'
  scheduledFor: Date
}

/**
 * The row, plus the guest as they are NOW.
 *
 * The recipient is resolved by the runner and handed in rather than looked up
 * by the planner, because reading a guest's telephone number is a privileged
 * read and a pure function must not be the thing that performs one.
 * `null` means the booking or the guest is no longer readable — cancelled,
 * removed, or out of the sweeper's scope — and that is a decision, not an
 * error.
 */
export interface DueGuestMessageContext {
  message: DueGuestMessage
  recipient: GuestRecipient | null
}

/* --------------------------------------------------------------- patches -- */

/**
 * What a release writes onto a row it has claimed.
 *
 * Only the columns a release may change. `kind`, `channel`, `subject`, `body`
 * and `dedupe_key` are absent because a release is the same message going
 * later, not a different message — and the body in particular was composed at
 * send time and frozen for the reason `compose.ts` gives: a message about a
 * booking since cancelled must still say what it said.
 *
 * `scheduledFor` is typed `null` rather than `Date | null`, so the constraint
 * that forbids a non-deferred row from carrying a time is enforced by the
 * typechecker before it is enforced by Postgres.
 */
export interface GuestMessagePatch {
  outcome: MessageOutcome
  /** English, diagnostic. See the header. */
  outcomeDetail: string | null
  provider: string | null
  providerMessageId: string | null
  scheduledFor: null
  settledAt: Date | null
}

/* ----------------------------------------------------------------- plans -- */

export type GuestMessageReleaseDecision =
  /** Claim it, then ask the provider. The only branch that sends. */
  | { action: 'attempt'; to: string }
  /**
   * Ask nobody. One conditional update from `deferred` to this, and the patch
   * is built here so a test can assert on exactly what would be written.
   */
  | { action: 'settle'; patch: GuestMessagePatch }
  /**
   * Its time has not come. Left `deferred`, untouched.
   *
   * The query filters on `scheduled_for <= now`, so this is unreachable in
   * production — it exists because a planner that is total cannot be handed a
   * row it releases eight hours early by accident.
   */
  | { action: 'leave'; detail: string }

export interface GuestMessageReleasePlan {
  message: DueGuestMessage
  decision: GuestMessageReleaseDecision
}

/**
 * What should happen to each of these rows, given the world as it is now.
 *
 * Pure. No repository, no provider call, no clock of its own — the same split
 * `delivery.ts` and `notifications/routing.ts` make, and for the same reason:
 * every rule below is a table of inputs, and the runner underneath is left
 * with nothing but sequencing and writes.
 */
export function planMessageRelease(args: {
  rows: readonly DueGuestMessageContext[]
  providers: MessageProviderRegistry
  /** The organization's settings as they are NOW. Never those at deferral. */
  settings: NotificationSettings
  now: Date
  /**
   * How long after its due time a deferral stops being worth sending.
   *
   * No default, deliberately. See the header.
   */
  staleAfterMinutes: number
}): readonly GuestMessageReleasePlan[] {
  const { rows, providers, settings, now, staleAfterMinutes } = args

  return rows.map((row) => ({
    message: row.message,
    decision: decide({
      message: row.message,
      recipient: row.recipient,
      providers,
      settings,
      now,
      staleAfterMinutes,
    }),
  }))
}

function abandoned(args: {
  outcomeDetail: string
  now: Date
}): GuestMessageReleaseDecision {
  return {
    action: 'settle',
    patch: {
      outcome: 'suppressed',
      outcomeDetail: args.outcomeDetail,
      // Nothing was asked of anybody, so no provider is named and no
      // provider's id is claimed.
      provider: null,
      providerMessageId: null,
      scheduledFor: null,
      settledAt: args.now,
    },
  }
}

function decide(args: {
  message: DueGuestMessage
  recipient: GuestRecipient | null
  providers: MessageProviderRegistry
  settings: NotificationSettings
  now: Date
  staleAfterMinutes: number
}): GuestMessageReleaseDecision {
  const { message, recipient, providers, settings, now, staleAfterMinutes } =
    args

  const due = message.scheduledFor.toISOString()
  const lateBy = now.getTime() - message.scheduledFor.getTime()

  if (lateBy < 0) return { action: 'leave', detail: `not due until ${due}` }

  // Staleness is asked FIRST, before every other question. A payment reminder
  // four days past its window is not made appropriate by the channel being
  // connected and the guest still consenting — and asking the gates first
  // would let a stale row be recorded as `not_configured`, which would tell a
  // business to buy an SMS gateway to fix a message it should not send.
  if (lateBy > staleAfterMinutes * 60_000) {
    return abandoned({
      now,
      outcomeDetail:
        `deferred until ${due}, released ${Math.round(lateBy / 60_000)} ` +
        `minutes late, past the ${staleAfterMinutes}-minute bound; not sent`,
    })
  }

  // The booking or the guest is gone. `operations.ts` cannot reach this case —
  // it loads before it acts — and a sweep runs hours later, so it can.
  if (recipient === null) {
    return abandoned({
      now,
      outcomeDetail: `deferred until ${due}; the booking or guest is no longer readable`,
    })
  }

  // Consent as it is NOW, not as it was at 22:10. The one gate whose answer
  // belongs to the guest rather than to the business.
  if (requiresMarketingConsent(message.kind) && !recipient.marketingConsent) {
    return abandoned({
      now,
      outcomeDetail: `deferred until ${due}; the guest has not consented to marketing messages`,
    })
  }

  const address = recipientAddress(message.channel, recipient)
  if (address === null || !isUsableAddress(message.channel, address)) {
    return abandoned({
      now,
      outcomeDetail: `deferred until ${due}; the guest has no usable ${message.channel} address`,
    })
  }

  // The two gates, re-run. Same function, same order, current world.
  const plan = planOutward({
    kind: message.kind,
    channel: message.channel,
    providers,
    settings,
    now,
  })

  if (plan.action === 'record') {
    // Gate 1 said there is nothing behind this channel. Recorded as exactly
    // what the original attempt would have recorded, and no delivery is
    // invented — see the header.
    return {
      action: 'settle',
      patch: {
        outcome: 'not_configured',
        outcomeDetail: `deferred until ${due}; ${plan.detail}`,
        provider: null,
        providerMessageId: null,
        scheduledFor: null,
        settledAt: now,
      },
    }
  }

  if (plan.action === 'hold') {
    // Gate 2 held it AGAIN — the window was widened while this row waited.
    //
    // Recorded `suppressed` rather than deferred to the new time, and that is
    // the arguable call in this file, so: re-deferring reads kinder and is
    // not. A business that keeps widening its window would produce a row
    // rescheduled forever, never sent, and never once saying it was not sent —
    // the exact silence this file exists to end. The staleness bound would
    // abandon it in the end anyway, so re-deferral buys nothing but a longer
    // period of a screen saying "waiting" about a message that will not go.
    return abandoned({
      now,
      outcomeDetail:
        `deferred until ${due}; the quiet window had closed again by the ` +
        `time the sweep ran, and would next open at ` +
        `${plan.scheduledFor.toISOString()}`,
    })
  }

  return { action: 'attempt', to: address }
}

/* ------------------------------------------------------------------ port -- */

/**
 * The one read and one write a release needs, and nothing else.
 *
 * Deliberately narrow rather than the whole `MessagingRepository`: a sweep
 * that could reach `recordGuestMessage` is a sweep that could compose a new
 * message to a guest, and the smallest port is the one a reviewer can hold in
 * their head while asking whether it can send twice.
 *
 * The real adapter belongs in `repository.ts`, beside every other statement
 * this module makes about `guest_messages` — a second Supabase class writing
 * the same table is how two files end up with two opinions about a column.
 * This file therefore writes nothing directly and is handed the port. See the
 * module report.
 */
export interface GuestMessageReleaseStore {
  /**
   * Deferred rows whose time has passed, oldest first, at most `limit`.
   *
   * Bounded because a sweep that tried to release nine thousand rows in one
   * pass is a sweep that never finishes and holds the table while not
   * finishing. `scanned === limit` in the summary is how a caller knows to
   * run again.
   */
  listDueMessages(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueGuestMessage[]>

  /**
   * Move one row, and only if it is still where the caller thinks it is.
   *
   * `false` means the conditional update matched nothing — another sweep got
   * there first. The ordinary outcome of two overlapping runs, and not a
   * failure. Implementations MUST include `outcome = from` in the predicate;
   * one that updated unconditionally would make this whole file a race.
   */
  transitionGuestMessage(args: {
    organizationId: string
    messageId: string
    from: MessageOutcome
    patch: GuestMessagePatch
  }): Promise<boolean>
}

/* --------------------------------------------------------------- summary -- */

export interface GuestMessageReleaseSummary {
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
   * sitting in `pending` after something left the building, and that is a fact
   * somebody has to be able to see.
   */
  unsettled: number
  /** How every row this sweep released ended up. */
  tally: Record<string, number>
}

/**
 * The claim, written as its own value so the two-phase path reads as two.
 *
 * `scheduled_for` is nulled here and not at settle time, because this is the
 * statement that leaves `deferred` and the constraint bites on this one.
 */
function claimPatch(): GuestMessagePatch {
  return {
    outcome: 'pending',
    outcomeDetail: null,
    provider: null,
    providerMessageId: null,
    scheduledFor: null,
    // Nothing has finished. A `settled_at` written now would close a row that
    // is about to be handed to a provider.
    settledAt: null,
  }
}

/* ---------------------------------------------------------------- runner -- */

/**
 * Release everything due for one organization, one row at a time.
 *
 * Per organization rather than across all of them: `guest_messages` is behind
 * row level security that asks `my_organizations()` and `has_permission(…,
 * 'message.send')`, the settings a release re-checks are per organization, and
 * a scheduler iterating organizations gets a bounded, resumable,
 * tenant-scoped unit of work for the price of one extra query each.
 *
 * Sequential rather than concurrent, deliberately. The rows in one pass are
 * few by construction, and a `Promise.all` here would open one provider
 * connection per held message at 07:00 sharp — the shape of load that gets an
 * account rate-limited on the morning it finally starts working.
 */
export async function releaseDueMessages(args: {
  organizationId: string
  store: GuestMessageReleaseStore
  providers: MessageProviderRegistry
  /** The guest and the booking, read fresh. Never the snapshot on the row. */
  guests: GuestMessageSource
  /** The organization's settings as they are NOW. */
  settings: NotificationSettings
  now: Date
  /** How many rows this pass may take. Required — see the port. */
  limit: number
  /** How late is too late. Required — see the header. */
  staleAfterMinutes: number
}): Promise<GuestMessageReleaseSummary> {
  const {
    organizationId,
    store,
    providers,
    guests,
    settings,
    now,
    limit,
    staleAfterMinutes,
  } = args

  const rows = await store.listDueMessages({
    organizationId,
    dueBefore: now,
    limit,
  })

  const summary: GuestMessageReleaseSummary = {
    scanned: rows.length,
    released: 0,
    lost: 0,
    left: 0,
    unsettled: 0,
    tally: {},
  }

  if (rows.length === 0) return summary

  // Once per distinct booking rather than once per row. Three deferred
  // messages about one stay are one read, and all three are then judged
  // against the same guest — which also means they cannot disagree about
  // whether that guest still consents.
  const loaded = new Map<string, GuestRecipient | null>()
  for (const bookingId of new Set(rows.map((row) => row.bookingId))) {
    const found = await guests.load(organizationId, bookingId)
    loaded.set(bookingId, found?.recipient ?? null)
  }

  const plans = planMessageRelease({
    rows: rows.map((message) => ({
      message,
      recipient: loaded.get(message.bookingId) ?? null,
    })),
    providers,
    settings,
    now,
    staleAfterMinutes,
  })

  const count = (outcome: MessageOutcome) => {
    summary.tally[outcome] = (summary.tally[outcome] ?? 0) + 1
  }

  for (const plan of plans) {
    if (plan.decision.action === 'leave') {
      summary.left += 1
      continue
    }

    if (plan.decision.action === 'settle') {
      const claimed = await store.transitionGuestMessage({
        organizationId,
        messageId: plan.message.id,
        from: 'deferred',
        patch: plan.decision.patch,
      })

      if (!claimed) {
        summary.lost += 1
        continue
      }

      summary.released += 1
      count(plan.decision.patch.outcome)
      continue
    }

    // The send path, and the only one that claims before it acts.
    const claimed = await store.transitionGuestMessage({
      organizationId,
      messageId: plan.message.id,
      from: 'deferred',
      patch: claimPatch(),
    })

    if (!claimed) {
      summary.lost += 1
      continue
    }

    const patch = fromResult({
      result: await sendThrough({
        provider: providers.for(plan.message.channel),
        message: plan.message,
        to: plan.decision.to,
        organizationId,
      }),
      message: plan.message,
      now,
    })

    const settled = await store.transitionGuestMessage({
      organizationId,
      messageId: plan.message.id,
      from: 'pending',
      patch,
    })

    summary.released += 1
    count(patch.outcome)
    if (!settled) summary.unsettled += 1
  }

  return summary
}

/* -------------------------------------------------------------- provider -- */

/**
 * Ask the provider, and never let it break the sweep.
 *
 * The port forbids `send` from throwing. "The port forbids it" is not a
 * runtime guarantee, and a throw from one channel here would abandon every
 * remaining row in the pass — one broken provider stopping the whole queue
 * draining is this file's own defect, reintroduced. Same wrapper and same
 * `provider_threw` code as `operations.ts`.
 */
async function sendThrough(args: {
  provider: MessageProvider
  message: DueGuestMessage
  to: string
  organizationId: string
}): Promise<ProviderResult> {
  const { provider, message, to, organizationId } = args

  try {
    return await provider.send({
      organizationId,
      // The row exists, so the provider gets its real id. The original
      // attempt could only pass the dedupe key, because it was sending before
      // the row was written.
      messageId: message.id,
      channel: message.channel,
      kind: message.kind,
      to,
      subject: message.subject,
      // Frozen at composition. Not re-rendered here, for the reason
      // `compose.ts` gives: a message about a booking since cancelled must
      // still say what it said.
      body: message.body,
      correlationId: message.correlationId,
    })
  } catch (cause) {
    return {
      status: 'failed',
      provider: provider.name,
      errorCode: 'provider_threw',
      errorDetail: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
    }
  }
}

/**
 * A provider's answer, as columns.
 *
 * Mirrors the mapping in `operations.ts` — same three statuses, same
 * separation of `failed` from `not_configured`, and `delivered` is
 * unreachable because `ProviderResult` does not offer it and 0053 forbids it.
 */
function fromResult(args: {
  result: ProviderResult
  message: DueGuestMessage
  now: Date
}): GuestMessagePatch {
  const { result, message, now } = args
  const due = message.scheduledFor.toISOString()

  const base = {
    scheduledFor: null,
    providerMessageId: null,
  } as const

  switch (result.status) {
    case 'sent':
      return {
        ...base,
        outcome: 'sent',
        outcomeDetail: `released from a deferral scheduled for ${due}`,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        // Not settled: a provider that accepted a message may still report a
        // bounce, and closing the row now would close something that has not
        // finished happening.
        settledAt: null,
      }

    case 'failed':
      return {
        ...base,
        outcome: 'failed',
        outcomeDetail:
          `deferred until ${due}; ` +
          `${result.errorCode}: ${result.errorDetail ?? ''}`.trim(),
        provider: result.provider,
        settledAt: now,
      }

    case 'not_configured':
      // A provider that reported itself configured and then refused. Recorded
      // as what it is rather than as a failure — the business gap and the
      // broken integration are different purchases. No provider name is
      // written, because `guest_messages_not_configured_has_no_id` and the
      // original attempt both leave it null.
      return {
        ...base,
        outcome: 'not_configured',
        outcomeDetail: `deferred until ${due}; ${result.reason}`,
        provider: null,
        settledAt: now,
      }
  }
}
