import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the reads run.
 *
 * Bands of tiles, because that is what the screen is. A generic page skeleton
 * would draw a table and the layout would jump the moment the figures land —
 * under a thumb, on a phone, which is where this screen is read.
 *
 * One announcement for the whole region. A screen reader hears "טוען את מסך
 * הבית" once rather than once per grey rectangle, which is why the bars
 * themselves are `aria-hidden` inside `Skeleton`.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <span role="status" className="sr-only">
        טוען את מסך הבית
      </span>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="mt-8 flex flex-col gap-10" aria-busy="true">
        {[0, 1].map((band) => (
          <div key={band} className="flex flex-col gap-4">
            <Skeleton className="h-6 w-32" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((tile) => (
                <Skeleton key={tile} className="h-36 rounded-xl" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
