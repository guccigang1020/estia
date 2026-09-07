import { describe, expect, it } from 'vitest'

import { circumference, fractionOf, openArc, pointOnRing, ring } from './gauge'

const R = 50
const C = 2 * Math.PI * R

describe('a full ring', () => {
  it('hides the whole circle at zero', () => {
    expect(ring(R, 0)).toEqual({ dashArray: C, dashOffset: C })
  })

  it('hides none of it at one', () => {
    expect(ring(R, 1)).toEqual({ dashArray: C, dashOffset: 0 })
  })

  it('hides half of it at a half', () => {
    const arc = ring(R, 0.5)
    expect(arc.dashOffset).toBeCloseTo(C / 2, 6)
  })

  it('never produces a negative offset, whatever it is handed', () => {
    // A negative offset renders as a COMPLETE ring in every browser. A gauge
    // handed 1.4 by an unguarded division would draw 140% occupancy as a tidy
    // full circle instead of as the impossible number it is.
    expect(ring(R, 1.4).dashOffset).toBe(0)
    expect(ring(R, 99).dashOffset).toBe(0)
  })

  it('clamps a negative fraction to empty rather than overdrawing', () => {
    expect(ring(R, -0.3).dashOffset).toBe(C)
  })

  it('treats NaN as empty, because empty is questioned and full is believed', () => {
    expect(ring(R, Number.NaN).dashOffset).toBe(C)
    expect(ring(R, Number.POSITIVE_INFINITY).dashOffset).toBe(C)
  })
})

describe('an open arc, the speedometer shape', () => {
  it('leaves the gap when the value is full', () => {
    // The whole trap: at 100% the value must reach the end of the VISIBLE
    // track, not wrap into the gap.
    const { track, value } = openArc(R, 1, 0.75)
    expect(value.dashOffset).toBeCloseTo(track.dashOffset, 6)
  })

  it('fills nothing at zero while the track stays drawn', () => {
    const { track, value } = openArc(R, 0, 0.75)
    expect(value.dashOffset).toBeCloseTo(C, 6)
    expect(track.dashOffset).toBeCloseTo(C * 0.25, 6)
  })

  it('fills half the track at a half, not half the circle', () => {
    const { value } = openArc(R, 0.5, 0.75)
    // Half of three quarters is three eighths.
    expect(value.dashOffset).toBeCloseTo(C * (1 - 0.375), 6)
  })

  it('clamps both the sweep and the value', () => {
    const { track, value } = openArc(R, 5, 5)
    expect(track.dashOffset).toBe(0)
    expect(value.dashOffset).toBe(0)
  })
})

describe('where a handle sits', () => {
  it('starts at twelve o clock, which is how a dial is described out loud', () => {
    const point = pointOnRing(R, 0)
    expect(point.x).toBeCloseTo(0, 6)
    expect(point.y).toBeCloseTo(-R, 6)
  })

  it('runs clockwise', () => {
    // A quarter turn clockwise from the top is three o'clock: +x, y at zero.
    const point = pointOnRing(R, 0.25)
    expect(point.x).toBeCloseTo(R, 6)
    expect(point.y).toBeCloseTo(0, 6)
  })

  it('reaches six o clock at a half', () => {
    const point = pointOnRing(R, 0.5)
    expect(point.y).toBeCloseTo(R, 6)
  })

  it('stays on the ring for any input', () => {
    for (const f of [-1, 0, 0.3, 1, 4, Number.NaN]) {
      const { x, y } = pointOnRing(R, f)
      expect(Math.hypot(x, y)).toBeCloseTo(R, 6)
    }
  })
})

describe('a fraction whose denominator may not exist', () => {
  it('is null when nothing counted the denominator', () => {
    // Zero and unknown are opposite facts about a business. A dial that
    // cannot tell them apart draws an empty ring for both.
    expect(fractionOf(10, null)).toBeNull()
  })

  it('is null rather than infinite when the denominator is zero', () => {
    expect(fractionOf(10, 0)).toBeNull()
  })

  it('divides when it genuinely can', () => {
    expect(fractionOf(10, 40)).toBe(0.25)
  })

  it('is null when the numerator is not a number', () => {
    expect(fractionOf(Number.NaN, 40)).toBeNull()
  })
})

describe('circumference', () => {
  it('is the one the stroke is drawn against', () => {
    expect(circumference(50)).toBeCloseTo(314.159, 3)
  })
})
