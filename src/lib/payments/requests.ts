/**
 * Asking a guest to pay — the honest version, which takes no money.
 *
 * `AUTOPILOT_ACTIONS['payment.request']` names `payments.requestPayment`, rates
 * it `money_access_cancellation`, and `autopilot_safety_rules` in 0046 caps
 * that at `ask_approval` for every customer on every package. So a person
 * approves this before it runs, always, on purpose.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE GROUND TRUTH THIS IS BUILT ON
 *
 *  There is NO live payment provider integrated in this codebase and there
 *  are no credentials for one. `payment_collection_settings.live_provider`
 *  holds a NAME and never a credential — the column comment says so — and
 *  nothing in `src/lib` calls a processor.
 *
 *  Therefore this command:
 *    · does NOT attempt a charge,
 *    · does NOT create a payment link,
 *    · does NOT write a payment, a deposit or an attempt,
 *    · and reports `paymentTaken: false` in as many words.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── What it honestly does ────────────────────────────────────────────────
 *
 * It answers, once and through the one resolver, the question a person would
 * otherwise answer by eye: **is there anything to ask this guest for, and what
 * exactly should they be told?** Then it records that the business asked.
 *
 * Nothing here recomputes a shortfall or re-derives a requirement.
 * `resolveCollectionPolicy` is the only function in the product that answers
 * that, and `nextGuestAction` is the only one that turns its answer into the
 * single thing a guest is asked to do — including `blocked`, which is what a
 * policy demanding a live payment from a business with no processor resolves
 * to. Both are called here and neither is second-guessed, which is the whole
 * reason the refusals below read the way they do.
 *
 * ── Three refusals, and why each is a refusal rather than a shrug ────────
 *
 *   · **Nothing outstanding.** A request for ₪0 trains a guest to ignore the
 *     next one, and an audit row saying payment was requested when none was
 *     owed is a row somebody has to explain later.
 *   · **Nothing configured.** No enabled manual channel and no live processor
 *     is a business with nowhere for the money to go. Asking anyway produces a
 *     guest holding a bank transfer with no account number. This is the
 *     `not_configured` refusal that `notification_deliveries` and
 *     `site_generation_requests` already set the pattern for: refuse, name it,
 *     and let the record carry the reason.
 *   · **The business's own turn.** `manager_approval` outstanding means
 *     nothing is wanted from the guest yet.
 *
 * ── Why no domain event ──────────────────────────────────────────────────
 *
 * `payment.instructions_sent` was the obvious candidate and it is deliberately
 * NOT raised here. It already has an emitter — `guest_journey.link_send` in
 * `src/lib/guest-journey/operations.ts`, whose own comment makes the argument:
 * in this product the guest link IS how payment instructions reach a guest, so
 * the moment it is sent is the moment they were delivered. This command sends
 * nothing. A second emitter firing on a command that delivers nothing would put
 * a delivery receipt in the timeline for a delivery that did not happen, which
 * is the one thing this file exists to avoid.
 *
 * The name this wants is `payment.requested`, it is not in the frozen
 * catalogue, and `contracts/events.ts` is not this work's to edit. Reported
 * rather than invented. The audit event is written either way, so the act is
 * traceable today; what is absent is only the hook an automation could hang
 * off.
 */

import { BusinessRuleError } from '../errors'
import { defineOperation, s, type Operation } from '../service'

import {
  guestChannels,
  nextGuestAction,
  type GuestAction,
} from './guest-action'
import type { PaymentPolicyRepository } from './repository'
import {
  COLLECTION_POLICY_LABEL,
  formatAgorot,
  resolveCollectionPolicy,
  type CollectionDecision,
} from './resolver'
import type {
  CollectionFacts,
  CollectionOverride,
  CollectionSettings,
  GuestChannel,
  ManualChannel,
} from './types'

/* --------------------------------------------------------------- the deps -- */

export interface PaymentRequestDeps {
  repository: PaymentPolicyRepository
  /**
   * Where the booking lives, so the request is scoped and authorized against
   * the property it belongs to rather than one the caller claimed. Identical
   * to `PaymentPolicyOperationsDeps.bookingProperty` on purpose — one wiring
   * satisfies both.
   */
  bookingProperty: (
    organizationId: string,
    bookingId: string,
  ) => Promise<{ propertyId: string } | null>
  /**
   * What has been collected and what has been agreed, as `CollectionFacts`.
   *
   * A port rather than a query: the money lives in `payments`, the signature in
   * `booking_contract_signatures` and the confirmation in
   * `booking_guest_confirmations`, and each belongs to a module that is not
   * this one. `guest_collection_context()` in 0031 is the SQL that assembles
   * them, and it deliberately returns facts and no decision — the decision is
   * `resolveCollectionPolicy`'s, and it is made below.
   */
  collectionFacts: (
    organizationId: string,
    bookingId: string,
  ) => Promise<CollectionFacts | null>
}

