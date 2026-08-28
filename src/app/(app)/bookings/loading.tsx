import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Not `PageSkeleton`: that one draws three summary cards, and this screen has
 * none. A placeholder that suggests content the page never renders is a
 * layout that jumps the moment the data lands, which is the thing a skeleton
 * exists to prevent. Six rows and four columns, because that is the table
 * underneath.
 *
 * One announcement for the whole region — the pieces above the list carry an
 * empty label so a screen reader hears "טוען את רשימת ההזמנות" once rather
 * than three times.
 */
export default function BookingsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      <ListSkeleton rows={6} columns={4} label="טוען את רשימת ההזמנות" />
    </div>
  )
}
