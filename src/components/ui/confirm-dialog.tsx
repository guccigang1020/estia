'use client'

/**
 * Confirmation for an irreversible action.
 *
 * Built on the native `<dialog>` element with `showModal()`, which is not
 * laziness — it is the only implementation that gets the hard parts right for
 * free and keeps getting them right as browsers change:
 *
 *  · focus moves into the dialog on open and is trapped inside it;
 *  · everything behind it becomes inert, including to a screen reader;
 *  · `Escape` closes it, firing `cancel` and then `close`;
 *  · focus returns to the element that opened it, with no ref bookkeeping.
 *
 * What is added here is this product's own three rules: the dialog cannot be
 * dismissed while the confirmed action is running, a genuinely dangerous action
 * can demand that its name be typed, and a failure keeps the dialog open with
 * an explanation instead of closing on a delete that did not happen. The first
 * two verdicts come from `confirm-gate.ts`, which is unit-tested.
 *
 * `"use client"` — refs, effects and the imperative `showModal()` call.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { describeError, type ErrorPresentation } from '../states/error-copy'
import { useAsyncAction } from './async-action'
import { Button } from './button'
import { cn } from './cn'
import { evaluateConfirmGate } from './confirm-gate'
import { Field } from './field'
import { TextInput } from './input'

export type ConfirmDialogProps = {
  open: boolean
  /** Called with `false` on cancel, on `Escape`, and after a confirmed run. */
  onOpenChange: (open: boolean) => void
  title: string
  /** What will happen and what cannot be undone. Say it plainly. */
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  pendingLabel?: string
  /**
   * When set, the user must type this phrase — usually the name of the thing
   * being destroyed. Reserve it for actions that destroy money or history;
   * demanding it everywhere trains people to type without reading.
   */
  requiredPhrase?: string
  onConfirm: () => Promise<void>
  /** Classifies a thrown failure. Without it the copy stays honestly vague. */
  toError?: (cause: unknown) => ErrorPresentation
  className?: string
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'ביטול',
  pendingLabel = 'מבצע…',
  requiredPhrase,
  onConfirm,
  toError,
  className,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [typed, setTyped] = useState('')
  const { state, pending, run, reset } = useAsyncAction()

  const gate = evaluateConfirmGate({ requiredPhrase, typed, pending })
  const failure = state.status === 'error' ? state.error : undefined

  // Drive the element from the `open` prop. `showModal()` is what produces the
  // focus trap and the inert background; setting the `open` attribute directly
  // renders a non-modal dialog with none of it.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Close on success only. A failure keeps the dialog and its explanation on
  // screen, because closing would tell the user the deletion happened.
  useEffect(() => {
    if (state.status === 'success') onOpenChange(false)
  }, [state.status, onOpenChange])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // `cancel` fires for Escape and for the platform close gesture. Blocking
      // it mid-flight stops someone walking away from a delete they cannot
      // recall, believing they cancelled it.
      onCancel={(event) => {
        if (pending) {
          event.preventDefault()
          return
        }
        onOpenChange(false)
      }}
      // `close` fires for every dismissal — button, Escape, or the programmatic
      // `close()` above — which makes it the one place worth clearing state.
      // A dialog reopened while still holding last time's typed phrase would
      // let a second deletion through on a single keystroke. Doing it here
      // rather than in an effect keeps it a response to an event instead of a
      // cascading render.
      onClose={() => {
        setTyped('')
        reset()
        onOpenChange(false)
      }}
      className={cn(
        'm-auto w-[min(30rem,calc(100%-2rem))] rounded-xl border border-border bg-surface p-0 text-start text-foreground shadow-lift',
        'backdrop:bg-foreground/40',
        className,
      )}
    >
      <div className="flex flex-col gap-5 p-6 sm:p-7">
        <div className="flex flex-col gap-2">
          <h2
            id={titleId}
            className="font-display text-xl font-bold tracking-tight text-foreground"
          >
            {title}
          </h2>
          <div className="text-[0.9375rem] text-muted-foreground">
            {description}
          </div>
        </div>

        {gate.phraseRequired && (
          <Field
            label={`להמשך, הקלד: ${requiredPhrase}`}
            description="השלב הזה קיים כדי שפעולה בלתי הפיכה לא תקרה בהיסח הדעת."
            error={
              gate.reason === 'phrase_mismatch'
                ? (gate.hint ?? undefined)
                : undefined
            }
          >
            <TextInput
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        {failure && (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-lg border border-danger bg-danger/8 px-4 py-3 text-sm"
          >
            <strong className="font-semibold text-foreground">
              {failure.title}
            </strong>
            <span className="text-muted-foreground">{failure.description}</span>
            <span className="text-muted-foreground">
              {failure.dataOutcomeText}
            </span>
            <span className="text-muted-foreground">{failure.retryText}</span>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="secondary"
            // Focused first on open: the safe choice belongs under the fingers,
            // not the destructive one.
            autoFocus
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>

          <Button
            variant="danger"
            disabled={!gate.canConfirm}
            onClick={() => {
              if (!gate.canConfirm) return
              void run(onConfirm, {
                toError: toError ?? ((cause) => defaultToError(cause)),
              })
            }}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>

        {/* Explains a disabled confirm button instead of leaving the user to
            guess why nothing happens. Polite, so it never interrupts typing. */}
        <p aria-live="polite" className="sr-only">
          {gate.canConfirm ? '' : (gate.hint ?? '')}
        </p>
      </div>
    </dialog>
  )
}

function defaultToError(cause: unknown): ErrorPresentation {
  return describeError({
    kind: 'unknown',
    // Without a classifier from the caller the honest answer is that we do not
    // know whether the destructive action landed — and that is exactly what
    // this says, rather than a reassuring guess.
    dataOutcome: 'unknown',
    reference: cause instanceof Error ? cause.name : undefined,
  })
}
