import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Drawn for the register, which is what every reader of this route lands on.
 * When the tables do not exist yet the answer comes back fast and this is one
 * frame; when they do, it is a table.
 */
export default function CasesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-4 w-40" />

      <ListSkeleton rows={6} columns={6} label="טוען את תיקי הנזק" />
    </div>
  )
}
