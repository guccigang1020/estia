/**
 * Idempotency.
 *
 * The store's own semantics, tested apart from the pipeline: reserving,
 * replaying, refusing a reused key, releasing a failed attempt, and — the one
 * that is a tenant isolation rule wearing a different hat — keeping two
 * organizations that chose the same key apart.
 */

import { describe, expect, it } from 'vitest'
import {
  InMemoryIdempotencyStore,
  fingerprint,
  stableStringify,
  type IdempotencyScope,
} from './idempotency'

const SCOPE_A: IdempotencyScope = {
  organizationId: 'org-a',
  operation: 'payment.create',
}
const SCOPE_B: IdempotencyScope = {
  organizationId: 'org-b',
  operation: 'payment.create',
}

describe('reserving and replaying', () => {
  it('reserves a key nobody holds', async () => {
    const store = new InMemoryIdempotencyStore()
    expect(await store.begin(SCOPE_A, 'k-1', 'fp')).toEqual({
      status: 'reserved',
    })
  })

  it('reports a second attempt as in flight until the first finishes', async () => {
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'k-1', 'fp')

    const second = await store.begin(SCOPE_A, 'k-1', 'fp')
    expect(second.status).toBe('in_flight')
  })

  it('replays the original result once the first attempt completed', async () => {
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'k-1', 'fp')
    await store.complete(SCOPE_A, 'k-1', { paymentId: 'pay-1', amount: 470000 })

    const replay = await store.begin(SCOPE_A, 'k-1', 'fp')
    expect(replay.status).toBe('replayed')
    expect(replay.status === 'replayed' && replay.record.result).toEqual({
      paymentId: 'pay-1',
      amount: 470000,
    })
  })

  it('refuses a key reused for a different request', async () => {
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'k-1', fingerprint({ amount: 470000 }))
    await store.complete(SCOPE_A, 'k-1', { paymentId: 'pay-1' })

    const reused = await store.begin(
      SCOPE_A,
      'k-1',
      fingerprint({ amount: 99 }),
    )
    expect(reused.status).toBe('mismatch')
  })

  it('releases a reservation whose operation failed', async () => {
    // Without this a transient failure poisons the key: the retry the user is
    // explicitly told to make would come back "still in flight" forever.
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'k-1', 'fp')
    await store.abandon(SCOPE_A, 'k-1')

    expect(await store.begin(SCOPE_A, 'k-1', 'fp')).toEqual({
      status: 'reserved',
    })
    expect(store.size).toBe(1)
  })
})

describe('scoping', () => {
  it('keeps two organizations that chose the same key apart', async () => {
    // Keys are usually chosen by a client. Two customers picking "retry-1"
    // must not be able to read each other's results.
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'retry-1', 'fp')
    await store.complete(SCOPE_A, 'retry-1', { paymentId: 'pay-a' })

    expect(await store.begin(SCOPE_B, 'retry-1', 'fp')).toEqual({
      status: 'reserved',
    })
  })

  it("keeps one operation's key from replaying another's", async () => {
    const store = new InMemoryIdempotencyStore()
    await store.begin(SCOPE_A, 'k-1', 'fp')
    await store.complete(SCOPE_A, 'k-1', { paymentId: 'pay-a' })

    const otherOperation = {
      organizationId: 'org-a',
      operation: 'payment.refund',
    }
    expect(await store.begin(otherOperation, 'k-1', 'fp')).toEqual({
      status: 'reserved',
    })
  })
})

describe('fingerprinting', () => {
  it('is insensitive to key order, so two clients agree on the same request', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(
      stableStringify({ b: 2, a: 1 }),
    )
    expect(fingerprint({ amount: 1, note: 'x' })).toBe(
      fingerprint({ note: 'x', amount: 1 }),
    )
  })

  it('is sensitive to the values, which is the whole point', () => {
    expect(fingerprint({ amount: 470000 })).not.toBe(
      fingerprint({ amount: 470001 }),
    )
    expect(fingerprint({ amount: 470000 })).not.toBe(
      fingerprint({ amount: '470000' }),
    )
  })

  it('distinguishes nesting and array order', () => {
    expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }))
    expect(fingerprint({ a: { b: 1 } })).not.toBe(fingerprint({ a: 1, b: 1 }))
  })

  it('treats an absent key and an undefined one as the same request', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }))
  })

  it('serialises dates by instant rather than by object identity', () => {
    expect(stableStringify(new Date('2026-03-14T09:30:00Z'))).toBe(
      '"2026-03-14T09:30:00.000Z"',
    )
  })

  it('produces a fixed-width hex digest and keeps the request out of it', () => {
    const digest = fingerprint({ passportNumber: '12345678', name: 'רוני לוי' })
    expect(digest).toMatch(/^[0-9a-f]{16}$/)
    expect(digest).not.toContain('12345678')
  })
})
