/**
 * The three domain commands Autopilot's catalogue names and its executor
 * records as `command_not_implemented`.
 *
 *     messaging.sendGuestMessage  → messaging.guest_message.send
 *     messaging.notifyAssignee    → messaging.assignee.notify
 *     notifications.notifyTeam    → messaging.team.notify
 *
 * Five external-communication actions were blocked on these: the guest payment
 * reminder, the arrival information, the review request, notifying a cleaner
 * and escalating a late one. All five go through `defineOperation`, which is
 * the point — Autopilot writes no business table, it calls the same operation
 * a person's click calls, and "Autopilot did it" and "דנה did it" become the
 * same kind of record with a different actor.
 *
 * ══ TWO OF THE THREE ADD ALMOST NOTHING, AND THAT IS THE RIGHT ANSWER ═══════
 *
 * `notifyAssignee` and `notifyTeam` are addressed to people who ARE users of
 * this system, and everything that has to be decided about telling a user
 * something is already decided in `src/lib/notifications`: whether the event is
 * notifiable, whether this person may be told (one `authorize` call settling
 * membership, tenant, grant, plan entitlement and scope), whether they caused
 * it themselves, whether they want it on that channel, and whether it may wake
 * them now. Then `dispatch` writes the rows, asks each transport, and records
 * `not_configured` for the ones with nothing behind them.
 *
 * So both operations are `route()` followed by `dispatch()` with a candidate
 * list, wrapped in the pipeline that gives them a permission gate, a
 * validated input, a transaction and an audit event. **No routing rule,
 * preference rule, quiet-hours rule or transport is reimplemented here.** If
 * one had been, this module would have become a second opinion about who gets
 * woken at night, and the failure mode of two opinions about silence is a
 * message neither layer thinks it dropped.
 *
 * ══ NEITHER OF THEM PUBLISHES A DOMAIN EVENT, AND THAT IS DELIBERATE ════════
 *
 * Both are a FAN-OUT of an event they were handed — the caller says which
 * frozen name they are telling people about, because `route()` cannot work
 * without a catalogued event. Publishing that same name again on the way out
 * would be an echo: any event→notification bridge would route it a second
 * time, and the only thing standing between a colleague and two identical
 * messages would be a dedupe key collision. Correctness resting on a collision
 * is not correctness.
 *
 * The frozen catalogue has no name for "a person was notified", and it is not
 * editable from here. That absence is reported rather than worked around; what
 * is NOT missing is the record, because the pipeline writes an audit event for
 * every one of these and `notifications` writes a row per recipient.
 *
 * ══ THE GUEST HALF IS THE ONLY NEW THING ════════════════════════════════════
 *
 * A guest has no `Actor`, no membership, no preference row and no bell panel,
 * so the notifications engine cannot carry them and pretending otherwise would
 * mean minting fake users. `sendGuestMessage` therefore has its own storage,
 * its own provider port and its own null provider — built to the same shape,
 * for the same reason, with `not_configured` as a first-class outcome.
 *
 * ══ THE ONE RULE THIS FILE EXISTS TO KEEP ═══════════════════════════════════
 *
 * **A message is never reported as sent unless something left the building.**
 * With no provider configured — which is every deployment today — the message
 * is composed, recorded with `outcome: 'not_configured'`, and the operation
 * returns that outcome honestly. It does not throw, because nothing went
 * wrong; it does not return success-shaped silence, because a guest was not
 * told; and it does NOT publish `payment.instructions_sent`, because no
 * instructions were sent and an event is the past tense of something the
 * business did.
 */

import { BusinessRuleError } from '../errors'
import { isDomainEvent, type DomainEventName } from '../contracts/events'
import { specFor } from '../notifications/catalogue'
import { dispatch } from '../notifications/dispatch'
import { CHANNEL_LABEL, DELIVERY_STATUS_LABEL } from '../notifications/labels'
import type { NotificationRepository } from '../notifications/repository'
import { route, type NotificationCandidate } from '../notifications/routing'
import type { TransportRegistry } from '../notifications/transport'
import type { NotificationSettings } from '../notifications/types'
import { defineOperation, s, type TransactionHandle } from '../service'

