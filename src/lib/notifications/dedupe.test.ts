import { describe, expect, it } from 'vitest'

import { notificationDedupeKey } from './dedupe'
import { event } from './testing'

describe('the dedupe key', () => {
  it('is identical for the same logical event delivered twice', () => {
    // A webhook delivered three times is one event. The correlation id and the
    // wall clock differ between deliveries and the idempotency key does not,
    // which is exactly why the key is built from the latter.
    const first = event('payment.failed', {
      correlationId: 'request-a',
      occurredAt: new Date('2026-03-11T10:00:00.000Z'),
      idempotencyKey: 'stripe-evt-77',
    })
    const second = event('payment.failed', {
      correlationId: 'request-b',
      occurredAt: new Date('2026-03-11T10:04:00.000Z'),
      idempotencyKey: 'stripe-evt-77',
    })

    expect(notificationDedupeKey({ event: first, recipientUserId: 'u1' })).toBe(
      notificationDedupeKey({ event: second, recipientUserId: 'u1' }),
    )
  })

  it('differs per recipient, so four people are not collapsed into one', () => {
    const raised = event('payment.failed')

    const a = notificationDedupeKey({ event: raised, recipientUserId: 'u1' })
    const b = notificationDedupeKey({ event: raised, recipientUserId: 'u2' })

    expect(a).not.toBe(b)
  })

  it('differs per escalation level, so a raise is not swallowed as a retry', () => {
    const raised = event('payment.outcome_unknown')

    const level0 = notificationDedupeKey({
      event: raised,
      recipientUserId: 'u1',
    })
    const level1 = notificationDedupeKey({
      event: raised,
      recipientUserId: 'u1',
      escalationLevel: 1,
    })
    const level2 = notificationDedupeKey({
      event: raised,
      recipientUserId: 'u1',
      escalationLevel: 2,
    })

    expect(new Set([level0, level1, level2]).size).toBe(3)
  })

  it('differs between two events that share nothing but a recipient', () => {
    const a = notificationDedupeKey({
      event: event('payment.failed', { idempotencyKey: 'k1' }),
      recipientUserId: 'u1',
    })
    const b = notificationDedupeKey({
      event: event('task.overdue', { idempotencyKey: 'k2' }),
      recipientUserId: 'u1',
    })

    expect(a).not.toBe(b)
  })

  it('stays unique when a pathological resource id forces the short form', () => {
    const long = 'x'.repeat(600)

    const a = notificationDedupeKey({
      event: event('task.overdue', { resourceId: long, idempotencyKey: 'k1' }),
      recipientUserId: 'u1',
    })
    const b = notificationDedupeKey({
      event: event('task.overdue', { resourceId: long, idempotencyKey: 'k2' }),
      recipientUserId: 'u1',
    })

    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(400)
  })

  it('is readable, because somebody will one day have to read it', () => {
    const key = notificationDedupeKey({
      event: event('payment.failed', {
        resourceType: 'payment',
        resourceId: 'pay-9',
        idempotencyKey: 'k1',
      }),
      recipientUserId: 'u1',
    })

    expect(key).toContain('payment.failed')
    expect(key).toContain('payment:pay-9')
    expect(key).toContain('u:u1')
  })
})
