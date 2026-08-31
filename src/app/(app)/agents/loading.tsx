import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * One filter control and five columns, matching the table underneath. No
 * placeholder for the management panel: whether it renders at all depends on a
 * per-agent `can()` the server has not answered yet, and a skeleton for a
 * section that then does not appear is a layout that jumps.
 */
export default function AgentsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-32" />
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

      <ListSkeleton rows={4} columns={5} label="טוען את רשימת הסוכנים" />
    </div>
  )
}
