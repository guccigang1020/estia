import { describe, expect, it } from 'vitest'

import { morningShape } from './shape'
import type { Settled, TodayCounts } from './home'

const failed = <T>(): Settled<T> => ({
  ok: false,
  error: {
    code: 'read_failed',
    message: 'x',
    dataMessage: 'x',
    retryMessage: 'x',
    dataOutcome: 'unknown',
    retryable: true,
    correlationId: 'c',
  } as Settled<T> extends { ok: false; error: infer E } ? E : never,
})

const counts = (over: Partial<TodayCounts> = {}): TodayCounts => ({
  arriving: 4,
  departing: 3,
  in_house: 7,
  ...over,
})

const home = (over: Partial<Parameters<typeof morningShape>[0]> = {}) => ({
  stays: { ok: true as const, value: counts() },
  balances: { ok: true as const, value: { count: 2, totalAgorot: 186_000 } },
  stuckTasks: { ok: true as const, value: 1 },
  approvals: { ok: true as const, value: 0 },
  ...over,
})

describe('a read that failed is never a zero', () => {
  it('reports the arrivals as unknown, not as none', () => {
    // The most expensive lie this product could tell: somebody reads
    // "0 arrivals today" on a morning with four, decides the day is quiet,
    // and goes out.
    const [arrivals] = morningShape(home({ stays: failed<TodayCounts>() }))
    expect(arrivals?.count).toBeNull()
    expect(arrivals?.why).toContain('אינו אפס')
  })

  it('does the same for money', () => {
    const shape = morningShape(
      home({
        balances: failed<{ count: number; totalAgorot: number } | null>(),
      }),
    )
    const balances = shape.find((f) => f.label === 'יתרות לגבייה')
    expect(balances?.count).toBeNull()
    expect(balances?.why).toContain('אינו אפס')
  })
})

describe('a module this deployment does not have is its own answer', () => {
  it('says so rather than reporting a failed read', () => {
    // The query ran and the product cannot answer. One is worth chasing and
    // the other is worth ignoring, so they do not share a sentence.
    const shape = morningShape(home({ balances: { ok: true, value: null } }))
    const balances = shape.find((f) => f.label === 'יתרות לגבייה')
    expect(balances?.count).toBeNull()
    expect(balances?.why).toBe('אין מודול תשלומים בהיקף הזה')
    expect(balances?.why).not.toContain('נכשלה')
  })

  it('and for operations', () => {
    const shape = morningShape(home({ stuckTasks: { ok: true, value: null } }))
    const stuck = shape.find((f) => f.label === 'משימות תקועות')
    expect(stuck?.why).toBe('אין מודול תפעול בהיקף הזה')
  })
})

describe('a genuine zero is a number', () => {
  it('reports no arrivals as zero, with no explanation attached', () => {
    const [arrivals] = morningShape(
      home({ stays: { ok: true, value: counts({ arriving: 0 }) } }),
    )
    expect(arrivals?.count).toBe(0)
    expect(arrivals?.why).toBeNull()
  })

  it('says the work is moving when nothing is stuck', () => {
    const shape = morningShape(home({ stuckTasks: { ok: true, value: 0 } }))
    expect(shape.find((f) => f.label === 'משימות תקועות')?.detail).toBe(
      'הכול זז',
    )
  })
})

describe('what the four tiles are', () => {
  it('is arrivals, departures, money and stuck work, in that order', () => {
    // Order is the morning's order: who is coming, who is going, what is
    // owed, what is not moving.
    expect(morningShape(home()).map((f) => f.label)).toEqual([
      'הגעות היום',
      'יציאות היום',
      'יתרות לגבייה',
      'משימות תקועות',
    ])
  })

  it('shows the outstanding total in shekels beside the count', () => {
    const shape = morningShape(home())
    expect(shape.find((f) => f.label === 'יתרות לגבייה')?.detail).toContain(
      '1,860',
    )
  })
})