import {
  compose,
  isUsableAddress,
  maskRecipient,
  recipientAddress,
} from './compose'
import { planOutward } from './delivery'
import type {
  MessageProvider,
  MessageProviderRegistry,
  OutboundGuestMessage,
  ProviderResult,
} from './provider'
import type { MessagingRepository } from './repository'
import {
  EVENT_FOR_KIND,
  GUEST_CHANNELS,
  GUEST_MESSAGE_KINDS,
  KIND_LABEL,
  claimsDelivery,
  requiresMarketingConsent,
  type GuestChannel,
  type GuestMessageKind,
  type GuestMessageRecord,
  type GuestMessageSubject,
  type GuestRecipient,
  type MessageOutcome,
} from './types'

/* ------------------------------------------------------------------ ports -- */

/**
 * Everything a guest message needs to say something true.
 *
 * A port rather than a query, and a flat projection rather than the rows,
 * because this module must not become a second place that decides what
 * `guests.marketing_consent` means or which column holds a telephone number.
 * Whoever implements this has already read those columns under
 * `guest.view_phone` and `guest.view_email`.
 */
export interface GuestMessageSource {
  load(
    organizationId: string,
    bookingId: string,
  ): Promise<{
    recipient: GuestRecipient
    subject: GuestMessageSubject
  } | null>
}

/**
 * Who inside the business could be told, as the routing engine needs them.
 *
 * Deliberately returns candidates rather than user ids. The `Actor` must be the
 * RESOLVED one — grants flattened from roles, plan entitlements attached, scope
 * narrowed — built by `src/lib/actor` exactly as it is for a request. This
 * module resolves nobody and must not: a second resolution is a second answer
 * to "what may this person see".
 */
export interface StaffRecipientSource {
  /** One person. `null` when they are not a member of this organization. */
  forUser(
    organizationId: string,
    userId: string,
  ): Promise<NotificationCandidate | null>
  /**
   * Everybody who might be told. Routing decides which of them actually is —
   * this returns the pool, not the audience, because narrowing it here would
   * be the grant check happening twice in two places.
   */
  team(organizationId: string): Promise<readonly NotificationCandidate[]>
}

export interface MessagingOperationDeps {
  /** Outward messages. The only storage this module owns. */
  messages: MessagingRepository
  /** Outward transports. Null in every deployment today. */
  providers: MessageProviderRegistry
  guests: GuestMessageSource
  staff: StaffRecipientSource
  /** The notifications module's own store. Written by `dispatch`, not by us. */
  notifications: NotificationRepository
  /** The notifications module's own transports. Passed through untouched. */
  transports: TransportRegistry
  /** Quiet hours and enabled channels live here. One source, already resolved. */
  settings(organizationId: string): Promise<NotificationSettings>
}

/* ----------------------------------------------------------------- shapes -- */

interface GuestMessageEntity {
  recipient: GuestRecipient
  subject: GuestMessageSubject
}

export interface SendGuestMessageInput {
  bookingId: string
  kind: GuestMessageKind
  channel: GuestChannel
}

export interface SendGuestMessageResult {
  message: GuestMessageRecord
  /** `false` when this exact intent had already been recorded. Not a failure. */
  created: boolean
  /** Convenience for a caller that only wants the answer. */
  outcome: MessageOutcome
}

export interface NotifyResult {
  /** How many notification rows this call actually created. */
  notified: number
  /** Planned notifications the dedupe constraint already held. */
  duplicates: number
  /** Who was not told, and why. Never an empty silence. */
  skipped: readonly { userId: string; reason: string }[]
  /** How every delivery this call wrote ended up. */
  tally: Record<string, number>
}

/* ------------------------------------------------------------------ dedupe -- */

/**
 * One intent, one row.
 *
 * The caller's own idempotency key is the stable part — `contracts/events.ts`
 * defines it as stable across retries and every Autopilot dispatch carries
 * one. Falling back to the correlation id is a real weakening and is stated
 * rather than hidden: a correlation id is per REQUEST, so a caller that
 * supplies no key gets no protection against sending the same guest the same
 * reminder twice. Autopilot always supplies one.
 */
