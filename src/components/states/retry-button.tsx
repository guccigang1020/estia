'use client'

/**
 * `"use client"` because a retry is a click handler plus a transition: the
 * component has to know that the retry is still running so it can stop a
 * second one. That state cannot exist on the server.
 */

import { useRef, useTransition } from 'react'

import { Button, type ButtonVariant } from '@/components/ui/button'

export type RetryButtonProps = {
  /**
   * In a route error boundary this is Next's `retry`. Anywhere else it is
   * whatever re-runs the failed work.
   */
  onRetry: () => void
  label?: string
  pendingLabel?: string
  variant?: ButtonVariant
}

export function RetryButton({
  onRetry,
  label = 'נסה שוב',
  pendingLabel = 'מנסה שוב…',
  variant = 'primary',
}: RetryButtonProps) {
  // `retry` re-fetches and re-renders the segment, which is a transition. Owning
  // the transition here is what lets the button report progress instead of
  // looking dead for the second and a half the refetch takes.
  const [pending, startTransition] = useTransition()
  // Checked synchronously: two clicks in the same tick both read the same
  // rendered `pending`, so the state flag alone would let the second through.
  const running = useRef(false)

  return (
    <Button
      variant={variant}
      disabled={pending}
      onClick={() => {
        if (running.current || pending) return
        running.current = true
        startTransition(() => {
          try {
            onRetry()
          } finally {
            running.current = false
          }
        })
      }}
    >
      {pending && <Spinner />}
      {pending ? pendingLabel : label}
      {/* The label change is enough for a sighted user; this is what makes the
          change perceivable to a screen reader without stealing focus. */}
      <span aria-live="polite" className="sr-only">
        {pending ? 'מנסה שוב' : ''}
      </span>
    </Button>
  )
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="size-4 animate-spin motion-reduce:animate-none"
    >
      <circle cx="10" cy="10" r="7.5" className="opacity-30" />
      <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" />
    </svg>
  )
}
