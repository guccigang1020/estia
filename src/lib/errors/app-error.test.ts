/**
 * The error taxonomy.
 *
 * These tests are about the three questions a failure has to answer — what
 * failed, was my data saved, is it safe to retry — and about the one thing
 * that must never change underneath the interface: the machine code.
 */

import { describe, expect, it } from 'vitest'
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ExternalServiceError,
  IdempotencyConflictError,
  InternalError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
  isAppError,
  toAppError,
  withCorrelation,
} from './app-error'
import { checkQuota } from '../plans/quota'

describe('AppError', () => {
  it('carries a stable code, a status, a Hebrew message and a technical one', () => {
    const error = new AppError({
      code: 'example',
      status: 418,
      message: 'Technical detail for the log',
      userMessage: 'משהו לא עבד.',
    })

    expect(error.code).toBe('example')
    expect(error.status).toBe(418)
    expect(error.message).toBe('Technical detail for the log')
    expect(error.userMessage).toBe('משהו לא עבד.')
    expect(error).toBeInstanceOf(Error)
  })

  it('defaults to not-saved and not-retryable, the safe reading', () => {
    const error = new AppError({
      code: 'example',
      status: 400,
      message: 'x',
      userMessage: 'x',
    })
    expect(error.dataOutcome).toBe('not_saved')
    expect(error.retryable).toBe(false)
  })

  it('names itself after its subclass', () => {
    expect(new NotFoundError('booking').name).toBe('NotFoundError')
    expect(new ValidationError([]).name).toBe('ValidationError')
  })

  it('recognises its own kind and nothing else', () => {
    expect(isAppError(new NotFoundError('booking'))).toBe(true)
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('a string')).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})

describe('ValidationError', () => {
  it('keeps every offending field, not only the first', () => {
    const error = new ValidationError([
      {
        field: 'guest.email',
        code: 'pattern',
        message: 'כתובת דוא"ל אינה תקינה.',
      },
      {
        field: 'nights',
        code: 'too_small',
        message: 'יש לבחור לפחות לילה אחד.',
      },
      { field: 'total', code: 'required', message: 'שדה חובה.' },
    ])

    expect(error.issues).toHaveLength(3)
    expect(error.issues.map((i) => i.field)).toEqual([
      'guest.email',
      'nights',
      'total',
    ])
    expect(error.status).toBe(422)
    expect(error.dataOutcome).toBe('not_saved')
  })

  it('is not retryable: resending the same bad input fails identically', () => {
    const error = new ValidationError([
      { field: 'total', code: 'required', message: 'שדה חובה.' },
    ])
    expect(error.retryable).toBe(false)
  })

  it('counts the fields in the Hebrew summary', () => {
    const one = new ValidationError([
      { field: 'a', code: 'required', message: 'שדה חובה.' },
    ])
    const many = new ValidationError([
      { field: 'a', code: 'required', message: 'שדה חובה.' },
      { field: 'b', code: 'required', message: 'שדה חובה.' },
    ])
    expect(one.userMessage).toContain('שדה אחד')
    expect(many.userMessage).toContain('2 שדות')
  })
})

describe('NotFoundError', () => {
  it('keeps the id in the technical message and out of the public detail', () => {
    const error = new NotFoundError('booking', 'bk-88f1')

    expect(error.message).toContain('bk-88f1')
    expect(error.publicDetails).toEqual({ resourceType: 'booking' })
    expect(JSON.stringify(error.publicDetails)).not.toContain('bk-88f1')
  })
})

describe('ConflictError', () => {
  it('reports both versions and refuses to be retryable', () => {
    const error = new ConflictError({
      resourceType: 'booking',
      resourceId: 'bk-1',
      expectedVersion: 3,
      actualVersion: 5,
    })

    expect(error.code).toBe('version_conflict')
    expect(error.status).toBe(409)
    expect(error.expectedVersion).toBe(3)
    expect(error.actualVersion).toBe(5)
    // An automatic retry here would resend the stale form and erase the other
    // person's change. That is the lost update `version` exists to prevent.
    expect(error.retryable).toBe(false)
    expect(error.dataOutcome).toBe('not_saved')
  })

  it('tells the user in Hebrew that their change was not saved', () => {
    const error = new ConflictError({ resourceType: 'booking' })
    expect(error.userMessage).toContain('משתמש אחר')
  })
})

describe('QuotaExceededError', () => {
  it('carries the quota state and offers the upgrade', () => {
    const state = checkQuota('members', 11, {
      properties: 5,
      units: 15,
      members: 10,
      storageGb: 50,
    })
    const error = new QuotaExceededError({ quota: state })

    expect(error.status).toBe(402)
    expect(error.quota.current).toBe(11)
    expect(error.quota.limit).toBe(10)
    expect(error.publicDetails.upgradeAvailable).toBe(true)
    expect(error.upgradeSuggestion).toContain('שדרג')
    expect(error.userMessage).toContain('משתמשים')
  })
})

describe('ExternalServiceError', () => {
  it('defaults to retryable with an unknown data outcome', () => {
    const error = new ExternalServiceError({ service: 'tranzila' })

    // A processor that timed out has either charged the card or not, and the
    // server cannot tell. Claiming "not saved" is how a customer pays twice.
    expect(error.dataOutcome).toBe('unknown')
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(502)
  })

  it("never puts the provider's own words in the user message", () => {
    const error = new ExternalServiceError({
      service: 'tranzila',
      message:
        'HTTP 500 from https://secure.tranzila.com/cgi-bin/tranzila71u.cgi',
    })

    expect(error.message).toContain('tranzila71u.cgi')
    expect(error.userMessage).not.toContain('tranzila71u.cgi')
    expect(error.userMessage).not.toContain('http')
  })
})

describe('IdempotencyConflictError', () => {
  it('treats an in-flight attempt as worth waiting for', () => {
    const error = new IdempotencyConflictError({
      kind: 'in_flight',
      operation: 'payment.create',
    })
    expect(error.retryable).toBe(true)
    expect(error.dataOutcome).toBe('unknown')
  })

  it('treats a reused key with different input as a refusal', () => {
    const error = new IdempotencyConflictError({
      kind: 'payload_mismatch',
      operation: 'payment.create',
    })
    expect(error.retryable).toBe(false)
    expect(error.dataOutcome).toBe('not_saved')
  })
})

describe('BusinessRuleError', () => {
  it('lets the domain name its own code so the interface can react', () => {
    const error = new BusinessRuleError({
      code: 'booking.dates_overlap',
      userMessage: 'התאריכים שנבחרו חופפים להזמנה קיימת ביחידה זו.',
    })
    expect(error.code).toBe('booking.dates_overlap')
    expect(error.status).toBe(422)
  })
})

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new NotFoundError('booking')
    expect(toAppError(original)).toBe(original)
  })

  it('wraps a plain Error and keeps it only as the cause', () => {
    const thrown = new TypeError(
      "Cannot read properties of undefined (reading 'id')",
    )
    const error = toAppError(thrown)

    expect(error).toBeInstanceOf(InternalError)
    expect(error.code).toBe('internal_error')
    expect(error.dataOutcome).toBe('unknown')
    expect((error as { cause?: unknown }).cause).toBe(thrown)
    expect(error.userMessage).not.toContain('undefined')
  })

  it('wraps a thrown non-error without echoing it', () => {
    const error = toAppError({ password: 'hunter2' })
    expect(error.code).toBe('internal_error')
    expect(error.message).not.toContain('hunter2')
    expect(error.userMessage).not.toContain('hunter2')
  })
})

describe('withCorrelation', () => {
  it('stamps an id onto an error that has none', () => {
    const error = withCorrelation(new NotFoundError('booking'), 'req-1')
    expect(error.correlationId).toBe('req-1')
  })

  it('does not overwrite an id set further in', () => {
    const inner = new NotFoundError('booking')
    inner.correlationId = 'req-inner'
    expect(withCorrelation(inner, 'req-outer').correlationId).toBe('req-inner')
  })

  it('leaves a non-AppError alone and returns it', () => {
    const plain = new Error('plain')
    expect(withCorrelation(plain, 'req-1')).toBe(plain)
  })
})
