/**
 * The page frame every laundry screen shares.
 *
 * Extracted rather than repeated because the heading and the tagline are how
 * the mode's vocabulary reaches the reader, and seven copies of the same
 * markup is seven places for one of them to keep saying "מכבסה" to a business
 * that does not use one.
 */

import type { ReactNode } from 'react'

export type LaundryShellProps = {
  heading: string
  /** One line under the heading, from the mode's own vocabulary. */
  tagline: string
  children: ReactNode
}

export function LaundryShell({
  heading,
  tagline,
  children,
}: LaundryShellProps) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {heading}
        </h1>
        <p className="text-muted-foreground">{tagline}</p>
      </header>
      {children}
    </div>
  )
}
