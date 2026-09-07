import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * One card, not two. The stopped-campaigns card only renders when there is
 * something in it, and a skeleton for a section that then vanishes is worse
 * than no skeleton at all: the layout moves after the page has settled, which
 * reads as a bug.
 */
export default function CampaignsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-16 w-full rounded-lg" />

      <CardSkeleton lines={5} label="טוען את המבצעים" />
    </div>
  )
}
