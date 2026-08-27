'use client'

import { useEffect, useRef } from 'react'

import { cn } from '@/components/ui/cn'

/**
 * The message a form shows after it comes back from the server.
 *
 * Two behaviours that are easy to get wrong and matter a great deal:
 *
 * 1. FOCUS MOVES HERE ON FAILURE. After a submit, focus is still on the button
 *    the user pressed, and a screen-reader user is given no reason to look
 *    anywhere else. The alert is focusable (`tabIndex={-1}`, which makes it
 *    programmatically focusable without adding it to the tab order) and takes
 *    focus whenever a new result arrives.
 *
 * 2. `attempt` DRIVES THE EFFECT, NOT THE MESSAGE. Submitting the same wrong
 *    password twice produces the same string, so keying on the text would move
 *    focus once and then sit silent while the user wonders whether anything
 *    happened. The action increments `attempt` on every run, so every response
 *    re-announces.
 *
 * `role="alert"` carries an implicit `aria-live="assertive"`, so the message is
 * announced even in the case where focus has been moved elsewhere by the user.
 */

export type AlertTone = 'error' | 'success' | 'info'

const TONE: Record<AlertTone, string> = {
  error: 'border-danger/40 bg-danger/10 text-foreground',
  success: 'border-success/40 bg-success/10 text-foreground',
  info: 'border-border-strong bg-muted text-foreground',
}

export function FormAlert({
  tone,
  message,
  attempt,
  className,
}: {
  tone: AlertTone
  message: string
  /** Changes on every server response, including repeats of the same message. */
  attempt: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // `attempt` of 0 is the initial render — a message present at that point
    // came from the URL (an expired link, say), not from something the user
    // just did, so stealing focus would be unexpected.
    if (attempt > 0) ref.current?.focus()
  }, [attempt])

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className={cn(
        'flex items-start gap-2.5 rounded-md border p-3.5 text-sm',
        TONE[tone],
        className,
      )}
    >
      <AlertIcon tone={tone} />
      <span>{message}</span>
    </div>
  )
}

function AlertIcon({ tone }: { tone: AlertTone }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(
        'mt-0.5 size-4.5 shrink-0',
        tone === 'error' && 'text-danger',
        tone === 'success' && 'text-success',
        tone === 'info' && 'text-muted-foreground',
      )}
    >
      <circle cx="12" cy="12" r="9.25" />
      {tone === 'success' ? (
        <path d="m8 12.25 2.75 2.75L16 9.5" />
      ) : (
        <>
          <path d="M12 7.75v5" />
          <path d="M12 16.25h.01" />
        </>
      )}
    </svg>
  )
}
