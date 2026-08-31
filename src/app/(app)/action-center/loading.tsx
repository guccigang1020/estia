import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the reads run.
 *
 * Five panels, because the screen has five. `PageSkeleton` draws summary cards
 * above a list and this screen has no summary cards at all — using it would
 * make the layout jump the moment the data lands, and would promise a row of
 * figures the page then refuses to show.
 *
 * One announcement for the whole region: only the first `ListSkeleton` carries
 * a label, so a screen reader hears "טוען את מרכז הפעולות" once rather than
 * five times.
 */
export default function ActionCenterLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-prose" />
        <Skeleton className="h-4 w-2/3 max-w-prose" />
      </div>

      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-3.5 w-full max-w-prose" />
          </div>
          <ListSkeleton
            rows={3}
            columns={3}
            label={index === 0 ? 'טוען את מרכז הפעולות' : ''}
          />
        </div>
      ))}
    </div>
  )
}
