import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the two reads run.
 *
 * The tall block under the heading is the gap notice, which is always rendered
 * on this screen and is the first thing a reader sees — leaving it out of the
 * placeholder would make the page jump by its own height the moment the data
 * lands.
 */
export default function LeadsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-56 w-full rounded-xl" />

      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-3.5 w-full max-w-prose" />
          </div>
          <ListSkeleton
            rows={4}
            columns={3}
            label={index === 0 ? 'טוען את צנרת המכירות' : ''}
          />
        </div>
      ))}
    </div>
  )
}
