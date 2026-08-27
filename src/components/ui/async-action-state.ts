/**
 * The state machine behind every non-idempotent button in the product.
 *
 * The charter's rule is that no user may unknowingly submit a critical action
 * twice. Disabling a button is the visible half of that and it is not enough:
 * a double-click can fire both events before React re-renders, and a keyboard
 * `Enter` repeat does the same. So the refusal lives in the reducer, where a
 * second `start` while pending is dropped — the button styling is only how the
 * refusal is explained.
 *
 * It is a reducer rather than a hook body precisely so this guarantee can be
 * asserted directly in `async-action-state.test.ts` without a DOM.
 */

import type { ErrorPresentation } from '../states/error-copy'

export type AsyncActionStatus = 'idle' | 'pending' | 'success' | 'error'

export type AsyncActionState<TResult = void> = {
  status: AsyncActionStatus
  /** Present only after a success. */
  result?: TResult
  /** Present only after a failure, already turned into user-facing copy. */
  error?: ErrorPresentation
  /** Hebrew confirmation shown on success; the charter demands a clear one. */
  successMessage?: string
  /**
   * Counts attempts the machine refused because one was already running.
   * Not cosmetic: a screen that sees this above zero knows its users are
   * double-clicking and that the affordance is unclear.
   */
  suppressedAttempts: number
}

export type AsyncActionEvent<TResult = void> =
  | { type: 'start' }
  | { type: 'succeed'; result: TResult; message?: string }
  | { type: 'fail'; error: ErrorPresentation }
  | { type: 'reset' }

export function initialAsyncActionState<
  TResult = void,
>(): AsyncActionState<TResult> {
  return { status: 'idle', suppressedAttempts: 0 }
}

export function asyncActionReducer<TResult>(
  state: AsyncActionState<TResult>,
  event: AsyncActionEvent<TResult>,
): AsyncActionState<TResult> {
  switch (event.type) {
    case 'start':
      if (state.status === 'pending') {
        // The whole point of the file. The extra attempt is recorded, the
        // action is not run again.
        return { ...state, suppressedAttempts: state.suppressedAttempts + 1 }
      }
      return { status: 'pending', suppressedAttempts: state.suppressedAttempts }

    case 'succeed':
      // Late resolutions from a run that was already superseded must not
      // resurrect a finished machine into a false success.
      if (state.status !== 'pending') return state
      return {
        status: 'success',
        result: event.result,
        successMessage: event.message,
        suppressedAttempts: state.suppressedAttempts,
      }

    case 'fail':
      if (state.status !== 'pending') return state
      return {
        status: 'error',
        error: event.error,
        suppressedAttempts: state.suppressedAttempts,
      }

    case 'reset':
      return initialAsyncActionState<TResult>()
  }
}

/**
 * The single question a control should ask before running: may I fire?
 * Kept next to the reducer so the button and the machine can never disagree.
 */
export function isActionBlocked(state: AsyncActionState<unknown>): boolean {
  return state.status === 'pending'
}
