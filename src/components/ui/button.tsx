import type { ComponentProps } from 'react'

import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

type StyleProps = {
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * A Button is either a real `<button>` or, when `href` is given, an `<a>`
 * styled identically. `href` is the discriminant, so TypeScript hands each
 * branch the right DOM props.
 */
export type ButtonProps =
  | (StyleProps & ComponentProps<'button'> & { href?: never })
  | (StyleProps & ComponentProps<'a'> & { href: string })

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full font-medium ' +
  'whitespace-nowrap transition-colors duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:pointer-events-none disabled:opacity-50'

const VARIANT: Record<ButtonVariant, string> = {
  /**
   * The gradient, not a flat fill, and it is the product's signature surface.
   *
   * `estia-grad-primary` is a token in globals.css rather than a literal here,
   * so the same three stops carry the primary button, the enabled tiles and
   * the dials — three places that would otherwise drift apart. The gradient
   * paints over `bg-primary`, which stays as the fallback ink relationship
   * the contrast measurement was made against.
   */
  primary:
    'estia-grad-primary bg-primary text-primary-foreground shadow-soft ' +
    'hover:brightness-110 active:brightness-95',
  secondary:
    'border border-border-strong bg-surface text-foreground hover:bg-muted active:bg-muted',
  ghost: 'text-foreground hover:bg-muted active:bg-muted',
  /**
   * Added for irreversible actions, and added as a variant rather than as a
   * `className` on `primary` on purpose: `cn` appends without merging, so a
   * caller-supplied `bg-danger` would sit in the class list next to
   * `bg-primary` and the winner would be decided by stylesheet order. See the
   * note in `cn.ts`.
   *
   * The ink is `surface`, not a hardcoded white, so it follows the token when
   * the palette moves — which it just did. Re-measured against the dusk
   * values rather than left claiming the old ones: #211f27 on #fb7185 is
   * 5.79:1 — AA. It is deliberately NOT a gradient: `primary` owns that
   * surface, and an irreversible action that looked like the ordinary one
   * would be the wrong kind of consistency.
   */
  danger:
    'bg-danger text-surface shadow-soft hover:bg-danger/90 active:bg-danger/80',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-11 px-5 text-[0.9375rem]',
  lg: 'h-13 px-7 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonProps) {
  const classes = cn(BASE, VARIANT[variant], SIZE[size], className)

  if (props.href !== undefined) {
    return <a className={classes} {...props} />
  }

  return <button type="button" className={classes} {...props} />
}
