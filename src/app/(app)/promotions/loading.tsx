import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * Three cards, which is exactly what the page renders in every case: the rules,
 * the ceilings and what was actually given. Each of the three can come back
 * empty or withheld and still occupies its card, so nothing here promises a
 * section that then vanishes.
 */
export default function PromotionsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-16 w-full rounded-lg" />

      <CardSkeleton lines={4} label="טוען את כללי העמלה" />
      <CardSkeleton lines={3} label="טוען את תקרות ההנחה" />
      <CardSkeleton lines={4} label="טוען את ההנחות שניתנו" />
    </div>
  )
}
