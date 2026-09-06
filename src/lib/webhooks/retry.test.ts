import { describe, expect, it } from 'vitest'

import {
  FAILURES_BEFORE_DISABLE,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_SECONDS,
  decideAfterAttempt,
  isRetryable,
  isSuccess,
  shouldDisableAfterFailures,
} from './retry'
import type { AttemptOutcome } from './types'

const NOW = new Date('2026-09-06T12:00:00.000Z')
const responded = (statusCode: number): AttemptOutcome => ({
  kind: 'responded',
  statusCode,
})

describe('what counts as delivered', () => {
  it('is any 2xx and nothing else', () => {
    for (const code of [200, 201, 202, 204, 299]) {
      expect(isSuccess(responded(code)), String(code)).toBe(true)
    }
    for (const code of [199, 301, 302, 400, 500]) {
      expect(isSuccess(responded(code)), String(code)).toBe(false)
    }
  })

  it('treats a redirect as a failure rather than following it', () => {
    // Following redirects on a customer-controlled URL is how the SSRF guard
    // gets bypassed: the checked host answers 302 to 169.254.169.254.
    expect(isSuccess(responded(302))).toBe(false)
    expect(isRetryable(responded(302))).toBe(false)
  })
})

describe('could the same request succeed later', () => {
  it('yes for the receiver being down, busy or unreachable', () => {
    expect(isRetryable(responded(500))).toBe(true)
    expect(isRetryable(responded(503))).toBe(true)
    expect(isRetryable(responded(429))).toBe(true)
    expect(isRetryable(responded(408))).toBe(true)
    expect(isRetryable({ kind: 'timed_out' })).toBe(true)
    expect(isRetryable({ kind: 'network_error', detail: 'ECONNRESET' })).toBe(
      true,
    )
  })

  it('no for a request the receiver understood and rejected', () => {
    // Retrying a 404 six times over eight hours does not find the page. It
    // delays telling the customer and buries the real failures in noise.
    for (const code of [400, 401, 403, 404, 422]) {
      expect(isRetryable(responded(code)), String(code)).toBe(false)
    }
  })

  it('no when nothing was sent at all', () => {
    expect(
      isRetryable({ kind: 'unsafe_address', detail: 'resolved to 10.0.0.5' }),
    ).toBe(false)
  })
})

describe('the decision after an attempt', () => {
  it('stops on success', () => {
    expect(decideAfterAttempt(responded(200), 1, NOW)).toEqual({
      kind: 'succeeded',
    })
  })

  it('walks the schedule', () => {
    let clock = NOW
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const decision = decideAfterAttempt(responded(503), attempt, clock)
      expect(decision.kind, `attempt ${attempt}`).toBe('retry')
      if (decision.kind !== 'retry') return
      const expected = RETRY_SCHEDULE_SECONDS[attempt - 1] * 1000
      expect(decision.at.getTime() - clock.getTime()).toBe(expected)
      clock = decision.at
    }
  })

  it('gives up after the last attempt, and not before', () => {
    expect(decideAfterAttempt(responded(503), MAX_ATTEMPTS - 1, NOW).kind).toBe(
      'retry',
    )
    expect(decideAfterAttempt(responded(503), MAX_ATTEMPTS, NOW)).toEqual({
      kind: 'give_up',
      permanent: false,
    })
  })

  it('gives up immediately on a permanent rejection, with attempts left', () => {
    expect(decideAfterAttempt(responded(404), 1, NOW)).toEqual({
      kind: 'give_up',
      permanent: true,
    })
  })

  it('marks the two kinds of giving up apart', () => {
    // "You typed the URL wrong" and "your server was down all morning" are
    // different sentences to show a customer.
    const permanent = decideAfterAttempt(responded(403), 1, NOW)
    const exhausted = decideAfterAttempt(responded(500), MAX_ATTEMPTS, NOW)
    expect(permanent).toEqual({ kind: 'give_up', permanent: true })
    expect(exhausted).toEqual({ kind: 'give_up', permanent: false })
  })

  it('disables the endpoint the moment the receiver answers 410', () => {
    // The only response that is an instruction rather than a symptom, so it
    // outranks how many attempts remain.
    expect(decideAfterAttempt(responded(410), 1, NOW)).toEqual({
      kind: 'disable_endpoint',
    })
    expect(decideAfterAttempt(responded(410), MAX_ATTEMPTS, NOW)).toEqual({
      kind: 'disable_endpoint',
    })
  })

  it('spans a working day, so Friday afternoon is found on Friday', () => {
    const total = RETRY_SCHEDULE_SECONDS.reduce((sum, n) => sum + n, 0)
    expect(total).toBeLessThan(9 * 60 * 60)
    expect(total).toBeGreaterThan(8 * 60 * 60)
  })
})

describe('turning an endpoint off', () => {
  it('needs sustained failure, not a bad morning', () => {
    expect(shouldDisableAfterFailures(FAILURES_BEFORE_DISABLE - 1)).toBe(false)
    expect(shouldDisableAfterFailures(FAILURES_BEFORE_DISABLE)).toBe(true)
  })

  it('counts deliveries and not attempts', () => {
    // An endpoint down for a morning fails ONE delivery six times. That is
    // one failure. If attempts were counted, four bad mornings would disable
    // a perfectly good endpoint.
    expect(MAX_ATTEMPTS).toBeLessThan(FAILURES_BEFORE_DISABLE)
  })
})
