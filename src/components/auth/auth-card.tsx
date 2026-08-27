import Link from 'next/link'
import type { ReactNode } from 'react'

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * The shared frame every authentication screen sits in.
 *
 * Built on the existing `Card` primitives rather than a second card
 * implementation, so a change to elevation or radius in `card.tsx` reaches
 * these screens too.
 *
 * KNOWN GAP: the title should be an `h1`. Each of these screens is its own
 * page, and a page whose highest heading is an `h2` gives a screen-reader user
 * a document outline that starts halfway down. `CardTitle` takes the level as
 * a prop for exactly this reason, but its union is `"h2" | "h3" | "h4"` and
 * `card.tsx` belongs to another engineer. `h2` is used here, and widening that
 * union to include `"h1"` is raised in the handover notes rather than patched
 * around with a duplicate heading.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Card className="w-full max-w-[26rem]">
      <CardHeader>
        <CardTitle as="h2" className="text-2xl">
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>

      <CardContent className="mt-6">{children}</CardContent>

      {footer ? (
        <CardFooter className="text-sm text-muted-foreground">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  )
}

/**
 * A text link in the same visual language as the rest of the auth screens.
 * Underlined by default rather than on hover — an underline that only appears
 * on hover is invisible to anyone who is not using a mouse.
 */
export function AuthLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
    >
      {children}
    </Link>
  )
}
