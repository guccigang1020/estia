import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the reads run.
 *
 * Five panels at the settings width, matching the page: the account, sessions
 * and password, the team, outstanding invitations, and the credentials the
 * screen refuses to render.
 */
export default function SecurityLoading() {
  return (
    <div
      role="status"
      aria-label="טוען את הגדרות האבטחה"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      {[7, 3, 5, 2, 3].map((rows, index) => (
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
