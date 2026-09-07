/**
 * The pieces the dusk language is made of, so that no screen redraws them.
 *
 * ══ WHY A KIT AND NOT A STYLE GUIDE ═════════════════════════════════════════
 *
 * The token layer moved every colour, radius and shadow in the product at
 * once. What it cannot move is COMPOSITION — a gradient tile, a dial, a row of
 * instruments separated by hairlines. Left to each screen those drift within a
 * week: two dials with different stroke widths, three tiles with three ideas
 * about where the label goes, and a product that looks assembled from parts.
 *
 * So they live here, once, and screens arrange them.
 *
 * ══ NONE OF THESE IS A CLIENT COMPONENT ════════════════════════════════════
 *
 * No state, no handlers, no `'use client'`. They render on the server with
 * everything else, and a screen that needs interaction wraps one rather than
 * making all of them client components — `scripts/client-bundle.mjs` exists
 * because a Client Component that reaches a server-only module takes every
 * route down, and the cheapest way to never do that is to stay on the server.
 *
 * ══ `Figure` IS THE IMPORTANT ONE ═══════════════════════════════════════════
 *
 * Three modules already produce "I cannot measure this, and here is why":
 * `revenue` returns a `Measure`, `listing-quality` returns `not_assessed`, and
 * `reviews` returns a null average. Each was rendering that answer its own
 * way. One renderer means one visual vocabulary for absence — and absence is
 * the thing this product is most careful about, so it should not be the thing
 * each screen improvises.
 */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from './cn'
import { openArc, ring } from './gauge'

/* ══════════════════════════════════════════════════════════ the tile ══════ */

export type TileTone = 'primary' | 'success' | 'accent' | 'quiet'

const TILE: Record<TileTone, string> = {
  primary: 'estia-grad-primary text-white',
  success: 'estia-grad-success text-white',
  accent: 'estia-grad-accent text-white',
  // The off state. A tile that is switched off should not shout in colour —
  // it is the one whose whole message is that nothing is happening.
  quiet: 'estia-grad-quiet text-foreground ring-1 ring-inset ring-border',
}

/**
 * One switch, or one figure, as a saturated card.
 *
 * The loud surface of the product. Everything around a row of these stays
 * quiet deliberately, which is what lets four of them carry a screen — spend
 * the boldness in one place.
 *
 * `state` is a short word, not an icon alone: "פעיל" beside a switch reads at
 * a glance and survives being photographed, printed, or read aloud down a
 * telephone by somebody describing their screen to support.
 */
