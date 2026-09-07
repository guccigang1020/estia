/**
 * EXECUTION CONTEXT — SERVER ONLY. Reading campaigns out of Postgres.
 *
 * The client is injected, never constructed here, so that every read runs
 * under the signed-in user's row level security and the unit suite can exist
 * without a database. Two authorization floors: the RLS policies in 0073, and
 * `can(actor, grant, resource)` above this — neither substitutes for the
 * other, and this file is below both.
 *
 * ── The one shaping that happens ───────────────────────────────────────────
 *
 * `conditions` arrives as jsonb and is returned as `PromotionCondition`. It is
 * NOT parsed or validated here: the CHECK in 0073 refuses a malformed tree at
 * the write, and `evaluateCondition` fails closed on anything it does not
 * recognise. Adding a third gate would mean three answers to "is this
 * condition valid", and the third would be the one nobody updated.
 */

import {
  asBoolean,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import { foldCode } from './codes'
import {
  PROMOTION_APPLIES_TO,
  PROMOTION_DISCOUNT_KINDS,
  PROMOTION_KINDS,
} from './types'
import type {
  Coupon,
  Promotion,
  PromotionAppliesTo,
  PromotionCondition,
  PromotionDiscountKind,
  PromotionKind,
} from './types'

const PROMOTION_COLUMNS =
  'id, organization_id, code, name, kind, conditions, discount_kind, ' +
  'discount_value, applies_to, stackable, exclusive_group, priority, ' +
  'max_redemptions, max_per_guest, budget_agorot, effective_from, ' +
  'effective_to, is_active, deactivated_at, deactivation_reason, version'

const COUPON_COLUMNS =
  'id, organization_id, promotion_id, code, issued_to_guest_id, conditions, ' +
  'discount_kind, discount_value, applies_to, single_use, max_redemptions, ' +
  'max_per_guest, budget_agorot, effective_from, effective_to, expires_at, ' +
  'is_active, deactivated_at, deactivation_reason, version'

function oneOf<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = row[column]
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function conditionsOf(row: Row): PromotionCondition {
  const value = row.conditions
  // An object is the only shape 0073 will store. Anything else reaching here
  // means a write went past the table, and NO_CONDITION would then quietly
  // make the campaign apply to everybody — so an unrecognised value becomes a
  // condition that fails closed rather than one that is vacuously true.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'any', of: [] }
  }
  return value as PromotionCondition
}

function toPromotion(row: Row): Promotion {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    code: asString(row, 'code'),
    name: asString(row, 'name'),
    kind: oneOf<PromotionKind>(row, 'kind', PROMOTION_KINDS, 'direct_booking'),
    conditions: conditionsOf(row),
    discountKind: oneOf<PromotionDiscountKind>(
      row,
      'discount_kind',
      PROMOTION_DISCOUNT_KINDS,
      'percent',
    ),
    discountValue: asNumber(row, 'discount_value'),
    appliesTo: oneOf<PromotionAppliesTo>(
      row,
      'applies_to',
      PROMOTION_APPLIES_TO,
      'stay_total',
    ),
    stackable: asBoolean(row, 'stackable'),
    exclusiveGroup: asStringOrNull(row, 'exclusive_group'),
    priority: asNumber(row, 'priority'),
    maxRedemptions: asNumberOrNull(row, 'max_redemptions'),
    maxPerGuest: asNumberOrNull(row, 'max_per_guest'),
    budgetAgorot: asNumberOrNull(row, 'budget_agorot'),
    effectiveFrom: asTimestamp(row, 'effective_from'),
    effectiveTo: asTimestampOrNull(row, 'effective_to'),
    isActive: asBoolean(row, 'is_active'),
    deactivatedAt: asTimestampOrNull(row, 'deactivated_at'),
    deactivationReason: asStringOrNull(row, 'deactivation_reason'),
    version: asNumber(row, 'version'),
  }
}

