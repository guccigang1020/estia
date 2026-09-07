import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * Four cards, which is what the page renders in every case: the plans, the
 * calendar, the recommendations and the automatic policy. Each of the four can
 * come back empty or withheld and still occupies its card, so nothing here
 * promises a section that then vanishes.
 *
 * A skeleton grid and never a full-screen spinner (spec §5.1): the calendar is
 * the slowest panel and the reader can already see the shape of the month
 * while it arrives.
 */
export default function PricingLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <CardSkeleton lines={3} label="טוען את תוכניות התעריפים" />
      <CardSkeleton lines={8} label="טוען את לוח המחירים" />
      <CardSkeleton lines={3} label="טוען את המלצות התמחור" />
      <CardSkeleton lines={3} label="טוען את מדיניות התמחור האוטומטי" />
    </div>
  )
}