export function StatTile({
  tone = 'quiet',
  icon,
  state,
  on,
  name,
  detail,
  className,
  ...props
}: {
  tone?: TileTone
  icon?: ReactNode
  /** e.g. "פעיל" / "כבוי". Omit for a tile that is a figure, not a switch. */
  state?: string
  on?: boolean
  /** A word, or a figure the caller has already sized and formatted. */
  name: ReactNode
  detail?: string
} & ComponentProps<'div'>) {
  const muted = tone === 'quiet'

  return (
    <div
      className={cn(
        'relative flex min-h-32 flex-col justify-between overflow-hidden rounded-xl p-4 shadow-lift',
        TILE[tone],
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2">
        {icon ? (
          <span
            className={cn(
              'grid size-8 place-items-center rounded-lg',
              muted ? 'bg-white/8 text-muted-foreground' : 'bg-white/20',
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : (
          <span />
        )}

        {state ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[0.6875rem] font-bold tracking-wide',
              muted ? 'text-muted-foreground' : 'text-white',
            )}
          >
            {state}
            <Switch on={on ?? false} muted={muted} />
          </span>
        ) : null}
      </div>

      <div>
        <div className="text-center text-base font-medium">{name}</div>
        {detail ? (
          <div
            className={cn(
              'text-center text-[0.6875rem]',
              muted ? 'text-muted-foreground' : 'text-white/75',
            )}
          >
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Decoration only — the real control is whatever the screen wraps this in. */
function Switch({ on, muted }: { on: boolean; muted: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative h-[1.125rem] w-8 shrink-0 rounded-full',
        on ? 'bg-black/30' : muted ? 'bg-white/10' : 'bg-black/30',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-3.5 rounded-full',
          on ? 'end-0.5 bg-white' : 'start-0.5 bg-border-strong',
        )}
      />
    </span>
  )
}

/* ══════════════════════════════════════════════════════════ the dial ══════ */

/**
 * A ring gauge.
 *
 * `fraction` may be null, and that is the point: null draws the track with no
 * value and the caption says why, rather than drawing an empty ring that looks
 * exactly like zero. `fractionOf` in `gauge.ts` returns null for a missing or
 * zero denominator so a caller cannot accidentally collapse the two.
 */
export function Dial({
  fraction,
  label,
  value,
  sweep,
  tone = 'primary',
  size = 116,
}: {
  fraction: number | null
  /** The word under the number. */
  label: string
  /** What to print in the middle. The caller formats it; the dial never does. */
  value: ReactNode
  /** Fraction of the full circle the track occupies. 1 is a closed ring. */
  sweep?: number
  tone?: 'primary' | 'success' | 'accent'
  size?: number
}) {
  const radius = size / 2 - 8
  const open = sweep !== undefined && sweep < 1
  const arc = open
    ? openArc(radius, fraction ?? 0, sweep)
    : { track: ring(radius, 1), value: ring(radius, fraction ?? 0) }

  const stroke =
    tone === 'success'
      ? 'stroke-success'
      : tone === 'accent'
        ? 'stroke-accent'
        : 'stroke-primary'

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={open ? 'rotate-[135deg]' : '-rotate-90'}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={open ? 9 : 6}
          strokeLinecap="round"
          className="stroke-muted"
          strokeDasharray={arc.track.dashArray}
          strokeDashoffset={arc.track.dashOffset}
        />
        {fraction === null ? null : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={open ? 9 : 6}
            strokeLinecap="round"
            className={stroke}
            strokeDasharray={arc.value.dashArray}
            strokeDashoffset={arc.value.dashOffset}
          />
        )}
      </svg>

      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="estia-figures text-2xl leading-none">{value}</div>
          <div className="mt-1 text-[0.6875rem] text-muted-foreground">
            {label}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════ the instrument bar ══ */

/** A row of cells separated by hairlines, wrapping to a stack on a telephone. */
export function InstrumentBar({
  className,
  ...props
}: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'grid grid-cols-1 gap-5 rounded-2xl border border-border bg-surface-raised p-5 shadow-soft',
        'sm:grid-cols-[auto_1fr_auto] sm:gap-0',
        className,
      )}
      {...props}
    />
  )
}

export function Instrument({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-4 sm:px-6',
        // The divider goes on the start edge of every cell but the first, so
        // a stacked layout on a telephone shows none of them.
        '[&:not(:first-child)]:sm:border-s [&:not(:first-child)]:sm:border-border-strong/40',
        className,
      )}
      {...props}
    />
  )
}

/* ═════════════════════════════════════════════════════════ the figure ════ */

/**
 * A number, or the reason there is not one.
 *
 * The shape mirrors `revenue`'s `Measure` without importing it: this component
 * is used by screens whose modules produce `not_assessed` findings and null
 * averages too, and coupling the kit to one module's type would make the other
 * two convert on the way in.
 */
export type FigureValue =
  | { readonly known: true; readonly display: ReactNode }
  | { readonly known: false; readonly why: string }

/**
 * A dash is read as zero by everybody in a hurry, so an absent figure gets
 * words. This is the single most repeated judgement in the product and it
 * belongs in one place.
 */
export function Figure({
  label,
  value,
  hint,
}: {
  label: string
  value: FigureValue
  /** A sentence under the figure, when the number needs its definition. */
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
        {value.known ? (
          <span className="estia-figures min-w-0 text-end text-sm font-medium text-foreground">
            {value.display}
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
              לא ניתן למדוד
            </span>
            <span className="text-xs text-muted-foreground">{value.why}</span>
          </span>
        )}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
