'use client'

/**
 * `"use client"` because this is entirely about in-flight state: `useFormStatus`
 * reads the pending status of the enclosing form, and `useAsyncAction` holds
 * the state machine that refuses a second run. Neither exists on the server.
 *
 * React 19 API, verified against `node_modules/next/dist/docs` rather than
 * recalled:
 *
 *  · `useActionState(action, initialState)` returns `[state, formAction,
 *    isPending]` — the pending flag is the third element and is what the form
 *    docs use to disable the submit button. Expected failures are modelled as
 *    returned state, not thrown.
 *  · `useFormStatus()` comes from `react-dom` and reports the status of the
 *    nearest ancestor `<form>`. It must be called from a component *inside*
 *    that form, which is exactly why `SubmitButton` is its own component.
 *
 * `SubmitButton` therefore covers the Server Function path, and
 * `useAsyncAction` + `ActionButton` cover the plain-callback path (an optimistic
 * toggle, a row action, anything not driven by a `<form>`).
 */

import {
  useCallback,
  useReducer,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { useFormStatus } from 'react-dom'

import { describeError, type ErrorPresentation } from '../states/error-copy'
import { Button, type ButtonSize, type ButtonVariant } from './button'

/**
 * `ButtonProps` is a union discriminated by `href`, which does not survive
 * `Omit`. Both controls below are always real `<button>` elements, so they take
 * the button half directly.
 */
type ButtonElementProps = Omit<ComponentProps<'button'>, 'children'>
import {
  asyncActionReducer,
  initialAsyncActionState,
  type AsyncActionState,
} from './async-action-state'

/* ----------------------------------------------------- form submit path -- */

export type SubmitButtonProps = {
  children: ReactNode
  /** Shown while the form is submitting. Say what is happening, not "טוען". */
  pendingLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
} & Omit<ButtonElementProps, 'type'>

/**
 * The submit control for a form driven by a Server Function.
 *
 * Must be rendered inside the `<form>` whose status it reports — that is a
 * `useFormStatus` requirement, not a style preference.
 */
export function SubmitButton({
  children,
  pendingLabel = 'שומר…',
  variant = 'primary',
  disabled,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || disabled}
      {...props}
    >
      {pending && <Spinner />}
      {pending ? pendingLabel : children}
      <span aria-live="polite" className="sr-only">
        {pending ? pendingLabel : ''}
      </span>
    </Button>
  )
}

/* -------------------------------------------------- plain callback path -- */

export type RunOptions = {
  /** Hebrew confirmation to surface on success. */
  successMessage?: string
  /** Turns a thrown failure into user-facing copy. Defaults to a safe unknown. */
  toError?: (cause: unknown) => ErrorPresentation
}

export type UseAsyncAction<TResult> = {
  state: AsyncActionState<TResult>
  pending: boolean
  run: (action: () => Promise<TResult>, options?: RunOptions) => Promise<void>
  reset: () => void
}

/**
 * Runs one async action at a time and reports the outcome.
 *
 * Two locks, and both are needed. The ref is checked and set synchronously,
 * because two clicks in the same tick both read the same rendered `state` and
 * a state-only check would let the second one through — which is precisely the
 * duplicate charge the charter forbids. The reducer is the second lock and the
 * one that is unit-tested; it also records how many attempts were suppressed.
 */
export function useAsyncAction<TResult = void>(): UseAsyncAction<TResult> {
  const [state, dispatch] = useReducer(
    asyncActionReducer<TResult>,
    initialAsyncActionState<TResult>(),
  )
  const running = useRef(false)

  const run = useCallback(
    async (action: () => Promise<TResult>, options: RunOptions = {}) => {
      if (running.current) {
        // Recorded rather than silently dropped: a screen whose users keep
        // double-clicking has an affordance problem worth seeing.
        dispatch({ type: 'start' })
        return
      }

      running.current = true
      dispatch({ type: 'start' })

      try {
        const result = await action()
        dispatch({ type: 'succeed', result, message: options.successMessage })
      } catch (cause) {
        dispatch({
          type: 'fail',
          error: options.toError
            ? options.toError(cause)
            : describeError({ kind: 'unknown' }),
        })
      } finally {
        running.current = false
      }
    },
    [],
  )

  const reset = useCallback(() => {
    running.current = false
    dispatch({ type: 'reset' })
  }, [])

  return { state, pending: state.status === 'pending', run, reset }
}

export type ActionButtonProps = {
  onAction: () => Promise<void>
  children: ReactNode
  pendingLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
} & Omit<ButtonElementProps, 'onClick'>

/**
 * A button for a non-form async action that cannot be fired twice.
 *
 * The `disabled` attribute is the explanation; the early return is the
 * guarantee. A fast double-click delivers both events before React re-renders,
 * so relying on `disabled` alone would still let the second one through.
 */
export function ActionButton({
  onAction,
  children,
  pendingLabel = 'מבצע…',
  variant = 'primary',
  disabled,
  ...props
}: ActionButtonProps) {
  const { pending, run } = useAsyncAction()

  return (
    <Button
      variant={variant}
      disabled={pending || disabled}
      onClick={() => {
        if (pending) return
        void run(onAction)
      }}
      {...props}
    >
      {pending && <Spinner />}
      {pending ? pendingLabel : children}
      <span aria-live="polite" className="sr-only">
        {pending ? pendingLabel : ''}
      </span>
    </Button>
  )
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="size-4 animate-spin motion-reduce:animate-none"
    >
      <circle cx="10" cy="10" r="7.5" className="opacity-30" />
      <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" />
    </svg>
  )
}
