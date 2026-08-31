import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the roles load.
 *
 * Cards rather than a table, because that is what the screen resolves into:
 * each role is a card with a heading, a description and a row of chips. Four
 * of them, which is roughly one screenful — drawing twenty-two placeholders
 * for a list that arrives in one round trip is a longer flicker, not a better
 * one.
 *
 * One announcement for the region: only the first card carries a label.
 */
export default function RolesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="flex flex-col gap-4">
        <CardSkeleton lines={2} label="טוען את קטלוג התפקידים" />
        <CardSkeleton lines={2} label="" />
        <CardSkeleton lines={2} label="" />
        <CardSkeleton lines={2} label="" />
      </div>
    </div>
  )
}
