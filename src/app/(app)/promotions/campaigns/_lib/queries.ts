/**
 * EXECUTION CONTEXT — SERVER ONLY. What the campaign screen reads.
 *
 * ── Withheld is not the same as none ───────────────────────────────────────
 *
 * A reader without `booking.view_price` may not see what a campaign has given
 * away — a reduction is a price, which is the call the neighbouring
 * `/promotions` screen already makes. Row level security enforces that, and so
 * an empty result is genuinely ambiguous: it means "nobody used it" or "you
 * may not see who did", and the two must not be shown as the same thing.
 *
 * So `null` is WITHHELD and `{ count: 0 }` is NONE. The screen renders the
 * first as a withheld marker and the second as a zero. A figure that cannot be
 * sourced is reported absent with its reason and never estimated — the
 * charter's rule, and on a screen about money it is the difference between "no
 * redemptions" and "you cannot be told".
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import type { Db } from '@/lib/persistence'
import {
  PromotionRepository,
  type RedemptionTally,
} from '@/lib/promotions/repository'
import type { Coupon, Promotion } from '@/lib/promotions'

export interface CampaignRow {
  promotion: Promotion
  /** Null when the reader may not see redemptions at all. */
  tally: RedemptionTally | null
  couponCount: number
}

export async function listCampaigns(args: {
  db: Db
  actor: Actor
  organizationId: string
}): Promise<readonly CampaignRow[]> {
  const repository = new PromotionRepository(args.db)
  const promotions = await repository.promotions(args.organizationId)
  if (promotions.length === 0) return []

  // Asked once, not once per row: `holdsGrant` does not vary between the
  // promotions on a screen, and asking inside the loop would suggest it might.
  const maySeePrices = holdsGrant(args.actor, 'booking.view_price')

  const rows = await Promise.all(
    promotions.map(async (promotion) => {
      const [tally, coupons] = await Promise.all([
        maySeePrices
          ? repository.tally(args.organizationId, promotion.id)
          : Promise.resolve(null),
        repository.coupons(args.organizationId, promotion.id),
      ])
      return { promotion, tally, couponCount: coupons.length }
    }),
  )

  return rows
}

export async function listCoupons(args: {
  db: Db
  organizationId: string
  promotionId: string
}): Promise<readonly Coupon[]> {
  return new PromotionRepository(args.db).coupons(
    args.organizationId,
    args.promotionId,
  )
}

/**
 * How much of a ceiling has been used, as a percentage for a progress bar.
 *
 * Returns `null` where there is no ceiling and where the figure is withheld —
 * both are "there is no percentage to draw", and drawing 0% for either would
 * show an unlimited campaign as one that has not started.
 */
export function usagePercent(
  used: number | null,
  ceiling: number | null,
): number | null {
  if (used === null || ceiling === null || ceiling <= 0) return null
  return Math.min(100, Math.round((used / ceiling) * 100))
}

/**
 * The threshold §9 alerts on: 80% of a campaign's budget.
 *
 * Named and exported so the screen's warning and any future notification
 * cannot disagree about where the line is. Eighty rather than ninety because
 * the point is to leave time to decide, and a campaign at 90% of its budget on
 * a Friday afternoon is a campaign that will be over before anybody reads the
 * mail.
 */
export const BUDGET_WARNING_PERCENT = 80
