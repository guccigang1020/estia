import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Cards rather than table rows: an expense rule is a block with a formula, a
 * scope and a collapsible list of the stays it charged, and a placeholder that
 * drew a table would jump into cards the moment the data lands — which is the
 * thing a skeleton exists to prevent. Three summary figures above, because that
 * is what the screen has.
 */
export default function ExpensesLoading() {
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

      <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-28" />
          </div>
        ))}
      </div>

      <div
        role="status"
        aria-label="טוען את כללי ההוצאה"
        className="flex flex-col gap-4"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <CardSkeleton key={index} lines={3} label="" />
        ))}
      </div>
    </div>
  )
}
