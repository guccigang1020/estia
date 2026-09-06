/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person can do to a review.
 *
 * Three operations, and the shape of the list is the argument:
 *
 *   record  — write down a review that arrived somewhere else
 *   reply   — answer it in public
 *   hide    — stop displaying it, with a reason that is stored
 *
 * **There is no `edit` and there is no `delete`.** Not because they were
 * forgotten, and not only as a matter of taste: `0066_guest_reviews.sql`
 * refuses `delete` and `truncate` to every role, and a trigger rejects any
 * UPDATE that touches the guest's words or scores. If somebody added an
 * operation here to do either, the database would refuse it — which is the
 * point of putting the rule there rather than only here.
 *
 * The reason is that `listing-quality` reads these rows and tells a business
 * its listing is good. A rating that can be quietly curated is not a quality
 * signal; it is marketing wearing the clothes of data, and it would be worse
 * than the `not_assessed` it replaced.
 *
 * ── `record` is for reviews that arrived by WhatsApp ───────────────────────
 *
 * Most guesthouses in this market are sent a paragraph on WhatsApp and have
 * nowhere to put it. `entered_by_host` says plainly that a person typed it in
 * rather than a guest submitting it, so nothing downstream can mistake the two
 * — and `guest_portal_submit_review` in 0066 is the door for when the guest
 * portal grows a form of its own.
 *
 * The obvious abuse is a business typing its own five-star reviews. It is not
 * prevented here and it is not pretended away: the trigger requires a real
 * booking that reached the guest leaving, `source` records how it arrived, and
 * a business willing to invent completed stays to flatter itself has already
 * defeated any check this layer could add.
 */

