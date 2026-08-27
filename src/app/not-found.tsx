import type { Metadata } from 'next'

import { describeError } from '@/components/states/error-copy'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'

/**
 * The 404 screen.
 *
 * A Server Component: there is nothing interactive here, and `not-found.tsx`
 * has no `retry` to offer — a missing page does not become present because the
 * user asked twice. It uses the same `ErrorState` as every other failure so a
 * dead link does not look like it came from a different product.
 */

export const metadata: Metadata = {
  title: 'הדף לא נמצא',
}

export default function NotFound() {
  const presentation = {
    ...describeError({
      kind: 'not_found',
      operation: 'לפתוח את הדף הזה',
    }),
    // The kind's own title says "הפריט לא נמצא", which is right for a record
    // and wrong for a URL. Only the headline is replaced; the data-safety and
    // retry answers still come from the tested copy layer.
    title: 'הדף לא נמצא',
  }

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
      <ErrorState
        as="h1"
        presentation={presentation}
        action={<Button href="/">חזרה לדף הבית</Button>}
      />
    </main>
  )
}