/* ------------------------------------------------------------- the shapes -- */

const REQUEST_INPUT = s.object({
  bookingId: s.string({ label: 'הזמנה', min: 1, max: 64 }),
  /**
   * Whether the stay is over or cancelled. Passed in rather than inferred,
   * because booking status is the booking module's word and `nextGuestAction`
   * takes it as a fact for exactly that reason.
   */
  bookingClosed: s.nullable(s.boolean({ label: 'ההזמנה סגורה' })),
})

export type PaymentRequestInput = {
  bookingId: string
  bookingClosed: boolean | null
}

type PaymentRequestTarget = {
  propertyId: string
  settings: CollectionSettings | null
  override: CollectionOverride | null
  facts: CollectionFacts
  channels: readonly ManualChannel[]
}

export type RequestedPayment = {
  bookingId: string
  policy: CollectionDecision['policy']
  /** Which row decided — the organization default or this booking's exception. */
  policySource: CollectionDecision['source']
  /** What is still outstanding of what the policy asks for. May be zero-free. */
  amountDueAgorot: number
  /** Every requirement still unmet, in the order the guest works them. */
  outstanding: readonly string[]
  /** The one thing the guest is asked to do. From `nextGuestAction`. */
  action: GuestAction['kind']
  title: string
  body: string
  /** The enabled manual channels, exactly as the guest portal renders them. */
  channels: readonly GuestChannel[]
  /**
   * ALWAYS false. No processor is integrated; nothing here charges anything.
   * A test asserts this field by name, because the day somebody makes it true
   * without a provider is the day this product starts lying about money.
   */
  paymentTaken: false
  /** ALWAYS false. There is no provider to mint one against. */
  paymentLinkCreated: false
  /** ALWAYS false. There is no transport — the guest link is how this travels. */
  delivered: false
  handoff: 'manual'
}

export type PaymentRequestCommands = {
  requestPayment: Operation<
    PaymentRequestInput,
    PaymentRequestTarget,
    RequestedPayment
  >
}

/* -------------------------------------------------------------- the build -- */

