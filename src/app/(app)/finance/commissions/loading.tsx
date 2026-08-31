import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * One figure above the table rather than three, because that is what the
 * commissions screen shows — a placeholder suggesting content the page never
 * renders is a layout that jumps when the data lands. Five columns, matching
 * the table underneath.
 */
export default function CommissionsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-7 w-32" />
      </div>

      <ListSkeleton rows={5} columns={5} label="טוען את רשימת העמלות" />
    </div>
  )
}
