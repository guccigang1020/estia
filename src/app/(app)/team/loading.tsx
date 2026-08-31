import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the roster loads.
 *
 * Seven columns, because that is the table underneath. One announcement for
 * the whole region: the heading placeholder carries no label of its own, so a
 * screen reader hears "טוען את רשימת הצוות" once.
 */
export default function TeamLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <ListSkeleton rows={6} columns={7} label="טוען את רשימת הצוות" />
    </div>
  )
}