import { BusinessRuleError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { REVIEW_DIMENSIONS } from './types'
import type { Review } from './types'

const TABLE = 'guest_reviews'

const star = (label: string) =>
  s.number({ label, min: 1, max: 5, integer: true })

const RECORD_INPUT = s.object({
  bookingId: s.uuid({ label: 'הזמנה' }),
  overall: star('ציון כללי'),
  comment: s.optional(s.string({ label: 'מה האורח כתב', max: 4000 })),
  cleanliness: s.optional(star('ניקיון')),
  accuracy: s.optional(star('תאימות לתיאור')),
  communication: s.optional(star('תקשורת')),
  location: s.optional(star('מיקום')),
  valueForMoney: s.optional(star('תמורה למחיר')),
})

const REPLY_INPUT = s.object({
  reviewId: s.uuid({ label: 'ביקורת' }),
  reply: s.string({ label: 'תשובה', min: 1, max: 4000 }),
})

/**
 * The reason is `min: 8`, not `min: 1`.
 *
 * A one-character reason is a checkbox with extra steps. Eight characters is
 * still not much — it is the point at which somebody has to write a short
 * phrase rather than press a key, and the whole value of recording the reason
 * is that a human later can read it and judge.
 */
const HIDE_INPUT = s.object({
  reviewId: s.uuid({ label: 'ביקורת' }),
  reason: s.string({ label: 'נימוק', min: 8, max: 500 }),
})

export interface ReviewOperations {
  record: Operation<
    {
      bookingId: string
      overall: number
      comment?: string
      cleanliness?: number
      accuracy?: number
      communication?: number
      location?: number
      valueForMoney?: number
    },
    null,
    { id: string }
  >
  reply: Operation<{ reviewId: string; reply: string }, Review, { id: string }>
  hide: Operation<{ reviewId: string; reason: string }, Review, { id: string }>
}

export function defineReviewOperations(options: {
  db: Db
  loadReview: (organizationId: string, id: string) => Promise<Review | null>
  /** The property a booking belongs to, for the authorization scope check. */
  loadBookingScope: (
    organizationId: string,
    bookingId: string,
  ) => Promise<{ propertyId: string } | null>
}): ReviewOperations {
  const loadResource = async ({
    input,
    context,
  }: {
    input: { reviewId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const review = await options.loadReview(
      context.actor.organizationId,
      input.reviewId,
    )
    if (review === null) return null
    return {
      resource: {
        organizationId: context.actor.organizationId,
        propertyId: review.propertyId,
      },
      entity: review,
    }
  }

  /* ----------------------------------------------------------- recording -- */

  const record = defineOperation<
    {
      bookingId: string
      overall: number
      comment?: string
      cleanliness?: number
      accuracy?: number
      communication?: number
      location?: number
      valueForMoney?: number
    },
    null,
    { id: string }
  >({
    name: 'review.record',
    permission: 'review.manage',
    resourceType: 'review',
    input: RECORD_INPUT,

    // Scoped by the booking's property rather than by the organization alone.
    // A manager who may only see one property must not be able to file a
    // review against another one by knowing a booking id.
    async loadResource({ input, context }) {
      const scope = await options.loadBookingScope(
        context.actor.organizationId,
        input.bookingId,
      )
      if (scope === null) return null
      return {
        resource: {
          organizationId: context.actor.organizationId,
          propertyId: scope.propertyId,
        },
        entity: null,
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from(TABLE)
        .insert({
          organization_id: context.actor.organizationId,
          // Both are overwritten by `tg_review_needs_a_completed_stay`, which
          // reads them off the booking. Sending the caller's opinion of them
          // would be sending something that is about to be ignored.
          property_id: '00000000-0000-0000-0000-000000000000',
          stayed_at: '1970-01-01',
          booking_id: input.bookingId,
          source: 'entered_by_host',
          overall: input.overall,
          cleanliness: input.cleanliness ?? null,
          accuracy: input.accuracy ?? null,
          communication: input.communication ?? null,
          location: input.location ?? null,
          value_for_money: input.valueForMoney ?? null,
          comment: input.comment ?? null,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) {
        // 23505 on this table can mean exactly one thing: `unique (booking_id)`.
        // Saying "this stay already has a review" is the whole of it, and it is
        // more useful than the constraint name.
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessRuleError({
            code: 'review_already_recorded',
            message: `booking ${input.bookingId} already has a review`,
            userMessage:
              'לשהייה הזאת כבר יש ביקורת. אפשר להשיב לה או להסתיר אותה.',
          })
        }
        throw error
      }

      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `רשם ביקורת של ${input.overall} כוכבים שהתקבלה מחוץ למערכת.`,
        after: { bookingId: input.bookingId, overall: input.overall },
      }
    },
  })

  /* -------------------------------------------------------------- replying -- */

  const reply = defineOperation<
    { reviewId: string; reply: string },
    Review,
    { id: string }
  >({
    name: 'review.reply',
    permission: 'review.manage',
    resourceType: 'review',
    input: REPLY_INPUT,
    loadResource,

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from(TABLE)
        .update({
          host_reply: input.reply,
          host_replied_at: now.toISOString(),
          host_replied_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.reviewId)

      if (error) throw error
      return { id: input.reviewId }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        summary: 'השיב לביקורת של אורח.',
        after: { reply: input.reply },
      }
    },
  })

  /* --------------------------------------------------------------- hiding -- */

  const hide = defineOperation<
    { reviewId: string; reason: string },
    Review,
    { id: string }
  >({
    name: 'review.hide',
    permission: 'review.manage',
    resourceType: 'review',
    input: HIDE_INPUT,
    loadResource,

    // Hiding an already hidden review is not an error worth raising, but it
    // must not overwrite the first reason with a second one — the record of
    // why it was hidden is the entire point.
    rule({ entity }) {
      if (entity.status === 'hidden') {
        throw new BusinessRuleError({
          code: 'review_already_hidden',
          message: `review ${entity.id} is already hidden`,
          userMessage: 'הביקורת כבר מוסתרת, והנימוק המקורי נשמר.',
        })
      }
    },

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from(TABLE)
        .update({
          status: 'hidden',
          hidden_at: now.toISOString(),
          hidden_by: context.actor.userId,
          hidden_reason: input.reason,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.reviewId)

      if (error) throw error
      return { id: input.reviewId }
    },

    audit({ entity, input }) {
      return {
        resourceId: entity.id,
        // The reason goes in the audit row as well as on the review. The row
        // on the review can be read by anybody with the screen; the audit
        // event is the one that cannot be changed afterwards.
        summary: `הסתיר ביקורת של ${entity.overall} כוכבים. נימוק: ${input.reason}`,
        before: { status: entity.status },
        after: { status: 'hidden', reason: input.reason },
      }
    },
  })

  return { record, reply, hide }
}

/** The dimension keys, in the order a form should ask for them. */
export const REVIEW_FORM_DIMENSIONS = REVIEW_DIMENSIONS
