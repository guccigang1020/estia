/**
 * Async action safety.
 *
 * The charter rule is one sentence — no user may unknowingly submit a critical
 * action twice — and it is the one most easily broken by a fast double-click,
 * a held `Enter`, or a resolution arriving from a run the user already
 * abandoned. Each of those is a test below.
 */

import { describe, expect, it } from 'vitest'

import { describeError } from '../states/error-copy'
import {
  asyncActionReducer,
  initialAsyncActionState,
  isActionBlocked,
  type AsyncActionState,
} from './async-action-state'

function start<T>(state: AsyncActionState<T>): AsyncActionState<T> {
  return asyncActionReducer(state, { type: 'start' })
}

describe('asyncActionReducer — a second submission never runs', () => {
  it('moves from idle to pending on the first attempt', () => {
    const state = start(initialAsyncActionState<string>())

    expect(state.status).toBe('pending')
    expect(state.suppressedAttempts).toBe(0)
  })

  it('refuses a second start while the first is still running', () => {
    const first = start(initialAsyncActionState<string>())
    const second = start(first)

    expect(second.status).toBe('pending')
    expect(second.suppressedAttempts).toBe(1)
  })

  it('counts every suppressed attempt, so a mis-designed button is visible', () => {
    let state = start(initialAsyncActionState<string>())
    state = start(state)
    state = start(state)
    state = start(state)

    expect(state.suppressedAttempts).toBe(3)
  })

  it('blocks the control for exactly as long as the action runs', () => {
    const pending = start(initialAsyncActionState<string>())
    expect(isActionBlocked(pending)).toBe(true)

    const done = asyncActionReducer(pending, { type: 'succeed', result: 'ok' })
    expect(isActionBlocked(done)).toBe(false)
  })

  it('allows a deliberate second attempt once the first has failed', () => {
    const failed = asyncActionReducer(
      start(initialAsyncActionState<string>()),
      {
        type: 'fail',
        error: describeError({ kind: 'network' }),
      },
    )

    const retry = start(failed)

    expect(retry.status).toBe('pending')
    expect(retry.suppressedAttempts).toBe(0)
  })
})

describe('asyncActionReducer — the user is told what happened', () => {
  it("carries a success message so 'nothing visibly changed' cannot happen", () => {
    const state = asyncActionReducer(start(initialAsyncActionState<string>()), {
      type: 'succeed',
      result: 'booking-1',
      message: 'ההזמנה נשמרה',
    })

    expect(state.status).toBe('success')
    expect(state.result).toBe('booking-1')
    expect(state.successMessage).toBe('ההזמנה נשמרה')
  })

  it('carries a recoverable failure as user-facing copy, not as an exception', () => {
    const error = describeError({
      kind: 'timeout',
      operation: 'לשמור את ההזמנה',
    })
    const state = asyncActionReducer(start(initialAsyncActionState<string>()), {
      type: 'fail',
      error,
    })

    expect(state.status).toBe('error')
    expect(state.error?.canRetry).toBe(true)
    expect(state.error?.dataOutcomeText).toContain('לא ידוע')
  })
})

describe('asyncActionReducer — a stale resolution cannot revive a finished action', () => {
  it('ignores a success that arrives after the machine was reset', () => {
    const reset = asyncActionReducer(start(initialAsyncActionState<string>()), {
      type: 'reset',
    })

    const late = asyncActionReducer(reset, { type: 'succeed', result: 'ok' })

    expect(late).toBe(reset)
    expect(late.status).toBe('idle')
  })

  it('ignores a failure that arrives after the action already succeeded', () => {
    const succeeded = asyncActionReducer(
      start(initialAsyncActionState<string>()),
      {
        type: 'succeed',
        result: 'ok',
      },
    )

    const late = asyncActionReducer(succeeded, {
      type: 'fail',
      error: describeError({ kind: 'network' }),
    })

    expect(late).toBe(succeeded)
    expect(late.status).toBe('success')
  })

  it('clears everything on reset, leaving no stale error on screen', () => {
    const failed = asyncActionReducer(
      start(initialAsyncActionState<string>()),
      {
        type: 'fail',
        error: describeError({ kind: 'server' }),
      },
    )

    const state = asyncActionReducer(failed, { type: 'reset' })

    expect(state).toEqual(initialAsyncActionState<string>())
    expect(state.error).toBeUndefined()
  })
})