export function definePaymentRequestCommands(
  deps: PaymentRequestDeps,
): PaymentRequestCommands {
  const { repository, bookingProperty, collectionFacts } = deps

  const requestPayment = defineOperation<
    PaymentRequestInput,
    PaymentRequestTarget,
    RequestedPayment
  >({
    name: 'payment.request',
    permission: 'payment.request_link',
    resourceType: 'payment_request',
    // Not in `SENSITIVE_ACTIONS`, and deliberately not forced to carry a
    // reason. Asking a guest for money they already owe is the ordinary course
    // of business, and demanding a written justification for it would train
    // everybody to type a full stop. The safety ceiling is what makes this
    // deliberate: Autopilot cannot reach it without a person's approval, and
    // `operationHandler` passes the action's own prose as the reason anyway.
    requiresReason: false,
    input: REQUEST_INPUT,

    async loadResource({ input, context }) {
      const organizationId = context.actor.organizationId

      const booking = await bookingProperty(organizationId, input.bookingId)
      if (!booking) return null

      const facts = await collectionFacts(organizationId, input.bookingId)
      // A booking whose collection facts cannot be read is one nothing can
      // vouch for, and `NO_COLLECTION_FACTS` here would resolve to "nothing has
      // been paid" — which would ask a guest who has already paid in full to
      // pay again. Not found, rather than a guess with somebody's money.
      if (!facts) return null

      const [settings, override, channels] = await Promise.all([
        repository.loadSettings(organizationId),
        repository.loadOverride(organizationId, input.bookingId),
        repository.listChannels(organizationId),
      ])

      return {
        resource: {
          organizationId,
          propertyId: booking.propertyId,
          family: 'finance',
        },
        entity: {
          propertyId: booking.propertyId,
          settings,
          override,
          facts,
          channels,
        },
      }
    },

    /**
     * The three refusals. Every one of them comes out of the existing engine
     * rather than out of a second opinion written here.
     */
    rule({ input, entity }) {
      const decision = decide(entity)
      const action = nextGuestAction({
        decision,
        channels: entity.channels,
        bookingClosed: input.bookingClosed ?? false,
      })

      if (action.kind === 'nothing_required') {
        throw new BusinessRuleError({
          code: 'payments.nothing_to_request',
          message:
            `Nothing outstanding on booking ${input.bookingId}: policy ` +
            `${decision.policy}, shortfall ${decision.shortfallAgorot}`,
          userMessage:
            `אין מה לבקש מהאורח בהזמנה הזו — ${action.body} ` +
            'בקשת תשלום על יתרה שאינה קיימת רק מבלבלת.',
          publicDetails: { policy: decision.policy },
        })
      }

      if (action.kind === 'awaiting_staff') {
        throw new BusinessRuleError({
          code: 'payments.awaiting_staff',
          message:
            `Booking ${input.bookingId} is waiting on the business, not the ` +
            'guest',
          userMessage:
            'ההזמנה ממתינה לכם, לא לאורח. אשרו אותה קודם, ורק אז אפשר לבקש ' +
            'תשלום.',
        })
      }

      // `blocked` is `nextGuestAction`'s own name for the misconfiguration:
      // money is required and the organization has no way of taking it. That
      // is precisely the `not_configured` case, and it is refused here rather
      // than turned into a request the guest cannot act on.
      //
      // Two shapes reach it and they need different sentences, because they
      // need different fixes: a policy demanding a CARD payment from a business
      // with no processor, and any money at all with no enabled channel. The
      // shape is read from the outstanding requirement rather than from the
      // action, which carries only the guest's half of the story.
      if (action.kind === 'blocked') {
        const cardOnly = decision.outstanding[0] === 'deposit_paid_live'
        throw new BusinessRuleError({
          code: 'payments.no_collection_route',
          message:
            `Booking ${input.bookingId} needs ${decision.shortfallAgorot} ` +
            `agorot and has no route: ` +
            (cardOnly
              ? 'the policy requires a live card payment and no provider is set'
              : 'no live provider and no enabled manual channel'),
          userMessage: cardOnly
            ? 'המדיניות דורשת תשלום בסליקה, ולא מוגדרת סליקה מקוונת. שנו את ' +
              'המדיניות או הגדירו ספק סליקה — אחרת האורח יתבקש לשלם בדרך ' +
              'שאינה קיימת.'
            : 'לא מוגדר שום אמצעי לקבלת התשלום — אין סליקה מקוונת ואין ערוץ ' +
              'תשלום ידני פעיל. הפעילו לפחות אחד מהם בהגדרות הגבייה, אחרת ' +
              'האורח יתבקש לשלם ולא יידע לאן.',
          publicDetails: { shortfallAgorot: decision.shortfallAgorot },
        })
      }
    },

    /**
     * Nothing is written to any money table, and that is the entire point.
     *
     * No `payments` row, because no money arrived. No `payment_attempts` row,
     * because nothing was attempted. No link, because there is nothing to mint
     * one against. What this returns is the request itself — the amount, the
     * requirement and the exact channels — and the audit event beside it is the
     * durable record that the business asked.
     */
    async execute({ input, entity }) {
      // Recomputed rather than carried out of `rule`: the definition object is
      // shared by every concurrent run, so a stashed value is one request's
      // answer used for another's.
      const decision = decide(entity)
      const action = nextGuestAction({
        decision,
        channels: entity.channels,
        bookingClosed: input.bookingClosed ?? false,
      })

      return {
        bookingId: input.bookingId,
        policy: decision.policy,
        policySource: decision.source,
        amountDueAgorot: decision.shortfallAgorot,
        outstanding: [...decision.outstanding],
        action: action.kind,
        title: action.title,
        body: action.body,
        channels: guestChannels(entity.channels),
        paymentTaken: false,
        paymentLinkCreated: false,
        delivered: false,
        handoff: 'manual',
      }
    },

    /**
     * The summary says what happened AND what did not.
     *
     * "ביקשה תשלום" on its own would be read six months later as "the guest was
     * charged", and the whole value of this record is that it cannot be.
     */
    audit({ entity, result, context }) {
      return {
        resourceId: result.bookingId,
        propertyId: entity.propertyId,
        after: {
          policy: result.policy,
          policySource: result.policySource,
          amountDueAgorot: result.amountDueAgorot,
          outstanding: [...result.outstanding],
          action: result.action,
          paymentTaken: false,
          paymentLinkCreated: false,
        },
        summary:
          `${context.auditActor.label} ביקשה תשלום של ${formatAgorot(result.amountDueAgorot)} ` +
          `על הזמנה ${result.bookingId} לפי מדיניות "${COLLECTION_POLICY_LABEL[result.policy]}". ` +
          'לא נגבה כסף ולא נוצר קישור תשלום — האורח מקבל הוראות תשלום.',
      }
    },
  })

  return { requestPayment }
}

/** The one resolver, called the one way. Never inlined, never second-guessed. */
function decide(entity: PaymentRequestTarget): CollectionDecision {
  return resolveCollectionPolicy({
    settings: entity.settings,
    override: entity.override,
    facts: entity.facts,
  })
}
