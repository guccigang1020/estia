/**
 * Error copy.
 *
 * These tests are the enforcement of a charter rule that is otherwise only a
 * good intention: a failure message must say what failed, whether the data was
 * saved, and whether retrying is safe. The assertions below make it impossible
 * to add a failure class that answers fewer than three of those questions.
 */

import { describe, expect, it } from 'vitest'

import { DATA_OUTCOME_MESSAGE, RETRY_MESSAGE } from '@/lib/errors'

import {
  describeError,
  errorKindFromStatus,
  fromSafeError,
  technicalDetail,
  type ErrorKind,
} from './error-copy'

const ALL_KINDS: ErrorKind[] = [
  'network',
  'timeout',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation',
  'quota',
  'rate_limited',
  'server',
  'unknown',
]

describe('describeError — every failure answers all three questions', () => {
  it.each(ALL_KINDS)(
    '%s states what failed, what was saved, and whether to retry',
    (kind) => {
      const presentation = describeError({ kind })

      expect(presentation.title.length).toBeGreaterThan(0)
      expect(presentation.description.length).toBeGreaterThan(0)
      expect(presentation.dataOutcomeText.length).toBeGreaterThan(0)
      expect(presentation.retryText.length).toBeGreaterThan(0)
      expect(presentation.retryLabel.length).toBeGreaterThan(0)
    },
  )

  it.each(ALL_KINDS)(
    "%s never falls back to a bare 'something went wrong'",
    (kind) => {
      const { title, description } = describeError({ kind })

      expect(title).not.toContain('משהו השתבש')
      expect(description).not.toContain('משהו השתבש')
    },
  )

  it('names the operation the user was attempting when it is known', () => {
    const presentation = describeError({
      kind: 'network',
      operation: 'לשמור את ההזמנה',
    })

    expect(presentation.description).toContain('לשמור את ההזמנה')
  })

  it('still answers all three questions when the operation is unknown', () => {
    const presentation = describeError()

    expect(presentation.kind).toBe('unknown')
    expect(presentation.dataOutcome).toBe('unknown')
    // The honest admission is required: silence about saved data is the bug.
    expect(presentation.dataOutcomeText).toContain('לא ידוע אם הנתונים נשמרו')
  })
})

describe('describeError — data outcome', () => {
  it('defaults a network failure to nothing-was-saved', () => {
    expect(describeError({ kind: 'network' }).dataOutcome).toBe('not_saved')
  })

  it('defaults a timeout to unknown, because the server may have finished', () => {
    expect(describeError({ kind: 'timeout' }).dataOutcome).toBe('unknown')
  })

  it('lets a caller that genuinely knows override the default', () => {
    const presentation = describeError({ kind: 'server', dataOutcome: 'saved' })

    expect(presentation.dataOutcome).toBe('saved')
    expect(presentation.dataOutcomeText).toContain('כן נשמרו')
  })

  it('warns about duplication when only part of the work landed', () => {
    expect(describeError({ dataOutcome: 'partial' }).dataOutcomeText).toContain(
      'כפילות',
    )
  })
})

describe('describeError — retry safety', () => {
  it('offers a safe retry when nothing left the device', () => {
    const presentation = describeError({ kind: 'network' })

    expect(presentation.retry).toBe('safe')
    expect(presentation.canRetry).toBe(true)
    expect(presentation.retryText).toContain('בטוח')
  })

  it('warns before a retry that could duplicate a business effect', () => {
    const presentation = describeError({ kind: 'timeout' })

    expect(presentation.retry).toBe('unsafe')
    expect(presentation.canRetry).toBe(true)
    expect(presentation.retryText).toContain('כפילות')
  })

  it.each([
    'forbidden',
    'validation',
    'conflict',
    'quota',
    'unauthorized',
  ] as const)(
    'does not offer a retry for %s, because retrying cannot succeed',
    (kind) => {
      const presentation = describeError({ kind })

      expect(presentation.retry).toBe('will_not_help')
      expect(presentation.canRetry).toBe(false)
    },
  )

  it('gives a conflict the action that actually helps', () => {
    expect(describeError({ kind: 'conflict' }).retryLabel).toBe('טען מחדש')
  })

  it('lets a caller downgrade a safe retry it knows is not safe', () => {
    const presentation = describeError({ kind: 'network', retry: 'unsafe' })

    expect(presentation.canRetry).toBe(true)
    expect(presentation.retryText).toContain('כפילות')
  })
})

