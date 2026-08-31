import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Drawn to the shape this screen actually has: a heading, one action, a filter
 * bar with three controls, four figures, and a six-column table. The layout
 * does not jump when the data lands, which on a board somebody scans every
 * morning matters more than on a screen they open twice a year.
 *
 * One announcement for the whole region: the pieces above the list carry no
 * label of their own, so a screen reader hears "טוען את לוח המשימות" once
 * rather than four times.
 */
export default function TasksLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-11 w-36 rounded-lg" />

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-4 sm:p-5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      <ListSkeleton rows={8} columns={6} label="טוען את לוח המשימות" />
    </div>
  )
}