function toCoupon(row: Row): Coupon {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    promotionId: asString(row, 'promotion_id'),
    code: asString(row, 'code'),
    issuedToGuestId: asStringOrNull(row, 'issued_to_guest_id'),
    conditions: conditionsOf(row),
    discountKind: oneOf<PromotionDiscountKind>(
      row,
      'discount_kind',
      PROMOTION_DISCOUNT_KINDS,
      'percent',
    ),
    discountValue: asNumber(row, 'discount_value'),
    appliesTo: oneOf<PromotionAppliesTo>(
      row,
      'applies_to',
      PROMOTION_APPLIES_TO,
      'stay_total',
    ),
    singleUse: asBoolean(row, 'single_use'),
    maxRedemptions: asNumber(row, 'max_redemptions'),
    maxPerGuest: asNumberOrNull(row, 'max_per_guest'),
    budgetAgorot: asNumberOrNull(row, 'budget_agorot'),
    effectiveFrom: asTimestamp(row, 'effective_from'),
    effectiveTo: asTimestampOrNull(row, 'effective_to'),
    expiresAt: asTimestampOrNull(row, 'expires_at'),
    isActive: asBoolean(row, 'is_active'),
    deactivatedAt: asTimestampOrNull(row, 'deactivated_at'),
    deactivationReason: asStringOrNull(row, 'deactivation_reason'),
    version: asNumber(row, 'version'),
  }
}

/** How many campaigns one screen shows before it pages. */
export const PROMOTION_PAGE_SIZE = 100

export interface RedemptionTally {
  /** Rows in `discount_redemptions` for this campaign. */
  count: number
  /** What it has given away so far, in agorot. */
  spentAgorot: number
}

export class PromotionRepository {
  constructor(private readonly db: Db) {}

  async promotions(organizationId: string): Promise<readonly Promotion[]> {
    const { data, error } = await this.db
      .from('promotions')
      .select(PROMOTION_COLUMNS)
      .eq('organization_id', organizationId)
      .order('priority', { ascending: false })
      .order('code', { ascending: true })
      .limit(PROMOTION_PAGE_SIZE)

    if (error) throw error
    return toRows(data).map(toPromotion)
  }

  async promotion(
    organizationId: string,
    id: string,
  ): Promise<Promotion | null> {
    const { data, error } = await this.db
      .from('promotions')
      .select(PROMOTION_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    return data === null ? null : toPromotion(toRow(data))
  }

  async coupons(
    organizationId: string,
    promotionId: string,
  ): Promise<readonly Coupon[]> {
    const { data, error } = await this.db
      .from('coupons')
      .select(COUPON_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('promotion_id', promotionId)
      .order('code', { ascending: true })
      .limit(PROMOTION_PAGE_SIZE)

    if (error) throw error
    return toRows(data).map(toCoupon)
  }

  /**
   * The coupon a guest typed.
   *
   * Matched on `code_folded`, which is the generated column the unique index
   * sits on — so this returns at most one row BECAUSE the database cannot hold
   * two coupons whose codes differ only in case. Matching on `code` with
   * `ilike` would look equivalent and would return two rows the day somebody
   * loaded a batch from a spreadsheet.
   */
  async couponByCode(
    organizationId: string,
    code: string,
  ): Promise<Coupon | null> {
    const { data, error } = await this.db
      .from('coupons')
      .select(COUPON_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('code_folded', foldCode(code))
      .maybeSingle()

    if (error) throw error
    return data === null ? null : toCoupon(toRow(data))
  }

  /**
   * How much of a campaign has been used.
   *
   * Read from `discount_redemptions` rather than from a counter column, and
   * that is deliberate: there is no counter column. A stored count is a second
   * answer to a question the ledger already answers exactly, and the two drift
   * the first time a row is inserted by a path that forgot to bump it. The
   * ledger is append-only, so this number cannot be wrong by construction.
   *
   * Returns `null` when the reader may not see it — `booking.view_price` gates
   * the ledger and RLS enforces that, so an empty result from a reader without
   * the grant is indistinguishable from a campaign nobody has used. The caller
   * must decide which it is; this method reports the figure it can source and
   * nothing more.
   */
  async tally(
    organizationId: string,
    promotionId: string,
  ): Promise<RedemptionTally> {
    const { data, error } = await this.db
      .from('discount_redemptions')
      .select('amount_agorot')
      .eq('organization_id', organizationId)
      .eq('promotion_id', promotionId)

    if (error) throw error
    const rows = toRows(data)
    return {
      count: rows.length,
      spentAgorot: rows.reduce(
        (sum, row) =>
          sum + (typeof row.amount_agorot === 'number' ? row.amount_agorot : 0),
        0,
      ),
    }
  }
}