describe('errorKindFromStatus', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [408, 'timeout'],
    [500, 'server'],
    [503, 'server'],
    [402, 'quota'],
  ] as const)('maps %i to %s', (status, kind) => {
    expect(errorKindFromStatus(status)).toBe(kind)
  })

  it('refuses to guess at an unrecognised status', () => {
    expect(errorKindFromStatus(418)).toBe('unknown')
  })
})

describe("fromSafeError — the server's wording wins", () => {
  const body = {
    code: 'version_conflict',
    message: 'הרשומה השתנתה מאז שפתחת אותה.',
    dataOutcome: 'not_saved',
    dataMessage: DATA_OUTCOME_MESSAGE.not_saved,
    retryable: false,
    retryMessage: RETRY_MESSAGE.false,
    correlationId: 'corr-9f2',
  } as const

  it("adopts the domain layer's three sentences verbatim", () => {
    const presentation = fromSafeError(body)

    // Not re-derived here: if `src/lib/errors` rewords a sentence, the screen
    // changes with it and the two can never drift.
    expect(presentation.description).toBe(body.message)
    expect(presentation.dataOutcomeText).toBe(DATA_OUTCOME_MESSAGE.not_saved)
    expect(presentation.retryText).toBe(RETRY_MESSAGE.false)
  })

  it('adds only what a server has no opinion about', () => {
    const presentation = fromSafeError(body)

    expect(presentation.kind).toBe('conflict')
    expect(presentation.title).toBe('מישהו אחר עדכן את הרשומה לפניך')
    expect(presentation.retryLabel).toBe('טען מחדש')
  })

  it('carries the correlation id through as the support reference', () => {
    expect(fromSafeError(body).reference).toBe('corr-9f2')
  })

  it('maps `retryable` onto whether a retry is offered at all', () => {
    expect(fromSafeError(body).canRetry).toBe(false)
    expect(
      fromSafeError({
        ...body,
        retryable: true,
        retryMessage: RETRY_MESSAGE.true,
      }).canRetry,
    ).toBe(true)
  })

  it.each([
    ['validation_failed', 'validation'],
    ['not_found', 'not_found'],
    ['quota_exceeded', 'quota'],
    ['missing_permission', 'forbidden'],
    ['out_of_scope', 'forbidden'],
    ['plan_does_not_include', 'quota'],
    ['internal_error', 'server'],
    ['idempotency_conflict', 'conflict'],
  ] as const)('maps the stable code %s to %s', (code, kind) => {
    expect(fromSafeError({ ...body, code }).kind).toBe(kind)
  })

  it('falls back honestly on a code this layer has never seen', () => {
    const presentation = fromSafeError({ ...body, code: 'some_future_code' })

    expect(presentation.kind).toBe('unknown')
    // The server's own sentence still reaches the user, so a new code degrades
    // to a missing headline rather than to a missing explanation.
    expect(presentation.description).toBe(body.message)
  })
})

describe('technicalDetail — a stack trace never reaches a user', () => {
  it('keeps the message and drops every stack frame', () => {
    const error = new Error('Failed to insert booking')
    error.stack = [
      'Error: Failed to insert booking',
      '    at createBooking (/app/src/lib/bookings.ts:41:11)',
      '    at async POST (/app/src/app/api/bookings/route.ts:12:3)',
    ].join('\n')

    const detail = technicalDetail(error, 'd1f4c2')

    expect(detail).toContain('Failed to insert booking')
    expect(detail).not.toContain('at createBooking')
    expect(detail).not.toContain('.ts:')
  })

  it('strips frames that were appended into the message itself', () => {
    const error = new Error(
      'Timeout after 30s\n    at fetchWithRetry (/app/src/lib/http.ts:88:9)',
    )

    const detail = technicalDetail(error)

    expect(detail).toBe('Timeout after 30s')
  })

  it('carries the reference a support conversation needs', () => {
    expect(technicalDetail(new Error('boom'), 'abc123')).toContain(
      'מזהה תקלה: abc123',
    )
  })

  it('truncates a message long enough to be a dump', () => {
    const detail = technicalDetail(new Error('x'.repeat(1000)))

    expect(detail).toBeDefined()
    expect(detail!.length).toBeLessThan(320)
  })

  it('returns nothing rather than an empty block when there is nothing to show', () => {
    expect(technicalDetail(undefined)).toBeUndefined()
    expect(technicalDetail(new Error(''))).toBeUndefined()
  })

  it('reads a message off a plain object thrown by a third party', () => {
    expect(technicalDetail({ message: 'PGRST116' })).toContain('PGRST116')
  })
})
