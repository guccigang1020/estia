import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Not `PageSkeleton`: that one draws three summary cards above a list, and
 * this screen has no summary cards — it has a heading, sometimes one notice,
 * and a table of eight columns. Drawing cards that never arrive is a layout
 * that jumps under a thumb.
 *
 * One announcement for the whole region, so a screen reader hears
 * "טוען את רשימת היחידות" once rather than twice.
 */
export default function UnitsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <ListSkeleton rows={6} columns={8} label="טוען את רשימת היחידות" />
    </div>
  )
}
