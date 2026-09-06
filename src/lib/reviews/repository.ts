/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading reviews out of Postgres.
 *
 * The only shaping this does is turning five nullable columns into a
 * `dimensions` object, so that "the guest did not rate location" and "the
 * guest gave location a zero" cannot be confused — the second is not even
 * expressible, because the CHECK constraint requires 1..5.
 */

import { toRow, toRows, type Db, type Row } from '../persistence'
import { REVIEW_DIMENSIONS } from './types'
import type { Review, ReviewDimension } from './types'

const COLUMNS =
  'id, property_id, unit_id, booking_id, status, source, overall, ' +
  'cleanliness, accuracy, communication, location, value_for_money, ' +
  'comment, host_reply, stayed_at'

const COLUMN_OF: Readonly<Record<ReviewDimension, string>> = Object.freeze({
  cleanliness: 'cleanliness',
  accuracy: 'accuracy',
  communication: 'communication',
  location: 'location',
  value_for_money: 'value_for_money',
})

const str = (row: Row, key: string): string | null =>
  typeof row[key] === 'string' && row[key].trim() !== ''
    ? (row[key] as string)
    : null

function toReview(row: Row): Review | null {
  const id = str(row, 'id')
  const propertyId = str(row, 'property_id')
  const bookingId = str(row, 'booking_id')
  const overall = typeof row.overall === 'number' ? row.overall : null
  if (
    id === null ||
    propertyId === null ||
    bookingId === null ||
    overall === null
  )
    return null

  const dimensions: Partial<Record<ReviewDimension, number>> = {}
  for (const dimension of REVIEW_DIMENSIONS) {
    const value = row[COLUMN_OF[dimension]]
    if (typeof value === 'number') dimensions[dimension] = value
  }

  return {
    id,
    propertyId,
    unitId: str(row, 'unit_id'),
    bookingId,
    status: str(row, 'status') === 'hidden' ? 'hidden' : 'published',
    source: (str(row, 'source') ?? 'entered_by_host') as Review['source'],
    overall,
    dimensions,
    comment: str(row, 'comment'),
    hostReply: str(row, 'host_reply'),
    stayedAt: str(row, 'stayed_at') ?? '',
  }
}

export class ReviewRepository {
  constructor(private readonly db: Db) {}

  async forProperties(
    organizationId: string,
    propertyIds: readonly string[],
  ): Promise<readonly Review[]> {
    if (propertyIds.length === 0) return []

    const { data, error } = await this.db
      .from('guest_reviews')
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .in('property_id', [...propertyIds])
      .order('stayed_at', { ascending: false })

    if (error) throw error
    return toRows(data)
      .map(toReview)
      .filter((review): review is Review => review !== null)
  }

  async review(organizationId: string, id: string): Promise<Review | null> {
    const { data, error } = await this.db
      .from('guest_reviews')
      .select(COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data ? toReview(toRow(data)) : null
  }

  /** The property a booking belongs to, for the scope check on `record`. */
  async bookingScope(
    organizationId: string,
    bookingId: string,
  ): Promise<{ propertyId: string } | null> {
    const { data, error } = await this.db
      .from('bookings')
      .select('property_id')
      .eq('organization_id', organizationId)
      .eq('id', bookingId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    const propertyId = data ? str(toRow(data), 'property_id') : null
    return propertyId === null ? null : { propertyId }
  }
}