function guestDedupeKey(args: {
  bookingId: string
  kind: GuestMessageKind
  channel: GuestChannel
  idempotencyKey: string | null | undefined
  correlationId: string
}): string {
  const stable = args.idempotencyKey ?? args.correlationId
  return `${args.bookingId}:${args.kind}:${args.channel}:${stable}`
}

/* -------------------------------------------------------------- operations -- */

export function defineMessagingOperations(deps: MessagingOperationDeps) {
  const { messages, providers, guests, staff, notifications, transports } = deps

  /* ── 1 · a message to a guest ─────────────────────────────────────────── */

  const sendGuestMessage = defineOperation<
    SendGuestMessageInput,
    GuestMessageEntity,
    SendGuestMessageResult
  >({
    name: 'messaging.guest_message.send',
    permission: 'message.send',
    resourceType: 'guest_message',

    input: s.object({
      bookingId: s.uuid({ label: 'הזמנה' }),
      kind: s.enumOf(GUEST_MESSAGE_KINDS, { label: 'סוג ההודעה' }),
      channel: s.enumOf(GUEST_CHANNELS, { label: 'ערוץ' }),
    }),

    /**
     * The booking, the guest and the organization's own name.
     *
     * The resource it returns carries the booking's property, so the second
     * `assertCan` narrows by scope: a property manager holding two properties
     * cannot message a guest of the third, and that refusal comes from
     * `isWithinScope` rather than from anything written here.
     */
    async loadResource({ input, context }) {
      const loaded = await guests.load(
        context.actor.organizationId,
        input.bookingId,
      )
      if (!loaded) return null

      return {
        resource: {
          organizationId: context.actor.organizationId,
          family: 'guest' as const,
          ...(loaded.subject.propertyId === null
            ? {}
            : { propertyId: loaded.subject.propertyId }),
        },
        entity: loaded,
      }
    },

    /**
     * The two refusals, and why they are refusals rather than recorded
     * outcomes.
     *
     * A message with nowhere to go and a marketing message to somebody who
     * said no are both cases where the CALLER asked for something that cannot
     * be done — not cases where the product tried and something was missing.
     * Recording them as outcomes would let Autopilot's activity screen show
     * `executed` beside a guest who was never going to be written to, and the
     * one thing that screen has to be able to say is which actions really did
     * something.
     *
     * Both messages name the fix, because both are fixable by the person
     * reading them: fill in the telephone number, or ask the guest.
     */
    rule({ input, entity }) {
      const address = recipientAddress(input.channel, entity.recipient)

      if (address === null || !isUsableAddress(input.channel, address)) {
        throw new BusinessRuleError({
          code: 'messaging.no_contact_detail',
          message: `guest has no usable ${input.channel} address`,
          userMessage:
            input.channel === 'email'
              ? 'לאורח אין כתובת דוא״ל תקינה בכרטיס, ולכן אין לאן לשלוח. אפשר להשלים את הכתובת בכרטיס האורח ולנסות שוב, או לשלוח בערוץ אחר.'
              : 'לאורח אין מספר טלפון תקין בכרטיס, ולכן אין לאן לשלוח. אפשר להשלים את המספר בכרטיס האורח ולנסות שוב, או לשלוח בדוא״ל.',
        })
      }

      if (
        requiresMarketingConsent(input.kind) &&
        !entity.recipient.marketingConsent
      ) {
        throw new BusinessRuleError({
          code: 'messaging.no_marketing_consent',
          message: 'guest has not consented to marketing messages',
          userMessage:
            'האורח לא אישר קבלת פניות שיווקיות, ולכן לא נשלחה בקשת חוות דעת. תזכורות תשלום ופרטי הגעה אינם תלויים באישור הזה ונשלחים כרגיל.',
        })
      }
    },

    async execute({ input, entity, context, request, correlationId, now, tx }) {
      const settings = await deps.settings(context.actor.organizationId)
      const composed = compose({
        kind: input.kind,
        channel: input.channel,
        recipient: entity.recipient,
        subject: entity.subject,
      })

      // `rule` has already refused a missing address, so this is the same
      // value it validated. Read again rather than threaded through, because a
      // value carried between two steps is a value that can be edited in one
      // of them.
      const address = recipientAddress(input.channel, entity.recipient) ?? ''

      const plan = planOutward({
        kind: input.kind,
        channel: input.channel,
        providers,
        settings,
        now,
      })

      let outcome: MessageOutcome = plan.outcome
      let detail: string | null = plan.detail
      let provider: string | null = null
      let providerMessageId: string | null = null

      if (plan.action === 'send') {
        const result = await sendThrough({
          provider: providers.for(input.channel),
          message: {
            organizationId: context.actor.organizationId,
            // The row does not exist yet. The provider is given the dedupe key
            // instead of an id it could not have — an id invented here would be
            // one nothing in the database ever matches.
            messageId: guestDedupeKey({
              bookingId: input.bookingId,
              kind: input.kind,
              channel: input.channel,
              idempotencyKey: request.idempotencyKey,
              correlationId,
            }),
            channel: input.channel,
            kind: input.kind,
            to: address,
            subject: composed.subject,
            body: composed.body,
            correlationId,
          },
        })

        provider = result.provider
        if (result.status === 'sent') {
          outcome = 'sent'
          providerMessageId = result.providerMessageId
          detail = null
        } else if (result.status === 'failed') {
          outcome = 'failed'
          detail = `${result.errorCode}: ${result.errorDetail ?? ''}`.trim()
        } else {
          // A provider that reported itself configured and then refused. Rare,
          // and recorded as what it is rather than as a failure — the business
          // gap and the broken integration are different purchases.
          outcome = 'not_configured'
          detail = result.reason
        }
      }

      const { record, created } = await messages.recordGuestMessage(
        {
          organizationId: context.actor.organizationId,
          propertyId: entity.subject.propertyId,
          bookingId: input.bookingId,
          guestId: entity.recipient.guestId,
          kind: input.kind,
          channel: input.channel,
          subject: composed.subject,
          body: composed.body,
          // Masked before it is stored, never after. `guest_messages` would
          // otherwise become the one table where every guest telephone number
          // is listed together, and it is a table an operations screen reads.
          recipientMasked: maskRecipient(address),
          outcome,
          outcomeDetail: detail,
          provider,
          providerMessageId,
          scheduledFor: plan.scheduledFor,
          correlationId,
          dedupeKey: guestDedupeKey({
            bookingId: input.bookingId,
            kind: input.kind,
            channel: input.channel,
            idempotencyKey: request.idempotencyKey,
            correlationId,
          }),
          createdBy: context.actor.userId,
          // Nothing is in flight for any outcome but `sent`, so everything else
          // is finished the moment it is written. A `sent` row stays open
          // because a provider that accepted a message may still report a
          // bounce.
          settledAt: outcome === 'sent' ? null : now,
        },
        tx,
      )

      return { message: record, created, outcome: record.outcome }
    },

    /**
     * The sentence somebody reads six weeks later.
     *
     * It names the outcome, in Hebrew, from the shared label map — because
     * "הודעה נשלחה לאורח" beside a row that never left the building is exactly
     * the lie this module was built to remove. `אין ערוץ מחובר` is what an
     * unsent message says about itself, in the audit trail, permanently.
     */
    audit({ input, entity, result }) {
      const kind = KIND_LABEL[input.kind]
      const channel = CHANNEL_LABEL[input.channel]
      const status = DELIVERY_STATUS_LABEL[result.outcome]

      return {
        resourceId: result.message.id,
        propertyId: entity.subject.propertyId,
        after: {
          kind: input.kind,
          channel: input.channel,
          outcome: result.outcome,
          booking_id: input.bookingId,
          recipient: result.message.recipientMasked,
        },
        summary: `${kind} לאורח בהזמנה ${entity.subject.reference} בערוץ ${channel} — ${status}.`,
      }
    },

    /**
     * The frozen event, and only when it is true.
     *
     * `payment.instructions_sent`, `arrival.instructions_released` and
     * `booking.review_requested` all already exist in
     * `src/lib/contracts/events.ts`; none is invented and that file is not
     * edited. What IS decided here is when to raise one, and the answer is:
     * only when something actually left the building.
     *
     * An event is the past tense of something the business did. Raising
     * `payment.instructions_sent` for a message that was recorded as
     * `not_configured` would tell every subscriber — the automations, the
     * dashboards, the guest journey — that a guest has been told how to pay
     * when nobody has told them anything. That is worse than raising nothing,
     * because a silence can be noticed and a false confirmation cannot.
     *
     * A `deferred` message raises nothing YET, and there is nothing in this
     * codebase that releases a deferred outward message when its window opens.
     * That gap is reported rather than papered over.
     */
    events({ input, entity, result }) {
      if (!claimsDelivery(result.outcome)) return []

      return [
        {
          name: EVENT_FOR_KIND[input.kind],
          propertyId: entity.subject.propertyId,
          payload: {
            bookingId: input.bookingId,
            reference: entity.subject.reference,
            guestId: entity.recipient.guestId,
            channel: input.channel,
            kind: input.kind,
            messageId: result.message.id,
          },
        },
      ]
    },
  })

  /* ── 2 · a message to the person a task is assigned to ────────────────── */

  /**
   * The two facts this operation is allowed to fan out.
   *
   * A closed pair rather than a free event name, because the operation asserts
   * the fact without verifying it: it does not read the task, so a caller that
   * says `overdue` about a task that is not overdue produces a true-looking
   * notification about a false thing. Two members keep that surface as small
   * as it can be while covering both Autopilot actions — `cleaner.notify`
   * fires when work has been assigned and `cleaner.escalate` when it is late.
   */
  const ASSIGNEE_REASONS = ['assigned', 'overdue'] as const
  const EVENT_FOR_REASON: Record<
    (typeof ASSIGNEE_REASONS)[number],
    DomainEventName
  > = {
    assigned: 'task.assigned',
    overdue: 'task.overdue',
  }

  const notifyAssignee = defineOperation<
    {
      taskId: string
      assigneeUserId: string
      reason: (typeof ASSIGNEE_REASONS)[number]
      summary?: string
      propertyId?: string
    },
    null,
    NotifyResult
  >({
    name: 'messaging.assignee.notify',
    // The grant Autopilot's `cleaner.notify` and `cleaner.escalate` both
    // declare, and the right one: deciding who a job belongs to and telling
    // them it does are the same authority.
    permission: 'task.assign',
    resourceType: 'task',

    input: s.object({
      taskId: s.uuid({ label: 'משימה' }),
      assigneeUserId: s.uuid({ label: 'אחראי' }),
      reason: s.enumOf(ASSIGNEE_REASONS, { label: 'סיבה' }),
      // Hebrew, and it reaches a person. `eventDetail` in the notifications
      // module reads exactly this key off the payload and appends it to the
      // catalogue's own wording — "חדר 4, משפחת לוי" — which is why it is
      // named `summary` here rather than anything more descriptive.
      summary: s.optional(s.string({ label: 'פירוט', max: 200 })),
      propertyId: s.optional(s.uuid({ label: 'נכס' })),
    }),

    async execute({ input, context, request, correlationId, now, tx }) {
      const candidate = await staff.forUser(
        context.actor.organizationId,
        input.assigneeUserId,
      )

      // Not a routing skip: the person named is not in this organization at
      // all. Refused rather than recorded as "nobody was told", because those
      // are different problems and only one of them is a typo.
      if (!candidate) {
        throw new BusinessRuleError({
          code: 'messaging.assignee_not_a_member',
          message: 'the assignee is not a member of this organization',
          userMessage:
            'האחראי שצוין אינו חבר פעיל במרחב העבודה הזה, ולכן לא נשלחה אליו הודעה.',
        })
      }

      return fanOut({
        eventName: EVENT_FOR_REASON[input.reason],
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId ?? null,
        resourceType: 'task',
        resourceId: input.taskId,
        // Never the actor's own id. The engine's third gate skips somebody who
        // caused the thing they are being told about, and a supervisor
        // assigning work to a cleaner has caused it FOR that cleaner — passing
        // the supervisor here would silence the cleaner.
        actorUserId: null,
        summary: input.summary ?? null,
        idempotencyKey:
          request.idempotencyKey ?? `${input.taskId}:${input.reason}`,
        correlationId,
        candidates: [candidate],
        now,
        tx,
      })
    },

    audit({ input, result }) {
      const what =
        input.reason === 'overdue'
          ? 'התראה על איחור במשימה'
          : 'הודעה על שיוך משימה'

      return {
        resourceId: input.taskId,
        ...(input.propertyId === undefined
          ? {}
          : { propertyId: input.propertyId }),
        after: {
          assignee_user_id: input.assigneeUserId,
          reason: input.reason,
          notified: result.notified,
        },
        // Says whether anybody was actually told. "נשלחה הודעה" beside zero
        // recipients is the same lie in a different table.
        summary:
          result.notified > 0
            ? `${what} נשלחה לאחראי.`
            : `${what} לא הגיעה לאף אחד — ראו את סיבות הדילוג.`,
      }
    },

    // No domain event. See the header: this is a fan-out of `task.assigned` /
    // `task.overdue`, and republishing the name it just routed would have any
    // event→notification bridge route it a second time.
  })

  /* ── 3 · a message to the team ────────────────────────────────────────── */

  const notifyTeam = defineOperation<
    {
      eventName: string
      resourceType: string
      resourceId: string
      summary?: string
      propertyId?: string
    },
    null,
    NotifyResult
  >({
    name: 'messaging.team.notify',
    // Every preset holds this — it is in `UNIVERSAL_GRANTS` — which is exactly
    // right for an operation that only ever writes rows the routing engine has
    // already decided somebody may see. It is not an authority over the
    // business; the authority is `route()`'s `authorize` call, per recipient.
    permission: 'notification.preferences.manage',
    resourceType: 'notification',

    input: s.object({
      // Validated against the notification catalogue in `rule`, not by an enum
      // here: `contracts/events.ts` holds roughly 130 names, it is frozen
      // there, and a copy of the subset in this file would be a second
      // catalogue to keep in step with the first.
      eventName: s.string({ label: 'אירוע', min: 3, max: 80 }),
      resourceType: s.string({ label: 'סוג המשאב', min: 1, max: 40 }),
      resourceId: s.string({ label: 'מזהה המשאב', min: 1, max: 64 }),
      summary: s.optional(s.string({ label: 'פירוט', max: 200 })),
      propertyId: s.optional(s.uuid({ label: 'נכס' })),
    }),

    /**
     * Is this an event the notification catalogue knows how to word?
     *
     * `route()` answers `notifiable: false` for anything else and returns an
     * empty plan, which would leave a caller with a successful operation that
     * told nobody anything. Refusing here turns that into a stated reason, and
     * the reason names the actual constraint rather than "invalid input".
     */
    rule({ input }) {
      if (!isDomainEvent(input.eventName)) {
        throw new BusinessRuleError({
          code: 'messaging.unknown_event',
          message: `'${input.eventName}' is not in DOMAIN_EVENTS`,
          userMessage:
            'סוג האירוע שנשלח אינו מוכר למערכת, ולכן לא נשלחה התראה לצוות.',
        })
      }

      if (!specFor(input.eventName)) {
        throw new BusinessRuleError({
          code: 'messaging.event_not_notifiable',
          message: `'${input.eventName}' has no notification catalogue entry`,
          userMessage:
            'האירוע הזה אינו מוגדר כאירוע שמגיע לאנשים, ולכן אין לו נוסח ואין למי לשלוח אותו. אפשר להתריע על אירוע אחר.',
        })
      }
    },

    async execute({ input, context, request, correlationId, now, tx }) {
      const candidates = await staff.team(context.actor.organizationId)

      return fanOut({
        // Narrowed by `rule` above. Asserted rather than cast blindly: the
        // guard has already run and this is the type it proved.
        eventName: input.eventName as DomainEventName,
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        // The caller IS the actor here, and the engine's third gate should skip
        // them: somebody who raises an alert to the team does not need to be
        // told about their own alert.
        actorUserId: context.actor.userId,
        summary: input.summary ?? null,
        idempotencyKey:
          request.idempotencyKey ??
          `${input.eventName}:${input.resourceId}:${correlationId}`,
        correlationId,
        candidates,
        now,
        tx,
      })
    },

    audit({ input, result }) {
      return {
        resourceId: input.resourceId,
        ...(input.propertyId === undefined
          ? {}
          : { propertyId: input.propertyId }),
        after: {
          event_name: input.eventName,
          notified: result.notified,
          skipped: result.skipped.length,
        },
        summary:
          result.notified > 0
            ? `נשלחה התראה לצוות על ${input.eventName} — ${result.notified} אנשים.`
            : `התראה לצוות על ${input.eventName} לא הגיעה לאף אחד — ראו את סיבות הדילוג.`,
      }
    },

    // No domain event. Same echo argument as `notifyAssignee`.
  })

  /* ── shared: route, then dispatch. Nothing else. ──────────────────────── */

  async function fanOut(args: {
    eventName: DomainEventName
    organizationId: string
    propertyId: string | null
    resourceType: string
    resourceId: string
    actorUserId: string | null
    summary: string | null
    idempotencyKey: string
    correlationId: string
    candidates: readonly NotificationCandidate[]
    now: Date
    tx?: TransactionHandle
  }): Promise<NotifyResult> {
    const settings = await deps.settings(args.organizationId)

    const plan = route({
      event: {
        name: args.eventName,
        organizationId: args.organizationId,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        propertyId: args.propertyId,
        actorUserId: args.actorUserId,
        occurredAt: args.now.toISOString(),
        correlationId: args.correlationId,
        idempotencyKey: args.idempotencyKey,
        // `eventDetail` reads `summary` off this and appends it to the
        // catalogue's Hebrew. Omitted rather than set to null when absent, so
        // the payload of a message with no detail is genuinely empty.
        payload: args.summary === null ? {} : { summary: args.summary },
      },
      settings,
      candidates: args.candidates,
      transports,
      now: args.now,
    })

    const outcome = await dispatch({
      plan,
      repository: notifications,
      transports,
      now: args.now,
      ...(args.tx === undefined ? {} : { tx: args.tx }),
    })

    return {
      notified: outcome.created.length,
      duplicates: outcome.duplicates,
      // Carried out rather than dropped. "Nobody was told and I do not know
      // why" is the single worst thing a notification system can say, and the
      // reason is already in the plan.
      skipped: plan.skipped.map((skip) => ({
        userId: skip.userId,
        reason: skip.reason,
      })),
      tally: { ...outcome.tally },
    }
  }

  return { sendGuestMessage, notifyAssignee, notifyTeam }
}

export type MessagingOperations = ReturnType<typeof defineMessagingOperations>

/* -------------------------------------------------------------- provider -- */

/**
 * Ask the provider, and never let it break the thing that caused it.
 *
 * `service/events.ts` is explicit that a failed WhatsApp message must not undo
 * a confirmed booking, and the port says `send` must not throw. A port is a
 * promise, though, and this is where the promise is kept for a provider that
 * breaks it: a throw becomes a `failed` result with `provider_threw`, and
 * nothing propagates into the operation that is trying to record it.
 */
async function sendThrough(args: {
  provider: MessageProvider
  message: OutboundGuestMessage
}): Promise<ProviderResult> {
  try {
    return await args.provider.send(args.message)
  } catch (cause) {
    return {
      status: 'failed',
      provider: args.provider.name,
      errorCode: 'provider_threw',
      errorDetail: cause instanceof Error ? cause.message : String(cause),
      retryable: true,
    }
  }
}
