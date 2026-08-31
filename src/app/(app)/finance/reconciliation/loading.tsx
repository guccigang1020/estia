import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Four summary figures and a six-column table, because that is what lands. The
 * placeholder draws four and not three: the screen carries נדרש, התקבל, פער and
 * ממתין־לבירור, and a three-figure placeholder would reflow the moment the
 * fourth appears.
 */
export default function ReconciliationLoading() {
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

      <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-4 sm:p-5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-28" />
          </div>
        ))}
      </div>

      <ListSkeleton rows={6} columns={6} label="טוען את ההתאמות" />
    </div>
  )
}
