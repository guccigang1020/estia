'use client'

/**
 * The route error boundary. `"use client"` is required by Next.js — an error
 * boundary is a Client Component by definition.
 *
 * Prop name, verified against
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`
 * rather than recalled: this version passes **`retry`**, which re-fetches and
 * re-renders the segment. `reset` still exists but the docs are explicit that
 * it only clears the error state without re-fetching, and that `retry` is what
 * you want in almost every case — including this one, where the failure is
 * most often a data fetch that may now succeed.
 */

import { useEffect } from 'react'

import { ErrorState } from '@/components/states/error-state'
import { describeError, technicalDetail } from '@/components/states/error-copy'
import { RetryButton } from '@/components/states/retry-button'
import { Button } from '@/components/ui/button'

export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    // The full object, stack included, goes to the log. What reaches the screen
    // is only what `technicalDetail` allows through.
    console.error(error)
  }, [error])

  const presentation = describeError({
    // A digest means the error crossed the server boundary, so its message was
    // already replaced with a generic one and only the digest identifies it.
    kind: error.digest ? 'server' : 'unknown',
    operation: 'להציג את הדף',
    // Rendering a page reads data; it does not write any. Saying so is more
    // useful than the kind's cautious default, and it is true for this
    // boundary specifically — an error thrown by a Server Function is returned
    // as state to its form, not thrown up to here.
    dataOutcome: 'not_saved',
    retry: 'safe',
    reference: error.digest,
  })

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
      <ErrorState
        as="h1"
        presentation={presentation}
        detail={technicalDetail(error, error.digest)}
        action={<RetryButton onRetry={retry} label="טען את הדף מחדש" />}
        secondaryAction={
          <Button href="/" variant="secondary">
            חזרה לדף הבית
          </Button>
        }
      />
    </main>
  )
}
