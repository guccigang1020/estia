/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Where the guest is up to.
 *
 * ── The rule this component cannot break ──────────────────────────────────
 *
 * It renders the steps it is given and has no branch that could add one. That
 * is deliberate and it is the whole reason `buildSteps` exists as a pure
 * function next door: "never an empty step" is enforced by the list being
 * empty, not by a condition here that somebody later softens into a
 * greyed-out row. If a business requires nothing, this renders nothing at all —
 * see the early return.
 *
 * ── Not colour alone ──────────────────────────────────────────────────────
 *
 * Each state carries a mark AND a word: a tick with "הושלם", a filled dot with
 * "עכשיו", an empty dot with "בהמשך". A guest with any degree of colour
 * blindness, or reading in bright sun on a phone at half brightness, gets the
 * same information as everybody else.
 */

import type { GuestStep, GuestStepStatus } from '@/lib/guest-journey/steps'

const STATUS_WORD: Record<GuestStepStatus, string> = {
  done: 'הושלם',
  current: 'עכשיו',
  upcoming: 'בהמשך',
  blocked: 'ממתין לבית האירוח',
}

function Mark({ status }: { status: GuestStepStatus }) {
  if (status === 'done') {
    return (
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5"
        >
          <path d="m5 10.5 3.5 3.5L15 6.5" />
        </svg>
      </span>
    )
  }

  if (status === 'blocked') {
    return (
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border-strong text-muted-foreground"
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="size-3.5"
        >
          <path d="M10 5.5v5" />
          <path d="M10 13.5h.01" />
        </svg>
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={
        status === 'current'
          ? 'flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-primary'
          : 'flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border-strong'
      }
    >
      {status === 'current' && (
        <span className="size-2.5 rounded-full bg-primary" />
      )}
    </span>
  )
}

export function JourneyProgress({ steps }: { steps: readonly GuestStep[] }) {
  // A business that asks for nothing gets no list. Rendering an empty card with
  // a heading would be the "empty step" failure one level up.
  if (steps.length === 0) return null

  const done = steps.filter((step) => step.status === 'done').length

  return (
    <section
      aria-labelledby="journey-progress-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="journey-progress-heading"
          className="font-display text-base font-bold text-foreground"
        >
          מה נדרש ממך
        </h2>
        <p className="text-xs text-muted-foreground">
          {done} מתוך {steps.length}
        </p>
      </div>

      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="flex items-start gap-3 border-b border-border py-3 last:border-b-0"
          >
            <Mark status={step.status} />

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className={
                    step.status === 'done'
                      ? 'text-sm font-medium text-muted-foreground'
                      : 'text-sm font-semibold text-foreground'
                  }
                >
                  {step.label}
                </span>
                {!step.required && (
                  <span className="text-xs text-muted-foreground">
                    (לא חובה)
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {step.description}
              </p>
            </div>

            {/* The word beside the mark. Never the mark alone. */}
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {STATUS_WORD[step.status]}
            </span>

            <span className="sr-only">
              שלב {index + 1} מתוך {steps.length}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
