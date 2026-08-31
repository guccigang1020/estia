import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Two cards and no summary row. The screen has no figures above the list, and
 * on most packages it resolves into a plan lock rather than a list at all — so
 * the placeholder stays deliberately small instead of promising a table that
 * may never arrive.
 */
export default function OwnersLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div
        role="status"
        aria-label="טוען את בעלי הנכסים"
        className="flex flex-col gap-4"
      >
        {Array.from({ length: 2 }, (_, index) => (
          <CardSkeleton key={index} lines={3} label="" />
        ))}
      </div>
    </div>
  )
}
