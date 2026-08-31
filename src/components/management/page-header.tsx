/**
 * The heading every management screen opens with.
 *
 * Five screens were about to repeat the same three elements — an `h1`, a
 * paragraph of what the screen is, and an optional action — with the same
 * classes copied five times. The copy is what drifts: one screen ends up with
 * `text-2xl` and its neighbour with `text-xl`, and the section reads as five
 * features rather than one.
 *
 * `lede` is deliberately required. A management screen that cannot say in one
 * sentence what it shows and what it withholds is a screen nobody can be
 * handed, and making the sentence a required prop is cheaper than a review
 * that catches its absence later.
 */

import type { ReactNode } from 'react'

export type PageHeaderProps = {
  title: string
  /** One sentence: what is on this screen, and what is deliberately not. */
  lede: ReactNode
  /** A single control. Two is a toolbar, and a toolbar is a different design. */
  action?: ReactNode
}

export function PageHeader({ title, lede, action }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="text-muted-foreground">{lede}</p>
      </div>
      {action}
    </header>
  )
}
