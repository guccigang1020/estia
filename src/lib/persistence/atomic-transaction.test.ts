/**
 * The refusals, without a database.
 *
 * Everything this file asserts happens *before* a connection is opened, which
 * is deliberate: the failure modes worth catching here are the ones where the
 * runner would otherwise proceed. A transaction that cannot be made the
 * signed-in user must never open at all, because the connection it would open
 * carries `BYPASSRLS`.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Db } from './client'
import {
  AtomicTransactionUnavailableError,
  postgresUnitOfWork,
} from './atomic-transaction'

const POOLER =
  'postgresql://postgres.ref:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'

/** A client whose only interesting behaviour is who it says the user is. */
function clientFor(
  user: { id: string; email?: string } | null,
  error?: unknown,
): Db {
  return {
    auth: {
      async getUser() {
        return { data: { user }, error: error ?? null }
      },
    },
  } as unknown as Db
}

describe('postgresUnitOfWork', () => {
  it('refuses to exist without a database URL', () => {
    expect(() =>
      postgresUnitOfWork(clientFor({ id: 'u1' }), { url: undefined }),
    ).toThrowError(
      // Only when the environment has none either; the message names the
      // variable so the failure is actionable rather than mysterious.
      process.env.DATABASE_URL
        ? /never matches/
        : AtomicTransactionUnavailableError,
    )
  })

  it('warns when the URL is not the transaction pooler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    postgresUnitOfWork(clientFor({ id: 'u1' }), {
      url: 'postgresql://postgres:secret@db.ref.supabase.co:5432/postgres',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('transaction pooler'),
    )
    warn.mockRestore()
  })

  it('does not warn for port 6543', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    postgresUnitOfWork(clientFor({ id: 'u1' }), { url: POOLER })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refuses to open a transaction when nobody is signed in', async () => {
    // The single most important assertion in this file. A direct connection
    // with no session would run as the owner with BYPASSRLS, and every policy
    // in 0004_rls would be skipped in silence. Refusing is the only safe
    // answer; falling back to the sequential runner would be worse, because
    // the caller asked for atomicity and would not be told it had not got it.
    const runner = postgresUnitOfWork(clientFor(null), { url: POOLER })
    const work = vi.fn()

    await expect(runner.run(work)).rejects.toBeInstanceOf(
      AtomicTransactionUnavailableError,
    )
    // And the work never ran, so nothing was attempted unrestricted.
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses when the session could not be verified', async () => {
    const runner = postgresUnitOfWork(
      clientFor(null, { message: 'jwt expired' }),
      { url: POOLER },
    )
    await expect(runner.run(async () => 'never')).rejects.toBeInstanceOf(
      AtomicTransactionUnavailableError,
    )
  })

  it('reports the failure as `not_saved`, so a retry is safe', async () => {
    const runner = postgresUnitOfWork(clientFor(null), { url: POOLER })
    const failure = await runner.run(async () => 1).catch((e: unknown) => e)

    // Nothing ran, so nothing was written, and the caller can retry without
    // checking the state of anything first. That distinction is the whole
    // purpose of `dataOutcome`.
    expect(failure).toMatchObject({
      code: 'atomic_transaction_unavailable',
      dataOutcome: 'not_saved',
      retryable: false,
    })
  })

  it('rejects a statement timeout that is not a positive whole number', () => {
    // Caught at construction, before a socket is opened. `statement_timeout`
    // and `idle_in_transaction_session_timeout` are the only two numbers in
    // this layer that are interpolated rather than bound — `SET` cannot take a
    // parameter — so they are the only two that need validating.
    expect(() =>
      postgresUnitOfWork(clientFor({ id: 'u1' }), {
        url: POOLER,
        statementTimeoutMs: 0,
      }),
    ).toThrowError(AtomicTransactionUnavailableError)

    expect(() =>
      postgresUnitOfWork(clientFor({ id: 'u1' }), {
        url: POOLER,
        idleInTransactionTimeoutMs: 1.5,
      }),
    ).toThrowError(AtomicTransactionUnavailableError)
  })
})
