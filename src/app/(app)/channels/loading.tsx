import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * The banner and two cards, which is what the page renders in every case. The
 * banner is sketched at its real height on purpose: it is the headline of this
 * screen — nothing is connected — and a layout that settles it into place after
 * the cards would bury the one sentence that matters.
 */
export default function ChannelsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-36 w-full rounded-xl" />

      <CardSkeleton lines={4} label="טוען את הפילוח לפי ערוץ" />
      <CardSkeleton lines={4} label="טוען את מה שחסר" />
    </div>
  )
}
