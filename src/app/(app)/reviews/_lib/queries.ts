/**
 * EXECUTION CONTEXT — SERVER ONLY. The rows the reviews screen reads.
 *
 * Hidden reviews are fetched with the rest and are NOT filtered out here. The
 * count of them is part of the answer — `summarise` needs it, and a screen
 * that dropped them would let a business look at its own average without
 * seeing what is missing from it.
 */

import { toRows, type Db } from '@/lib/persistence'
import { ReviewRepository } from '@/lib/reviews/repository'
import { summarise, type Review, type ReviewSummary } from '@/lib/reviews'

export type ReviewsScreen =
  | { readonly status: 'not_provisioned' }
  | {
      readonly status: 'ready'
      readonly reviews: readonly Review[]
      readonly summary: ReviewSummary
      readonly reviewableStays: readonly ReviewableStay[]
    }

/** A stay that ended and has no review yet — the only thing `record` accepts. */
export type ReviewableStay = {
  readonly bookingId: string
  readonly reference: string
  readonly checkOut: string
}

function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

/** The statuses `tg_review_needs_a_completed_stay` accepts, and only those. */
const REVIEWABLE = [
  'checkout_pending',
  'checked_out',
  'inspection',
  'deposit_release',
  'completed',
  'review_requested',
]

export async function loadReviewsScreen(
  db: Db,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<ReviewsScreen> {
  if (propertyIds.length === 0) {
    return {
      status: 'ready',
      reviews: [],
      summary: summarise([]),
      reviewableStays: [],
    }
  }

  try {
    const repository = new ReviewRepository(db)
    const reviews = await repository.forProperties(organizationId, propertyIds)

    // Offered for manual entry: stays that ended, minus the ones already
    // reviewed. The list is built from the SAME statuses the trigger accepts,
    // so the form cannot offer a booking the database will refuse.
    const stays = await db
      .from('bookings')
      .select('id, reference, check_out')
      .eq('organization_id', organizationId)
      .in('property_id', [...propertyIds])
      .in('status', REVIEWABLE)
      .is('deleted_at', null)
      .order('check_out', { ascending: false })
      .limit(50)

    if (stays.error) throw stays.error

    const reviewed = new Set(reviews.map((review) => review.bookingId))
    const reviewableStays: ReviewableStay[] = []

    for (const row of toRows(stays.data)) {
      const bookingId = typeof row.id === 'string' ? row.id : null
      if (bookingId === null || reviewed.has(bookingId)) continue
      reviewableStays.push({
        bookingId,
        reference:
          typeof row.reference === 'string' ? row.reference : bookingId,
        checkOut: typeof row.check_out === 'string' ? row.check_out : '',
      })
    }

    return {
      status: 'ready',
      reviews,
      summary: summarise(reviews),
      reviewableStays,
    }
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }
}
