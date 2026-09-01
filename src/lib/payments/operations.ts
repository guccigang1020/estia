/**
 * The write paths for the collection policy.
 *
 * Every one of them is a `defineOperation`, so every one of them goes
 * authorization → validation → domain rule → transaction → audit event →
 * idempotency, in that order, with no way to reach the write without the
 * checks. That matters more here than almost anywhere else in the product: the
 * override operation is the one that can quietly excuse a guest from paying,
 * and an unexplained exception on a booking is the thing a business is asked
 * about six months later.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * There is no `recordManualPayment`. `defineFinanceOperations().recordPayment`
 * already records money that arrived, with the idempotency key, the audit row
 * and the state machine, and it already accepts `method: 'bank_transfer'` with
 * `channel: 'manual'`. Writing a second operation for the same act would give
 * this product two ways to record a payment and two answers to what a booking
 * has been paid — which is the exact failure "root cause over symptom" names.
 *
 * What was missing was not an operation but the *composition*: turning "the
 * guest paid through the Bit channel" into that operation's input without
 * every caller re-deriving the payment method. That is `manual-payment.ts`,
 * which is a pure function and writes nothing.
 */

import { assertCan, type Resource } from '../authz/can'
import { CONFIRMATION_REQUIREMENTS } from '../contracts/states'
import { PAYMENT_COLLECTION_POLICIES } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import { defineOperation, s } from '../service'

import {
  MANUAL_CHANNEL_LABEL,
  MANUAL_PAYMENT_CHANNELS,
  requiresInstructions,
  type ManualPaymentChannel,
} from './channels'
import type { PaymentPolicyRepository } from './repository'
import { COLLECTION_POLICY_LABEL, REQUIREMENT_LABEL } from './resolver'
import type {
  CollectionOverride,
  CollectionSettings,
  ManualChannel,
  PaymentProof,
} from './types'

/* ---------------------------------------------------------------- shared -- */

/** The organization itself. Policy is not a per-property decision. */
function organizationResource(organizationId: string): Resource {
  return { organizationId, family: 'finance' }
}

function propertyResource(
  organizationId: string,
  propertyId: string,
): Resource {
  return { organizationId, propertyId, family: 'finance' }
}

/**
 * The deposit shape, checked once for both the settings and the override.
 *
 * The database refuses these too. They are checked here as well because a
 * constraint violation reaches a person as a 23514 with a constraint name in
 * it, and "בחר אחוז או סכום קבוע, לא את שניהם" is what somebody can act on.
 */
function assertDepositShape(input: {
  policy: string
  depositPercentBps: number | null
  depositFixedAgorot: number | null
}): void {
  if (input.depositPercentBps !== null && input.depositFixedAgorot !== null) {
    throw new BusinessRuleError({
      code: 'payments.deposit_two_shapes',
      message: 'Both deposit_percent_bps and deposit_fixed_agorot were given',
      userMessage:
        'בחר אחוז מהסכום או סכום קבוע — לא את שניהם. שתי הגדרות מקדמה על אותה מדיניות אינן חד-משמעיות.',
    })
  }

  if (
    input.policy === 'deposit' &&
    input.depositPercentBps === null &&
    input.depositFixedAgorot === null
  ) {
    throw new BusinessRuleError({
      code: 'payments.deposit_amount_missing',
      message: 'policy is deposit and neither deposit amount was given',
      userMessage:
        'מדיניות מקדמה חייבת לנקוב בסכום. הזן אחוז מהסכום או סכום קבוע, אחרת האורח יתבקש לשלם סכום לא מוגדר.',
    })
  }
}

const DEPOSIT_FIELDS = {
  depositPercentBps: s.nullable(
    s.number({
      label: 'אחוז המקדמה',
      integer: true,
      min: 1,
      max: 10000,
    }),
  ),
  depositFixedAgorot: s.nullable(s.agorot({ label: 'סכום מקדמה קבוע' })),
  balanceDueDaysBefore: s.nullable(
    s.number({ label: 'ימים לפני ההגעה', integer: true, min: 0, max: 365 }),
  ),
  requirements: s.arrayOf(
    s.enumOf(CONFIRMATION_REQUIREMENTS, { label: 'דרישה' }),
    { label: 'דרישות לאישור', max: CONFIRMATION_REQUIREMENTS.length },
  ),
  policy: s.enumOf(PAYMENT_COLLECTION_POLICIES, { label: 'מדיניות גבייה' }),
} as const

