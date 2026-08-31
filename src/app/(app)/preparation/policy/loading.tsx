import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the policy loads.
 *
 * Not the board's skeleton next door: that screen is two lists of cards, and
 * this one is a stack of large panels each holding a grid of fields. A
 * placeholder that promised rows would resolve into a layout it never had,
 * which is precisely the jump a skeleton exists to prevent.
 *
 * One announcement for the whole region, so a screen reader hears "טוען את
 * מדיניות ההכנה" once rather than once per panel.
 */
export default function PreparationPolicyLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <p role="status" className="sr-only">
        טוען את מדיניות ההכנה
      </p>

      <Skeleton className="h-4 w-32" />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-prose" />
        <Skeleton className="h-4 w-3/4 max-w-prose" />
      </div>

      {Array.from({ length: 3 }, (_, panel) => (
        <div
          key={panel}
          className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-full max-w-prose" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, cell) => (
              <div key={cell} className="flex flex-col gap-2">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
