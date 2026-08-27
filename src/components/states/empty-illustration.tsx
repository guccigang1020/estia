import type { ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

import type { EmptyIllustration } from './empty-presets'

/**
 * The illustration slot of an empty state.
 *
 * Inline SVG rather than an image file, for three reasons that all matter to
 * this product: it re-themes with the tokens (a customer brand swap changes
 * these drawings without touching an asset), it costs no request on a phone
 * with poor reception, and it cannot arrive after the text and shift the layout
 * under someone's thumb.
 *
 * Every drawing is `aria-hidden`. The heading beside it already carries the
 * meaning, and a decorative picture that also announces itself is noise.
 */

export function EmptyIllustrationArt({
  name,
  className,
}: {
  name: EmptyIllustration
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 120 88"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn('h-24 w-auto', className)}
    >
      {/* Shared ground: a soft brand wash so the drawings read as one family. */}
      <ellipse cx="60" cy="76" rx="40" ry="7" className="fill-primary-soft" />
      <g
        className="stroke-primary"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ART[name]}
      </g>
    </svg>
  )
}

const ART: Record<EmptyIllustration, ReactNode> = {
  calendar: (
    <>
      <rect
        x="28"
        y="20"
        width="64"
        height="52"
        rx="7"
        className="fill-surface"
      />
      <path d="M28 34h64" />
      <path d="M44 14v10M76 14v10" />
      <rect
        x="40"
        y="44"
        width="14"
        height="10"
        rx="3"
        className="fill-primary-soft stroke-none"
      />
      <path d="M62 49h18M40 61h40" className="stroke-border-strong" />
    </>
  ),

  property: (
    <>
      <path d="M24 44 60 20l36 24" />
      <path
        d="M32 42v28a2 2 0 0 0 2 2h52a2 2 0 0 0 2-2V42"
        className="fill-surface"
      />
      <rect
        x="52"
        y="52"
        width="16"
        height="20"
        rx="3"
        className="fill-primary-soft"
      />
      <path d="M42 50h6M72 50h6" className="stroke-border-strong" />
    </>
  ),

  unit: (
    <>
      <rect
        x="34"
        y="18"
        width="52"
        height="54"
        rx="6"
        className="fill-surface"
      />
      <path d="M46 18v54" className="stroke-border-strong" />
      <circle cx="72" cy="46" r="3" className="fill-primary" />
      <path d="M56 34h20M56 58h20" className="stroke-border-strong" />
    </>
  ),

  guest: (
    <>
      <circle cx="60" cy="34" r="12" className="fill-surface" />
      <path
        d="M36 72v-4a16 16 0 0 1 16-16h16a16 16 0 0 1 16 16v4"
        className="fill-surface"
      />
      <path d="M52 62h16" className="stroke-border-strong" />
    </>
  ),

  team: (
    <>
      <circle cx="46" cy="34" r="10" className="fill-surface" />
      <circle cx="78" cy="40" r="8" className="fill-primary-soft" />
      <path
        d="M26 70v-3a14 14 0 0 1 14-14h12a14 14 0 0 1 14 14v3"
        className="fill-surface"
      />
      <path
        d="M74 70v-3a12 12 0 0 1 8-11 12 12 0 0 1 12 11v3"
        className="stroke-border-strong"
      />
    </>
  ),

  invoice: (
    <>
      <path
        d="M36 14h36l14 14v46a4 4 0 0 1-4 4H36a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z"
        className="fill-surface"
      />
      <path d="M72 14v14h14" />
      <path d="M42 44h22M42 54h30M42 64h16" className="stroke-border-strong" />
      <circle cx="82" cy="60" r="9" className="fill-primary-soft" />
      <path d="m78 60 3 3 5-6" />
    </>
  ),

  task: (
    <>
      <rect
        x="32"
        y="16"
        width="56"
        height="58"
        rx="7"
        className="fill-surface"
      />
      <rect
        x="48"
        y="10"
        width="24"
        height="12"
        rx="4"
        className="fill-primary-soft"
      />
      <path d="m44 40 5 5 10-11" />
      <path d="M66 42h14" className="stroke-border-strong" />
      <path d="M44 58h6M60 58h20" className="stroke-border-strong" />
    </>
  ),

  message: (
    <>
      <path
        d="M28 24a6 6 0 0 1 6-6h52a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H52L36 70V58h-2a6 6 0 0 1-6-6V24Z"
        className="fill-surface"
      />
      <path d="M44 32h32M44 44h20" className="stroke-border-strong" />
    </>
  ),

  search: (
    <>
      <circle cx="54" cy="40" r="20" className="fill-surface" />
      <path d="m69 55 15 15" strokeWidth={3} />
      <path d="M45 40h18" className="stroke-border-strong" />
      <path
        d="M48 32h12M48 48h12"
        className="stroke-border-strong opacity-50"
      />
    </>
  ),
}
