'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * The one piece of interactive machinery the shell needs: a button that
 * reveals a panel. The workspace switcher, the property switcher, quick
 * create, notifications and the profile menu are all this component with
 * different contents, and those contents are rendered on the SERVER and passed
 * in as `children` — so the switcher forms, which post to Server Actions, stay
 * out of the client bundle entirely.
 *
 * Accessibility is the reason this is a component rather than five ad-hoc
 * `useState` calls: the trigger owns `aria-expanded` and `aria-controls`, focus
 * returns to it on Escape, and an outside pointer closes the panel. Getting
 * that right once is the argument for the abstraction.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

import { NavIcon, type NavIconName } from './icons'

export type PopoverProps = {
  /** The accessible name of the trigger. Always present, even when only an icon shows. */
  label: string
  icon?: NavIconName
  /** Rendered inside the trigger beside the icon. Hidden on small screens when absent. */
  triggerContent?: ReactNode
  /** Secondary line inside the trigger — the current context, typically. */
  triggerDetail?: ReactNode
  children: ReactNode
  /** Panel width. Defaults to a comfortable menu measure. */
  panelClassName?: string
  triggerClassName?: string
  /** Show the small chevron that tells people the control opens something. */
  withChevron?: boolean
}

export function Popover({
  label,
  icon,
  triggerContent,
  triggerDetail,
  children,
  panelClassName,
  triggerClassName,
  withChevron = false,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Focus goes back where it came from. Without this the next Tab starts
      // from the top of the document, which on a shell this size is a long way
      // from where the person was.
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerContent ? undefined : label}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-2 rounded-full text-foreground transition-colors',
          'hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          open && 'bg-muted',
          triggerClassName ?? 'h-10 px-3',
        )}
      >
        {icon ? <NavIcon name={icon} className="size-5 shrink-0" /> : null}
        {triggerContent ? (
          <span className="flex min-w-0 flex-col items-start text-start leading-tight">
            <span className="truncate text-sm font-semibold">
              {triggerContent}
            </span>
            {triggerDetail ? (
              <span className="truncate text-xs text-muted-foreground">
                {triggerDetail}
              </span>
            ) : null}
          </span>
        ) : null}
        {withChevron ? (
          <NavIcon
            name="chevron"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="menu"
          aria-label={label}
          className={cn(
            // `end-0` and not `right-0`: the panel hangs from the inline end of
            // its trigger, which is the left in Hebrew and the right in a
            // future English build. Physical directions do not survive that.
            'absolute end-0 z-50 mt-2 overflow-hidden rounded-lg border border-border bg-surface shadow-lift',
            panelClassName ?? 'w-64',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
