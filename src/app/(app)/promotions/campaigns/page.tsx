import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { PageHeader } from '@/components/management/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDayMonthYear } from '@/lib/booking'
import { toSafeResponse } from '@/lib/errors'
import {
  APPLIES_TO_LABEL,
  PROMOTION_KIND_LABEL,
  describeDiscount,
} from '@/lib/promotions'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireDistributionGrant } from '../../agents/_lib/gate'
import {
  BUDGET_WARNING_PERCENT,
  listCampaigns,
  usagePercent,
  type CampaignRow,
} from './_lib/queries'
import { PauseCampaign } from './_components/pause-campaign'

export const metadata: Metadata = { title: 'קטלוג המבצעים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The campaigns a business is running.
 *
 * ══ WHY THIS IS A SIBLING OF /promotions AND NOT PART OF IT ═════════════════
 *
 * `/promotions` already exists and its header says, at length, that there is
 * no promotions catalogue — that `promotion` is a line on a booking and not a
 * campaign, and that drawing campaign cards over nothing would let a business
 * plan a season around tiles that apply to no booking. That was right, and
 * `0073_promotions_and_coupons.sql` is what stops it being true.
 *
 * The obvious move is therefore to extend that screen. It is the wrong one,
 * and the reason is not layout:
 *
 *   · **They answer questions in different tenses.** `/promotions` is a
 *     report — what has already been given away, and under which sellers'
 *     terms, read from `booking_price_lines` and `agent_commission_rules`.
 *     This screen is configuration: what WILL be offered, to whom, and until
 *     when. A screen that is half report and half form is a screen where the
 *     number beside a button means something the button will not change.
 *
 *   · **They are gated on different grants.** The report's panels are gated
 *     individually on `commission.view` and `booking.view_price`; this screen
 *     is `pricing.manage` throughout, which is what the RLS policies on
 *     `promotions` and `coupons` demand. Merged, one screen would have to be
 *     gated on the union of four grants, and a reader holding two of them
 *     would meet a page that is mostly empty for reasons it cannot explain.
 *
 *   · **The commission view borrowed the name honestly and should keep it.**
 *     "מבצעים ותמחור" is where a business already looks for what it gave away.
 *     Renaming it to make room here would move a screen people have learned.
 *
 * So: a sibling route, linked from the report, sharing its plan gate. The
 * report's own statement is amended to point here rather than to keep claiming
 * a catalogue does not exist.
 *
 * ══ WHAT THIS SCREEN DELIBERATELY DOES NOT DO ══════════════════════════════
 *
 *   · **It does not price anything.** Nothing here calls `priceStay` and
 *     nothing computes a booking's discount. §6 rule 37: changing a campaign
 *     does not move an existing booking, and the strongest way to keep that
 *     true is for the campaign screen to have no path to a booking at all.
 *
 *   · **It has no visual condition builder** (§5.3). The closed condition
 *     language is implemented and tested in `src/lib/promotions/conditions.ts`
 *     and enforced by a CHECK in 0073; the builder over it is a second slice.
 *     A campaign created here therefore applies to every booking until
 *     somebody narrows it, which the empty state says out loud rather than
 *     letting a manager discover it from the invoices.
 *
 *   · **It does not redeem.** Redeeming happens while a booking is taken, and
 *     it goes through `public.redeem_discount` so that the limit is enforced
 *     by a unique index rather than by a count in TypeScript. A redeem button
 *     on a catalogue screen would invite exactly the code that loses the race.
 */
export default async function CampaignsPage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('pricing.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="קטלוג המבצעים אינו כלול בחבילה שלך"
        body="כאן מוגדרים קמפיינים וקופונים: מי זכאי, כמה הוא מקבל, וכמה פעמים אפשר לממש."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access

  let campaigns: readonly CampaignRow[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    campaigns = await listCampaigns({
      db,
      actor,
      organizationId: actor.organizationId,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const live = campaigns.filter((row) => row.promotion.isActive)
  const stopped = campaigns.filter((row) => !row.promotion.isActive)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="קטלוג המבצעים"
        lede="הקמפיינים והקופונים שהעסק מציע: מי זכאי, כמה הוא מקבל, וכמה פעמים אפשר לממש. ההנחות שכבר ניתנו בפועל נמצאות במסך מבצעים ותמחור."
        action={
          <Link
            href="/promotions"
            className="text-sm font-medium text-foreground underline underline-offset-4"
          >
            מה כבר ניתן בפועל
          </Link>
        }
      />

      {/* The law that makes a campaign safe to edit, said on the screen and
          not only in the migration. A manager who does not know this will not
          touch a campaign after the season starts, which costs the business
          the flexibility the whole feature exists to give it. */}
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">
          שינוי מבצע אינו נוגע בהזמנה קיימת.
        </span>{' '}
        ההנחה שאורח קיבל נצרבת על ההזמנה שלו ברגע שהיא ניתנת, יחד עם התנאים כפי
        שהיו. השהיה של מבצע עוצרת אותו מכאן והלאה בלבד, ולכן אפשר לעצור קמפיין
        באמצע העונה בלי לחשוש למה שכבר נמכר.
      </p>

      {failure ? (
        <ActionError error={failure.error} />
      ) : campaigns.length === 0 ? (
        <EmptyState
          illustration="calendar"
          title="עוד לא הוגדר אף מבצע"
          body="מבצע הוא הבטחה מסחרית: אחוז או סכום, לקהל מוגדר, עם תקרת מימושים ותאריך סיום. מבצע שנוצר בלי תנאים חל על כל ההזמנות — כדאי לקבוע לו תקרת מימושים או תקציב לפני שמפעילים אותו."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2">מבצעים פעילים</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              כשכמה מבצעים מתאימים לאותה הזמנה, העדיפות הגבוהה מנצחת — ולא ההנחה
              הגדולה. מבצע שאינו מצטבר עוצר את הרשימה. לקופון ציר נפרד: קופון
              אחד לכל היותר להזמנה, אחרי המבצעים.
            </p>

            {live.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                כל המבצעים מושהים כרגע.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {live.map((row) => (
                  <li key={row.promotion.id} className="py-4">
                    <Campaign row={row} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {stopped.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle as="h2">מבצעים שנעצרו</CardTitle>
              </CardHeader>
              <p className="mt-2 text-sm text-muted-foreground">
                מבצע שנעצר אינו נמחק, וזה מכוון: הוא ההסבר למחיר שאורח שילם
                בזמנו. כאן נשמר גם מי עצר אותו ומתי.
              </p>
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {stopped.map((row) => (
                  <li key={row.promotion.id} className="py-4">
                    <Campaign row={row} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function Campaign({ row }: { row: CampaignRow }) {
  const { promotion, tally, couponCount } = row
  const redemptionPercent = usagePercent(
    tally?.count ?? null,
    promotion.maxRedemptions,
  )
  const budgetPercent = usagePercent(
    tally?.spentAgorot ?? null,
    promotion.budgetAgorot,
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{promotion.name}</span>
          {/* dir="ltr" on the code alone: it is a latin machine identifier
              inside a right-to-left sentence, and without this the hyphen in
              `direct-booking` lands on the wrong end. */}
          <span dir="ltr" className="font-mono text-xs text-muted-foreground">
            {promotion.code}
          </span>
          <Badge>{PROMOTION_KIND_LABEL[promotion.kind]}</Badge>
          {!promotion.stackable && <Badge tone="accent">אינו מצטבר</Badge>}
          {promotion.exclusiveGroup !== null && (
            <Badge tone="neutral">קבוצה {promotion.exclusiveGroup}</Badge>
          )}
        </div>
        <span className="font-semibold text-foreground">
          {describeDiscount(promotion)} ·{' '}
          {APPLIES_TO_LABEL[promotion.appliesTo]}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="בתוקף מ">
          {formatDayMonthYear(promotion.effectiveFrom.slice(0, 10))}
          {promotion.effectiveTo === null ? (
            // §17: a campaign with no end date keeps running, and a business
            // that meant to end it in September finds out in December.
            <span className="text-muted-foreground"> · ללא תאריך סיום</span>
          ) : (
            <span className="text-muted-foreground">
              {' '}
              עד {formatDayMonthYear(promotion.effectiveTo.slice(0, 10))}
            </span>
          )}
        </Fact>

        <Fact label="עדיפות">{promotion.priority}</Fact>

        <Fact label="מימושים">
          {tally === null ? (
            // Withheld, not zero. The reader may not see what was given away,
            // and showing "0" would be a figure this screen invented.
            <span className="text-muted-foreground">
              מוסתר — נדרשת הרשאה לצפייה במחירי הזמנות
            </span>
          ) : promotion.maxRedemptions === null ? (
            <>
              {tally.count}{' '}
              <span className="text-muted-foreground">· ללא הגבלה</span>
            </>
          ) : (
            <>
              {tally.count} מתוך {promotion.maxRedemptions}
              {redemptionPercent !== null && (
                <span className="text-muted-foreground">
                  {' '}
                  · {redemptionPercent}%
                </span>
              )}
            </>
          )}
        </Fact>

        <Fact label="תקציב">
          {promotion.budgetAgorot === null ? (
            <span className="text-muted-foreground">ללא תקציב מוגדר</span>
          ) : tally === null ? (
            <span className="text-muted-foreground">מוסתר</span>
          ) : (
            <>
              <Money agorot={tally.spentAgorot} /> מתוך{' '}
              <Money agorot={promotion.budgetAgorot} />
              {budgetPercent !== null &&
                budgetPercent >= BUDGET_WARNING_PERCENT && (
                  <Badge tone="accent"> נוצלו {budgetPercent}%</Badge>
                )}
            </>
          )}
        </Fact>

        {couponCount > 0 && (
          <Fact label="קופונים">{couponCount} קופונים הונפקו מהמבצע הזה</Fact>
        )}

        {!promotion.isActive && (
          <Fact label="נעצר">
            {promotion.deactivatedAt === null
              ? '—'
              : formatDayMonthYear(promotion.deactivatedAt.slice(0, 10))}
            {promotion.deactivationReason !== null && (
              <span className="text-muted-foreground">
                {' '}
                ·{' '}
                {promotion.deactivationReason === 'max_redemptions_reached'
                  ? 'מוצו כל המימושים'
                  : promotion.deactivationReason}
              </span>
            )}
          </Fact>
        )}
      </dl>

      {promotion.isActive && (
        <PauseCampaign
          promotionId={promotion.id}
          promotionName={promotion.name}
        />
      )}
    </div>
  )
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}
