import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * Two cards side by side and three figures under them, which is the shape the
 * page actually renders before any list. The lists below are not sketched: how
 * many of them appear depends on grants the server has not answered yet, and a
 * placeholder for a section that then does not exist is a layout that jumps.
 */
export default function AgentLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  )
}
