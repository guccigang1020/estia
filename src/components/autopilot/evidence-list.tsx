/**
 * The facts behind a claim, each with the engine that said so.
 *
 * ── Why this component exists at all ─────────────────────────────────────
 *
 * "Villa A may not be ready" is not a sentence anybody can act on. "המנקה טרם
 * התחיל · ההכנה נמשכת בדרך כלל 105 דקות · ההגעה ב־15:00" is three facts with
 * three sources, and a manager can check each one and disagree with exactly
 * one of them. `types.ts` makes this argument about `Evidence` and the whole
 * Autopilot surface rests on it: a system that asserts things it cannot
 * attribute is a system people stop believing the first time it is wrong.
 *
 * ── It renders what was stored, and computes nothing ─────────────────────
 *
 * `value` arrives already decided by whichever engine owns it — payments,
 * inventory, preparation. This component formats it and does not interpret it.
 * There is no threshold here, no colour that means "bad", and no derived
 * sentence: a booleans's colour would be this file's opinion about a fact it
 * did not measure.
 *
 * `observedAt` is rendered when present and its absence is left silent rather
 * than filled with "now" — the type's own comment says "absent means now,
 * which is rarely honest", and printing the current clock beside a fact
 * nobody timestamped would be that dishonesty made visible.
 *
 * No `'use client'`: values in, markup out.
 */

import type { Evidence } from '@/lib/autopilot/types'

import { formatMoment } from './time'

export type EvidenceListProps = {
  items: readonly Evidence[]
  /** A heading, when the list is not already under one. */
  title?: string
  /** What to say when there is none. The caller owns the sentence. */
  emptyNote?: string
}

/**
 * `true` and `false` are the two values a person cannot read raw.
 *
 * Everything else — a number, a time, a name — is printed as it was stored,
 * because a formatter that rounded or localised a stored fact would be a
 * second opinion about it.
 */
function renderValue(value: Evidence['value']): string {
  if (value === null) return '—'
  if (value === true) return 'כן'
  if (value === false) return 'לא'
  return String(value)
}

export function EvidenceList({ items, title, emptyNote }: EvidenceListProps) {
  if (items.length === 0) {
    return emptyNote === undefined ? null : (
      <p className="text-xs text-muted-foreground">{emptyNote}</p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {title !== undefined && (
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      )}

      <ul className="flex flex-col gap-1.5">
        {items.map((fact, index) => {
          const observed = formatMoment(fact.observedAt ?? null)

          return (
            // The key pairs the stable machine key with the position: two
            // facts of the same kind about two different rows (two units short
            // of towels) legitimately share a `key`, and React would otherwise
            // render one of them.
            <li
              key={`${fact.key}-${index}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
            >
              <span className="text-muted-foreground">{fact.label}</span>
              <span className="font-medium text-foreground">
                {renderValue(fact.value)}
              </span>
              <span className="text-xs text-muted-foreground">
                {/* The source travels with the value, always. */}
                לפי {fact.source}
                {observed !== null && <> · נצפה ב־{observed}</>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
