/**
 * The arithmetic behind a dial, kept out of the component so it can be tested.
 *
 * An SVG arc is drawn with `stroke-dasharray` and `stroke-dashoffset`, and
 * getting those two backwards produces a gauge that is confidently wrong — it
 * renders, it animates, and it shows 30% for 70%. That is exactly the kind of
 * mistake a screenshot review does not catch, which is why the numbers live
 * here with tests rather than inline in JSX.
 */

/** Circumference of the stroked circle. The radius is the drawn one. */
export function circumference(radius: number): number {
  return 2 * Math.PI * radius
}

export type Arc = {
  /** `stroke-dasharray` — the full circumference. */
  readonly dashArray: number
  /** `stroke-dashoffset` — how much of it to hide. */
  readonly dashOffset: number
}

/**
 * A ring that fills clockwise from the top for `fraction` of its circle.
 *
 * `fraction` is clamped rather than trusted. A gauge handed 1.4 by a division
 * nobody guarded would otherwise draw a NEGATIVE offset, which browsers render
 * as a complete ring — reporting 140% occupancy as a tidy full circle instead
 * of as the impossible number it is.
 *
 * NaN clamps to 0 for the same reason: a dial showing nothing is a dial
 * somebody questions, and one showing a full circle is one they believe.
 */
export function ring(radius: number, fraction: number): Arc {
  const total = circumference(radius)
  const safe = Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction))
    : 0
  return { dashArray: total, dashOffset: total * (1 - safe) }
}

/**
 * A gauge that is not a full circle — an open arc with a gap at the bottom,
 * like a speedometer.
 *
 * `sweep` is the fraction of the FULL circle the track occupies (0.75 leaves a
 * quarter-circle gap). The value fills `fraction` of that track, so a dial at
 * 100% reaches the end of the visible arc rather than wrapping into the gap.
 * Getting that wrong is how a "full" gauge ends up looking three-quarters
 * done.
 */
export function openArc(
  radius: number,
  fraction: number,
  sweep: number,
): { readonly track: Arc; readonly value: Arc } {
  const total = circumference(radius)
  const safeSweep = Math.min(1, Math.max(0, sweep))
  const safe = Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction))
    : 0

  return {
    track: { dashArray: total, dashOffset: total * (1 - safeSweep) },
    value: { dashArray: total, dashOffset: total * (1 - safeSweep * safe) },
  }
}

/**
 * Where a handle sits on the ring, in SVG user units relative to the centre.
 *
 * Angles start at twelve o'clock and run clockwise, which is how somebody
 * describes a dial out loud — the `-90` here is the whole reason the caller
 * does not have to think about it.
 */
export function pointOnRing(
  radius: number,
  fraction: number,
): { readonly x: number; readonly y: number } {
  const safe = Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction))
    : 0
  const radians = (safe * 360 - 90) * (Math.PI / 180)
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius }
}

/**
 * A percentage as a fraction, when the denominator may be zero or unknown.
 *
 * Returns null rather than NaN or 0. Zero and unknown are opposite facts —
 * `revenue/metrics.ts` makes the same distinction for the same reason — and a
 * dial that cannot tell them apart shows an empty ring for both.
 */
export function fractionOf(part: number, whole: number | null): number | null {
  if (whole === null || !Number.isFinite(whole) || whole <= 0) return null
  if (!Number.isFinite(part)) return null
  return part / whole
}
