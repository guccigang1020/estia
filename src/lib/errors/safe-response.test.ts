/**
 * The line between the server and the user.
 *
 * Every one of these tests is a negative test. They do not prove that a good
 * message gets through; they prove that a stack trace, a SQL string, a
 * provider's endpoint, a primary key and a secret do not — including when the
 * error was constructed carelessly, which is the case that will actually
 * happen.
 */

import { describe, expect, it } from 'vitest'
import { AuthorizationError, type Decision } from '../authz/can'
import {
  AppError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from './app-error'
import { sanitizeDetails, toLogEntry, toSafeResponse } from './safe-response'

const CORRELATION = 'req-7f2a9c'

/** Everything the response could possibly say, as one searchable string. */
function serialise(value: unknown): string {
  return JSON.stringify(value)
}

describe('toSafeResponse · leakage', () => {
  it('never exposes a stack trace', () => {
    const thrown = new Error('boom')
    const response = toSafeResponse(thrown, CORRELATION)

    expect(thrown.stack).toBeTruthy()
    expect(serialise(response)).not.toContain('safe-response.test')
    expect(serialise(response)).not.toContain('at ')
    expect('stack' in response.error).toBe(false)
  })

  it('never exposes a SQL string', () => {
    const thrown = new Error(
      `error: duplicate key value violates unique constraint "bookings_pkey"\n` +
        `INSERT INTO public.bookings (id, organization_id) VALUES ('bk-1', 'org-a')`,
    )
    const response = toSafeResponse(thrown, CORRELATION)

    const body = serialise(response)
    expect(body).not.toContain('INSERT INTO')
    expect(body).not.toContain('bookings_pkey')
    expect(body).not.toContain('org-a')
  })

  it('never exposes the technical message of a handled error', () => {
    const error = new NotFoundError('booking', 'bk-88f1')
    const response = toSafeResponse(error, CORRELATION)

    expect(serialise(response)).not.toContain('bk-88f1')
    expect(response.error.message).toBe('הרשומה המבוקשת לא נמצאה.')
  })

  it("never forwards an external provider's own error text", () => {
    const error = new ExternalServiceError({
      service: 'tranzila',
      message: 'POST https://secure.tranzila.com/x failed: token=sk_live_9912',
    })
    const response = toSafeResponse(error, CORRELATION)

    const body = serialise(response)
    expect(body).not.toContain('sk_live_9912')
    expect(body).not.toContain('secure.tranzila.com')
  })

  it('preserves the correlation id even for a completely unknown throw', () => {
    for (const thrown of [
      undefined,
      null,
      'a string',
      42,
      { a: 1 },
      new Error('x'),
    ]) {
      const response = toSafeResponse(thrown, CORRELATION)
      expect(response.error.correlationId).toBe(CORRELATION)
    }
  })

  it('reports an unrecognised throw as a generic internal failure', () => {
    const response = toSafeResponse(
      new RangeError('index 4 out of range'),
      CORRELATION,
    )

    expect(response.status).toBe(500)
    expect(response.error.code).toBe('internal_error')
    expect(response.error.dataOutcome).toBe('unknown')
    expect(serialise(response)).not.toContain('index 4')
  })
})

describe('toSafeResponse · answering the three questions', () => {
  it('says what failed, whether the data was saved, and whether to retry', () => {
    const response = toSafeResponse(
      new ConflictError({
        resourceType: 'booking',
        expectedVersion: 3,
        actualVersion: 5,
      }),
      CORRELATION,
    )

    expect(response.error.message).toContain('משתמש אחר')
    expect(response.error.dataOutcome).toBe('not_saved')
    expect(response.error.dataMessage).toBe('השינוי שלך לא נשמר.')
    expect(response.error.retryable).toBe(false)
    expect(response.error.retryMessage).toContain('לא יעזור')
  })

  it('admits when it does not know whether the data was saved', () => {
    const response = toSafeResponse(
      new ExternalServiceError({ service: 'tranzila' }),
      CORRELATION,
    )
    expect(response.error.dataOutcome).toBe('unknown')
    expect(response.error.dataMessage).toContain('בדוק')
    expect(response.error.retryable).toBe(true)
  })

  it('lists every offending field for a validation failure', () => {
    const response = toSafeResponse(
      new ValidationError([
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
      ]),
      CORRELATION,
    )

    expect(response.status).toBe(422)
    expect(response.error.fields).toHaveLength(2)
    expect(response.error.fields?.map((f) => f.field)).toEqual([
      'guest.email',
      'nights',
    ])
  })

  it('carries the quota state so the interface can offer an upgrade', () => {
    const response = toSafeResponse(
      new QuotaExceededError({
        quota: {
          key: 'members',
          current: 11,
          limit: 10,
          withinLimit: false,
          inOverage: true,
          approaching: false,
        },
      }),
      CORRELATION,
    )

    expect(response.status).toBe(402)
    expect(response.error.details).toMatchObject({
      quotaKey: 'members',
      current: 11,
      limit: 10,
      upgradeAvailable: true,
    })
  })
})

describe('toSafeResponse · authorization refusals', () => {
  function refusal(decision: Extract<Decision, { allowed: false }>) {
    return new AuthorizationError(decision, 'booking.update')
  }

  it('reports a cross-organization attempt as a plain not-found', () => {
    // The security point of this test: telling a prober "you are not allowed
    // to see this booking" confirms the booking exists. It must be
    // indistinguishable from an id that was never real.
    const crossTenant = toSafeResponse(
      refusal({ allowed: false, reason: 'cross_organization' }),
      CORRELATION,
    )
    const missing = toSafeResponse(
      new NotFoundError('booking', 'bk-1'),
      CORRELATION,
    )

    expect(crossTenant.status).toBe(404)
    expect(crossTenant.error.code).toBe('not_found')
    expect(crossTenant.error.message).toBe(missing.error.message)
    expect(crossTenant.error.details).toBeUndefined()
  })

  it('names the missing grant, because the interface can act on it', () => {
    const response = toSafeResponse(
      refusal({
        allowed: false,
        reason: 'missing_permission',
        grant: 'booking.update',
      }),
      CORRELATION,
    )

    expect(response.status).toBe(403)
    expect(response.error.code).toBe('missing_permission')
    expect(response.error.details).toEqual({ requiredGrant: 'booking.update' })
  })

  it('offers the upgrade when the plan is what is missing', () => {
    const response = toSafeResponse(
      refusal({
        allowed: false,
        reason: 'plan_does_not_include',
        grant: 'site.publish',
        entitlement: 'website',
      }),
      CORRELATION,
    )

    expect(response.status).toBe(402)
    expect(response.error.code).toBe('plan_does_not_include')
    expect(response.error.details).toMatchObject({
      requiredEntitlement: 'website',
      upgradeAvailable: true,
    })
  })

  it('says nothing about the resource when the refusal was about scope', () => {
    const response = toSafeResponse(
      refusal({
        allowed: false,
        reason: 'out_of_scope',
        grant: 'booking.update',
      }),
      CORRELATION,
    )
    expect(response.error.code).toBe('out_of_scope')
    expect(response.error.details).toBeUndefined()
  })

  it('directs a suspended member to their manager', () => {
    const response = toSafeResponse(
      refusal({ allowed: false, reason: 'membership_not_active' }),
      CORRELATION,
    )
    expect(response.status).toBe(403)
    expect(response.error.code).toBe('membership_not_active')
    expect(response.error.message).toContain('מנהל הארגון')
  })
})

describe('sanitizeDetails', () => {
  it('drops keys that could carry internals, however they arrived', () => {
    const sanitised = sanitizeDetails({
      resourceType: 'booking',
      stack: 'Error: boom\n    at run (/app/src/x.ts:12:5)',
      sql: 'SELECT * FROM bookings',
      cause: 'anything',
      api_key: 'sk_live_9912',
      card_token: 'tok_1',
    })

    expect(sanitised).toEqual({ resourceType: 'booking' })
  })

  it('drops anything object-shaped, because that is where internals hide', () => {
    const sanitised = sanitizeDetails({
      keep: 'yes',
      nested: { organizationId: 'org-b', row: { id: 1 } },
      when: new Date('2026-01-01'),
      fn: () => 'x',
      list: [1, 2, 3],
      mixedList: [{ a: 1 }],
    })

    expect(sanitised).toEqual({ keep: 'yes', list: [1, 2, 3] })
  })

  it('truncates a long string rather than passing a payload through', () => {
    const sanitised = sanitizeDetails({ note: 'א'.repeat(5000) })
    expect((sanitised?.note as string).length).toBeLessThanOrEqual(201)
  })

  it('returns undefined when nothing survived', () => {
    expect(sanitizeDetails({ stack: 'x' })).toBeUndefined()
    expect(sanitizeDetails(undefined)).toBeUndefined()
  })

  it('is applied to whatever an error attached, not only to trusted detail', () => {
    // The realistic failure: someone puts the caught exception in publicDetails
    // "just for debugging" and it ships.
    const careless = new AppError({
      code: 'careless',
      status: 500,
      message: 'x',
      userMessage: 'x',
      publicDetails: {
        stack: new Error('boom').stack,
        error: new Error('boom'),
        safe: 'ok',
      },
    })

    const response = toSafeResponse(careless, CORRELATION)
    expect(response.error.details).toEqual({ safe: 'ok' })
    expect(serialise(response)).not.toContain('boom')
  })
})

describe('toLogEntry', () => {
  it('keeps everything the response withheld, under the same id', () => {
    const thrown = new Error('INSERT INTO public.bookings failed')
    const entry = toLogEntry(thrown, CORRELATION)

    expect(entry.correlationId).toBe(CORRELATION)
    expect(entry.code).toBe('internal_error')
    expect(entry.stack).toBeTruthy()
    expect(entry.cause).toContain('INSERT INTO')
  })

  it('logs an authorization refusal under its real reason', () => {
    // The user is told "not found"; the log says why it really happened.
    const entry = toLogEntry(
      new AuthorizationError(
        { allowed: false, reason: 'cross_organization' },
        'booking.update',
      ),
      CORRELATION,
    )
    expect(entry.code).toBe('cross_organization')
    expect(entry.status).toBe(403)
  })
})
