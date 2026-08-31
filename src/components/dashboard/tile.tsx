/**
 * One tile, and the bands they sit in.
 *
 * Everything here is presentation over tokens that already exist. No new
 * colour, no new spacing scale, no dependency: a tile is a `Card` with a
 * heading, one number, one line of Hebrew and — when the reader may open it —
 * a link wrapped around the whole thing.
 *
 * ── One number, and it is the largest thing in the box ────────────────────
 *
 * The rule taken from the systems worth taking from is that a tile answers one
 * question. A box carrying a count, a percentage and a currency total is three
 * questions typeset as one, and a reader scanning nine of them at eight in the
 * morning answers none. So `value` is a single string, `note` is one sentence
 * under it, and there is no slot for a second figure.
 *
 * ── The whole card is the target ──────────────────────────────────────────
 *
 * A housekeeper reads this on a phone, one-handed, in a corridor. The link
 * therefore wraps the card rather than sitting inside it as a small "צפייה"
 * control, which makes the target the size of the tile. The card is at least
 * `min-h-36` for the same reason, and the grid never exceeds two columns until
 * `sm` so nothing is squeezed at 375px.
 *
 * ── An empty tile still says something ────────────────────────────────────
 *
 * `note` is where "אין הגעות היום" goes. A zero on its own is ambiguous
 * between "nothing to do" and "this did not load", and the second reading is
 * the one an operator assumes at the worst moment. The caller passes the
 * sentence; this component only refuses to render a blank space.
 *
 * No `"use client"`: nothing here holds state.
 */

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'

import type { ResolvedTile } from './tiles'

/* ---------------------------------------------------------------- tone -- */

/**
 * How loud the tile is, decided by meaning and never by the sign of a number.
 *
 * `attention` is for a figure somebody has to act on today — unpaid stays,
 * stalled payments, blocked work. `quiet` is for a figure that is merely true.
 * There is no "good news green": `src/lib/metrics` already decides sentiment
 * per metric, and a second opinion here would contradict it.
 */
export type TileTone = 'quiet' | 'attention'

const VALUE_TONE: Record<TileTone, string> = {
  quiet: 'text-foreground',
  attention: 'text-danger',
}

/* ---------------------------------------------------------------- tile -- */

export type TileCardProps = {
  tile: ResolvedTile
  /** The one figure, already formatted by the domain. Never computed here. */
  value: string
  /** One Hebrew sentence under the figure. Carries the empty state. */
  note?: string
  /** The comparison, in the domain's own words. Optional and never coloured. */
  comparison?: string
  /**
   * The one word that says what the colour is saying.
   *
   * A red figure is invisible to a colour-blind reader and meaningless in a
   * black-and-white printout, so a tile the domain called `warning` or
   * `critical` carries the word as well as the hue. `metric-tile.tsx` makes
   * the same argument for the report screen; this is the same rule on the home
   * screen rather than a second opinion about it.
   */
  flag?: string
  tone?: TileTone
  /** The completed destination, or null when there is nowhere honest to go. */
  href: string | null
}

export function TileCard({
  tile,
  value,
  note,
  comparison,
  flag,
  tone = 'quiet',
  href,
}: TileCardProps) {
  const body = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">
          {tile.title}
        </h3>
        {flag ? (
          <Badge tone="neutral" className="shrink-0 text-danger">
            {flag}
          </Badge>
        ) : null}
      </div>

      <p
        className={cn(
          'mt-3 font-display text-3xl font-bold tabular-nums sm:text-4xl',
          VALUE_TONE[tone],
        )}
      >
        {value}
      </p>

      {comparison ? (
        <p className="mt-1 text-xs text-muted-foreground">{comparison}</p>
      ) : null}

      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {note ?? tile.meaning}
      </p>

      {href !== null && tile.destination !== null ? (
        <p className="mt-4 text-sm font-semibold text-primary">
          {tile.destination.label} ←
        </p>
      ) : null}
    </>
  )

  const shell =
    'flex min-h-36 flex-col rounded-xl border border-border bg-surface p-5 shadow-soft'

  if (href === null) return <div className={shell}>{body}</div>

  return (
    <a
      href={href}
      className={cn(
        shell,
        'transition-colors duration-150 hover:border-border-strong hover:bg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      {body}
    </a>
  )
}

/* -------------------------------------------------------------- locked -- */

/**
 * A capability the reader holds and the organization has not bought.
 *
 * Kept on screen rather than hidden, for the reason `menu.ts` gives at length:
 * hiding it makes the product look smaller than it is and leaves the person
 * unable to tell "I am not allowed" from "we did not pay for this". It carries
 * no figure, because there is none — the package refusal happens before any
 * row is read.
 */
export function LockedTile({
  tile,
  entitlementLabel,
}: {
  tile: ResolvedTile
  entitlementLabel: string | null
}) {
  return (
    <div className="flex min-h-36 flex-col rounded-xl border border-dashed border-border bg-muted/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">
          {tile.title}
        </h3>
        <Badge tone="neutral">לא בחבילה</Badge>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {entitlementLabel
          ? `היכולת ״${entitlementLabel}״ אינה כלולה בחבילה של הארגון. ההרשאה עצמה קיימת לך — שדרוג יפתח את המספר הזה.`
          : 'היכולת הזו אינה כלולה בחבילה של הארגון. ההרשאה עצמה קיימת לך — שדרוג יפתח את המספר הזה.'}
      </p>
    </div>
  )
}

/* --------------------------------------------------------------- bands -- */

export type TileBandProps = {
  title: string
  /** One sentence saying what this band of the screen answers. */
  lead: string
  /** The one control the band offers, if any. */
  action?: ReactNode
  children: ReactNode
}

/**
 * A band of the home screen.
 *
 * Two columns at 375px would put a four-digit currency figure into a 150px
 * box, so the grid stays single-column until `sm` and grows from there. The
 * page body therefore never scrolls sideways on a phone, which is the one
 * layout failure a person in a corridor cannot work around.
 */
export function TileBandSection({
  title,
  lead,
  action,
  children,
}: TileBandProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-bold tracking-tight text-foreground sm:text-xl">
            {title}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">{lead}</p>
        </div>
        {action}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  )
}
