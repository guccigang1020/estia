import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the reads run.
 *
 * The tall block is the gap report, which is always the first thing on this
 * screen. Three panels below it, because there are three lists.
 */
export default function InboxLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-56 w-full rounded-xl" />

      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-3.5 w-full max-w-prose" />
          </div>
          <ListSkeleton
            rows={3}
            columns={2}
            label={index === 0 ? 'טוען את תיבת הפניות' : ''}
          />
        </div>
      ))}
    </div>
  )
}
