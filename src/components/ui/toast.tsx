'use client'

/**
 * Toasts — for confirming that something happened, and for nothing else.
 *
 * The rule that keeps this component from rotting into a dumping ground: a
 * toast is a notification the user can ignore. Anything that needs a decision
 * (a failed save, a conflict, a destructive confirmation) belongs in
 * `ErrorState` or `ConfirmDialog`, where it stays on screen until it is dealt
 * with. That is why there is no `danger` tone here and no action slot: a
 * message that disappears after six seconds is the wrong place to put a choice
 * whose consequence is money.
 *
 * Announcement: the live region is rendered by the provider and stays mounted
 * whether or not there are toasts. A region inserted at the same moment as its
 * content is frequently not announced at all — mounting it up front is what
 * makes the announcement reliable.
 *
 * `"use client"` — context, timers and state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { cn } from './cn'

export type ToastTone = 'success' | 'info' | 'warning'

export type ToastInput = {
  message: string
  /** One extra line at most. More than that is a panel, not a toast. */
  description?: string
  tone?: ToastTone
  /** Milliseconds on screen. Floors at 4000 so a message stays readable. */
  duration?: number
}

type Toast = Required<Omit<ToastInput, 'description'>> & {
  id: number
  description?: string
}

type ToastContextValue = {
  notify: (input: ToastInput) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>')
  }
  return context
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback((input: ToastInput) => {
    setToasts((current) => [
      ...current,
      {
        id: nextId.current++,
        message: input.message,
        description: input.description,
        tone: input.tone ?? 'success',
        duration: Math.max(input.duration ?? 6000, 4000),
      },
    ])
  }, [])

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        // Polite, never assertive: a confirmation must not cut across whatever
        // the user is reading or typing.
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-start sm:p-6"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONE_STYLE: Record<ToastTone, string> = {
  success: 'border-success text-success',
  info: 'border-border-strong text-muted-foreground',
  warning: 'border-warning text-warning',
}

/** The tone in words, so it is never carried by colour alone. */
const TONE_LABEL: Record<ToastTone, string> = {
  success: 'הצלחה',
  info: 'לידיעה',
  warning: 'שים לב',
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-start shadow-lift',
        TONE_STYLE[toast.tone],
      )}
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        <ToneIcon tone={toast.tone} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-foreground">
          <span className="sr-only">{TONE_LABEL[toast.tone]}: </span>
          {toast.message}
        </p>
        {toast.description && (
          <p className="text-xs text-muted-foreground">{toast.description}</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="סגירת ההודעה"
        className="-me-1 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <CloseIcon />
      </button>
    </div>
  )
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  const shared = {
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: 'false',
    className: 'size-4.5',
  } as const

  if (tone === 'success') {
    return (
      <svg {...shared}>
        <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z" />
        <path d="m6.8 10.2 2.2 2.2 4.2-4.6" />
      </svg>
    )
  }

  if (tone === 'warning') {
    return (
      <svg {...shared}>
        <path d="M8.6 3.3 1.9 15a1.6 1.6 0 0 0 1.4 2.4h13.4a1.6 1.6 0 0 0 1.4-2.4L11.4 3.3a1.6 1.6 0 0 0-2.8 0Z" />
        <path d="M10 7.8v3.4" />
        <path d="M10 14.2h.01" />
      </svg>
    )
  }

  return (
    <svg {...shared}>
      <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z" />
      <path d="M10 9.4v4" />
      <path d="M10 6.4h.01" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="size-4"
    >
      <path d="m6 6 8 8M14 6l-8 8" />
    </svg>
  )
}
