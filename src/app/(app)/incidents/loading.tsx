import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Drawn for the register, which is the branch most readers of this route land
 * on. A reporter without `incident.view` sees the card screen instead and it
 * renders without a query, so the mismatch lasts one frame and costs nothing.
 */
export default function IncidentsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-11 w-36 rounded-lg" />

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      <ListSkeleton rows={6} columns={6} label="טוען את רשימת התקלות" />
    </div>
  )
}
