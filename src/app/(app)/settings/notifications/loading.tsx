import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the reads run.
 *
 * Four panels at the settings width, matching the page: the inbox, the
 * preference grid, the channel status, the organization's settings. The row
 * counts are the shapes those panels actually have, so the layout does not
 * jump when the data arrives.
 */
export default function NotificationSettingsLoading() {
  return (
    <div
      role="status"
      aria-label="טוען את הגדרות ההתראות"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      {[4, 8, 5, 7].map((rows, index) => (
        <div
          key={index}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3.5 w-full max-w-prose" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton key={row} className="h-5 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
