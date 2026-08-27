import { PageSkeleton } from '@/components/states/skeleton'

/**
 * The route-level loading fallback.
 *
 * A Server Component with no state: Next.js renders it inside the Suspense
 * boundary it wraps around the segment, so it is shown and replaced without any
 * client work of its own.
 *
 * It is a skeleton in the shape of a module screen rather than a spinner. On a
 * phone in a car park — which is where this product is actually used — a
 * spinner tells the owner nothing is happening yet, while a skeleton tells them
 * where tonight's arrivals will appear and stops the layout jumping under their
 * thumb when it does.
 */

export default function Loading() {
  return <PageSkeleton />
}
