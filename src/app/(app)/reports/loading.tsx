import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the report runs.
 *
 * Not `PageSkeleton` and not `CardSkeleton`: both draw an avatar circle, and a
 * metric tile has no avatar. The placeholder is the tile — a small label, a
 * large figure, a comparison line — in the same grid, because a placeholder
 * that suggests a different shape is a layout that jumps the moment the
 * numbers land, which is the thing a skeleton exists to prevent.
 *
 * One announcement for the whole region, so a screen reader hears "טוען את
 * הדוח" once rather than nine times.
 */
export default function ReportsLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <p role="status" className="sr-only">
        טוען את הדוח
      </p>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 9 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
          >
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