function requirementList(requirements: readonly string[]): string {
  if (requirements.length === 0) return 'ללא דרישות'
  return requirements
    .map(
      (requirement) =>
        REQUIREMENT_LABEL[requirement as keyof typeof REQUIREMENT_LABEL] ??
        requirement,
    )
    .join(', ')
}

/* ------------------------------------------------------------ definitions -- */

export interface PaymentPolicyOperationsDeps {
  repository: PaymentPolicyRepository
  /**
   * Where a booking's property lives, so an override can be scoped and
   * authorized against the property it belongs to rather than against whatever
   * the caller claimed.
   */
  bookingProperty: (
    organizationId: string,
    bookingId: string,
  ) => Promise<{ propertyId: string } | null>
}

export function definePaymentPolicyOperations(
  deps: PaymentPolicyOperationsDeps,
) {
  const { repository, bookingProperty } = deps

  /* ── The organization default ──────────────────────────────────────────── */

  const setCollectionPolicy = defineOperation<
    {
      policy: (typeof PAYMENT_COLLECTION_POLICIES)[number]
      requirements: readonly (typeof CONFIRMATION_REQUIREMENTS)[number][]
      depositPercentBps: number | null
      depositFixedAgorot: number | null
      balanceDueDaysBefore: number | null
      livePaymentsEnabled: boolean
      liveProvider: string | null
      guestInstructions: string | null
    },
    null,
    CollectionSettings
  >({
    name: 'payment.collection_policy.set',
    permission: 'payment.policy_manage',
    resourceType: 'payment_policy',
    // Not in SENSITIVE_ACTIONS and deliberately not forced to carry one. The
    // majority case is a small business setting this once, and demanding a
    // written justification to say "we take bank transfers" would train
    // everybody to type a full stop.
    requiresReason: false,
    input: s.object({
      policy: DEPOSIT_FIELDS.policy,
      requirements: DEPOSIT_FIELDS.requirements,
      depositPercentBps: DEPOSIT_FIELDS.depositPercentBps,
      depositFixedAgorot: DEPOSIT_FIELDS.depositFixedAgorot,
      balanceDueDaysBefore: DEPOSIT_FIELDS.balanceDueDaysBefore,
      livePaymentsEnabled: s.boolean({ label: 'סליקה מקוונת פעילה' }),
      liveProvider: s.nullable(
        s.string({ label: 'ספק הסליקה', min: 2, max: 60 }),
      ),
      guestInstructions: s.nullable(
        s.string({ label: 'הודעה לאורח', max: 2000 }),
      ),
    }),

    async rule({ input, context }) {
      assertCan(
        context.actor,
        'payment.policy_manage',
        organizationResource(context.actor.organizationId),
      )

      assertDepositShape(input)

      // The database says the same thing. Said here too, because the guest
      // page reads `livePaymentsEnabled` to decide whether to render a "pay
      // now" button at all, and a true with nothing behind it is a dead end
      // with somebody's booking on the other side of it.
      if (input.livePaymentsEnabled && input.liveProvider === null) {
        throw new BusinessRuleError({
          code: 'payments.live_without_provider',
          message: 'live_payments_enabled is true with no provider named',
          userMessage:
            'כדי להפעיל סליקה מקוונת יש לציין את ספק הסליקה. בלי ספק, האורח יראה כפתור תשלום שאינו מוביל לשום מקום.',
        })
      }
    },

    async execute({ input, context, tx }) {
      return repository.saveSettings(
        context.actor.organizationId,
        {
          policy: input.policy,
          requirements: input.requirements,
          depositPercentBps: input.depositPercentBps,
          depositFixedAgorot: input.depositFixedAgorot,
          balanceDueDaysBefore: input.balanceDueDaysBefore,
          livePaymentsEnabled: input.livePaymentsEnabled,
          liveProvider: input.liveProvider,
          guestInstructions: input.guestInstructions,
        },
        context.actor.userId,
        tx,
      )
    },

    audit({ result, context }) {
      return {
        resourceId: context.actor.organizationId,
        after: {
          policy: result.policy,
          requirements: [...result.requirements],
          depositPercentBps: result.depositPercentBps,
          depositFixedAgorot: result.depositFixedAgorot,
          livePaymentsEnabled: result.livePaymentsEnabled,
        },
        summary:
          `${context.auditActor.label} קבע מדיניות גבייה "${COLLECTION_POLICY_LABEL[result.policy]}" ` +
          `לכל הארגון (${requirementList(result.requirements)})`,
      }
    },

    // `security.payment_config_changed` is on ALERT_EVENTS, which is what
    // makes this reach a person rather than only the log. Changing how money
    // is collected is a change somebody other than the person who made it
    // should learn about.
    events({ result, context }) {
      return [
        {
          name: 'security.payment_config_changed' as const,
          payload: {
            organizationId: context.actor.organizationId,
            policy: result.policy,
            livePaymentsEnabled: result.livePaymentsEnabled,
          },
        },
      ]
    },
  })

  /* ── The per-booking exception ─────────────────────────────────────────── */

  const setBookingOverride = defineOperation<
    {
      bookingId: string
      policy: (typeof PAYMENT_COLLECTION_POLICIES)[number]
      requirements: readonly (typeof CONFIRMATION_REQUIREMENTS)[number][]
      depositPercentBps: number | null
      depositFixedAgorot: number | null
      balanceDueDaysBefore: number | null
    },
    { propertyId: string; previous: CollectionOverride | null },
    CollectionOverride
  >({
    name: 'payment.collection_override.set',
    permission: 'payment.policy_manage',
    resourceType: 'payment_policy',
    // Forced, and not left to `SENSITIVE_ACTIONS`. This is the operation that
    // waives a deposit for one guest, and the reason is the only thing that
    // distinguishes a decision from a favour.
    requiresReason: true,
    input: s.object({
      bookingId: s.string({ label: 'הזמנה', min: 1, max: 64 }),
      policy: DEPOSIT_FIELDS.policy,
      requirements: DEPOSIT_FIELDS.requirements,
      depositPercentBps: DEPOSIT_FIELDS.depositPercentBps,
      depositFixedAgorot: DEPOSIT_FIELDS.depositFixedAgorot,
      balanceDueDaysBefore: DEPOSIT_FIELDS.balanceDueDaysBefore,
    }),

    async loadResource({ input, context }) {
      const booking = await bookingProperty(
        context.actor.organizationId,
        input.bookingId,
      )
      if (!booking) return null

      const previous = await repository.loadOverride(
        context.actor.organizationId,
        input.bookingId,
      )

      return {
        resource: propertyResource(
          context.actor.organizationId,
          booking.propertyId,
        ),
        entity: { propertyId: booking.propertyId, previous },
      }
    },

    async rule({ input }) {
      assertDepositShape(input)
    },

    async execute({ input, entity, context, tx }) {
      return repository.saveOverride(
        context.actor.organizationId,
        {
          bookingId: input.bookingId,
          propertyId: entity.propertyId,
          policy: input.policy,
          requirements: input.requirements,
          depositPercentBps: input.depositPercentBps,
          depositFixedAgorot: input.depositFixedAgorot,
          balanceDueDaysBefore: input.balanceDueDaysBefore,
          // `defineOperation` has already refused a blank one.
          reason: context.reason ?? '',
        },
        context.actor.userId,
        tx,
      )
    },

    /**
     * Actor, time, old value, new value, reason — all five, every time.
     *
     * `before` is the previous override where there was one, and an explicit
     * `null` policy where there was not. The distinction is the whole point:
     * "changed from a 30% deposit to none" and "was never excepted before"
     * are different sentences in a dispute.
     */
    audit({ entity, result, context }) {
      const previous = entity.previous
      return {
        resourceId: result.id,
        propertyId: entity.propertyId,
        reason: context.reason ?? null,
        before: previous
          ? {
              policy: previous.policy,
              requirements: [...previous.requirements],
              depositPercentBps: previous.depositPercentBps,
              depositFixedAgorot: previous.depositFixedAgorot,
              reason: previous.reason,
            }
          : { policy: null, requirements: [], note: 'ברירת המחדל של הארגון' },
        after: {
          policy: result.policy,
          requirements: [...result.requirements],
          depositPercentBps: result.depositPercentBps,
          depositFixedAgorot: result.depositFixedAgorot,
          reason: result.reason,
        },
        summary:
          `${context.auditActor.label} שינה את מדיניות הגבייה של הזמנה ${result.bookingId} ` +
          `מ-${previous ? COLLECTION_POLICY_LABEL[previous.policy] : 'ברירת המחדל של הארגון'} ` +
          `ל-${COLLECTION_POLICY_LABEL[result.policy]} (${requirementList(result.requirements)})`,
      }
    },
  })

  /* ── Undoing it ────────────────────────────────────────────────────────── */

  const clearBookingOverride = defineOperation<
    { bookingId: string },
    { propertyId: string; previous: CollectionOverride },
    { bookingId: string }
  >({
    name: 'payment.collection_override.clear',
    permission: 'payment.policy_manage',
    resourceType: 'payment_policy',
    requiresReason: true,
    input: s.object({
      bookingId: s.string({ label: 'הזמנה', min: 1, max: 64 }),
    }),

    async loadResource({ input, context }) {
      const previous = await repository.loadOverride(
        context.actor.organizationId,
        input.bookingId,
      )
      // No override is nothing to clear, and `NotFoundError` says so. Deleting
      // nothing and reporting success would leave somebody believing they had
      // restored a default that was never departed from.
      if (!previous) return null

      const booking = await bookingProperty(
        context.actor.organizationId,
        input.bookingId,
      )
      if (!booking) return null

      return {
        resource: propertyResource(
          context.actor.organizationId,
          booking.propertyId,
        ),
        entity: { propertyId: booking.propertyId, previous },
      }
    },

    async execute({ input, context, tx }) {
      await repository.clearOverride(
        context.actor.organizationId,
        input.bookingId,
        tx,
      )
      return { bookingId: input.bookingId }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: entity.previous.id,
        propertyId: entity.propertyId,
        reason: context.reason ?? null,
        before: {
          policy: entity.previous.policy,
          requirements: [...entity.previous.requirements],
          reason: entity.previous.reason,
        },
        after: { policy: null, note: 'ברירת המחדל של הארגון' },
        summary:
          `${context.auditActor.label} ביטל את החריגה בהזמנה ${result.bookingId} ` +
          'והחזיר אותה למדיניות ברירת המחדל של הארגון',
      }
    },
  })

  /* ── The channels ──────────────────────────────────────────────────────── */

  const setManualChannel = defineOperation<
    {
      channel: ManualPaymentChannel
      enabled: boolean
      displayName: string | null
      instructions: string | null
      sortOrder: number
    },
    null,
    ManualChannel
  >({
    name: 'payment.manual_channel.set',
    permission: 'payment.policy_manage',
    resourceType: 'payment_policy',
    requiresReason: false,
    input: s.object({
      channel: s.enumOf(MANUAL_PAYMENT_CHANNELS, { label: 'ערוץ תשלום' }),
      enabled: s.boolean({ label: 'פעיל' }),
      displayName: s.nullable(s.string({ label: 'שם לתצוגה', max: 80 })),
      instructions: s.nullable(s.string({ label: 'הוראות לאורח', max: 2000 })),
      sortOrder: s.number({ label: 'סדר', integer: true, min: 0, max: 999 }),
    }),

    async rule({ input, context }) {
      assertCan(
        context.actor,
        'payment.policy_manage',
        organizationResource(context.actor.organizationId),
      )

      // The same rule the column carries, said in a sentence somebody can act
      // on. An enabled bank transfer with no account number is a guest reading
      // "העבר בהעברה בנקאית" and having nowhere to send it.
      if (
        input.enabled &&
        requiresInstructions(input.channel) &&
        (input.instructions === null || input.instructions.trim().length === 0)
      ) {
        throw new BusinessRuleError({
          code: 'payments.channel_without_instructions',
          message: `channel ${input.channel} enabled with no instructions`,
          userMessage:
            `כדי להפעיל ${MANUAL_CHANNEL_LABEL[input.channel]} יש למלא הוראות לאורח — ` +
            'אחרת הוא יתבקש לשלם ולא יידע לאן.',
        })
      }
    },

    async execute({ input, context, tx }) {
      return repository.saveChannel(
        context.actor.organizationId,
        {
          channel: input.channel,
          enabled: input.enabled,
          displayName: input.displayName,
          instructions: input.instructions,
          sortOrder: input.sortOrder,
        },
        context.actor.userId,
        tx,
      )
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        after: {
          channel: result.channel,
          enabled: result.enabled,
          sortOrder: result.sortOrder,
        },
        summary:
          `${context.auditActor.label} ${result.enabled ? 'הפעיל' : 'כיבה'} ` +
          `את ערוץ התשלום ${MANUAL_CHANNEL_LABEL[result.channel]}`,
      }
    },

    events({ context, result }) {
      return [
        {
          name: 'security.payment_config_changed' as const,
          payload: {
            organizationId: context.actor.organizationId,
            channel: result.channel,
            enabled: result.enabled,
          },
        },
      ]
    },
  })

  /* ── Somebody sent a receipt ───────────────────────────────────────────── */

  /**
   * A member of staff attaching a receipt that reached them by another route —
   * emailed to the office, handed over at the desk.
   *
   * The guest's own upload does **not** come through here. It goes through
   * `submit_payment_proof()`, because a guest has no membership and every
   * policy in the schema is written against one. Both paths land in the same
   * table and are told apart by `submitted_by_guest`, which is a column and
   * not an inference.
   */
  const recordPaymentProof = defineOperation<
    {
      bookingId: string
      storageKey: string
      fileName: string
      contentType: string
      byteSize: number
      checksumSha256: string | null
      note: string | null
    },
    { propertyId: string },
    PaymentProof
  >({
    name: 'payment.proof.record',
    permission: 'payment.create',
    resourceType: 'payment_proof',
    requiresReason: false,
    input: s.object({
      bookingId: s.string({ label: 'הזמנה', min: 1, max: 64 }),
      storageKey: s.string({ label: 'מזהה קובץ', min: 1, max: 400 }),
      fileName: s.string({ label: 'שם הקובץ', min: 1, max: 260 }),
      contentType: s.string({ label: 'סוג הקובץ', min: 3, max: 120 }),
      byteSize: s.number({
        label: 'גודל הקובץ',
        integer: true,
        min: 1,
        // The column's own ceiling, 20 MB.
        max: 20_971_520,
      }),
      checksumSha256: s.nullable(
        s.string({
          label: 'טביעת אצבע',
          pattern: /^[0-9a-f]{64}$/,
          patternMessage: 'טביעת אצבע חייבת להיות 64 תווים הקסדצימליים.',
        }),
      ),
      note: s.nullable(s.string({ label: 'הערה', max: 400 })),
    }),

    async loadResource({ input, context }) {
      const booking = await bookingProperty(
        context.actor.organizationId,
        input.bookingId,
      )
      if (!booking) return null

      return {
        resource: propertyResource(
          context.actor.organizationId,
          booking.propertyId,
        ),
        entity: { propertyId: booking.propertyId },
      }
    },

    async execute({ input, entity, context, tx }) {
      return repository.insertProof(
        context.actor.organizationId,
        {
          bookingId: input.bookingId,
          propertyId: entity.propertyId,
          storageKey: input.storageKey,
          fileName: input.fileName,
          contentType: input.contentType,
          byteSize: input.byteSize,
          checksumSha256: input.checksumSha256,
          note: input.note,
        },
        context.actor.userId,
        tx,
      )
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        propertyId: result.propertyId,
        after: {
          bookingId: result.bookingId,
          fileName: result.fileName,
          byteSize: result.byteSize,
          review: result.review,
        },
        summary:
          `${context.auditActor.label} צירף אסמכתת תשלום (${result.fileName}) ` +
          `להזמנה ${result.bookingId}`,
      }
    },

    events({ result }) {
      return [
        {
          name: 'payment.proof_uploaded' as const,
          propertyId: result.propertyId,
          payload: {
            proofId: result.id,
            bookingId: result.bookingId,
            submittedByGuest: result.submittedByGuest,
          },
        },
      ]
    },
  })

  return {
    setCollectionPolicy,
    setBookingOverride,
    clearBookingOverride,
    setManualChannel,
    recordPaymentProof,
  }
}

export type PaymentPolicyOperations = ReturnType<
  typeof definePaymentPolicyOperations
>
