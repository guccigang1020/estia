/**
 * One collision, both sides of it, and a decision that has to be made.
 *
 * ══ THE RULE THIS COMPONENT EXISTS TO NOT BREAK ═══════════════════════════
 *
 * Nothing in the migration discards a record because it collided. Three years
 * of bookings contain genuine double-entries, cancelled-then-rebooked stays and
 * one villa sold twice on a Friday in 2023, and every one of those is a fact
 * about the operator's business that they — not this product — have to settle.
 * A silent drop makes the import *look* cleaner and makes the migration wrong
 * in a way nobody discovers until a guest arrives at a full house.
 *
 * So this card has no default, no "resolve all" and no dismiss. It shows what
 * the file says, what ESTIA already holds, the question in one sentence, and
 * the options — each with the consequence of pressing it written underneath,
 * because a button called "ייבא בכל זאת" that a person has to guess about is
 * the same as no decision at all.
 *
 * ── Both sides, symmetrically ─────────────────────────────────────────────
 *
 * `left` is always the import and `right` is always ESTIA, and they are laid
 * out identically. An asymmetric card — the incoming row large and the existing
 * one as a footnote — is an argument for importing, and this screen is not
 * supposed to have an opinion.
 *
 * No `'use client'` directive: it takes `onDecide` and is rendered inside the
 * wizard's client tree, which is where the state it changes lives.
 */

import { Badge } from '@/components/ui/badge'
import {
  CONFLICT_KIND_LABEL,
  type Conflict,
  type ConflictDecision,
  type ConflictSide,
} from '@/lib/migration/types'

import { DECISION_LABEL, optionsFor } from './decisions'

export function ConflictCard({
  conflict,
  onDecide,
  disabled = false,
}: {
  conflict: Conflict
  onDecide: (id: string, decision: ConflictDecision) => void
  disabled?: boolean
}) {
  const settled = conflict.decision !== 'undecided'

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border p-4 ${
        settled ? 'border-border bg-surface' : 'border-danger bg-surface'
      }`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={settled ? 'neutral' : 'accent'}>
          {CONFLICT_KIND_LABEL[conflict.kind]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          שורה {conflict.rowNumber}
        </span>
        <span
          className={`text-xs font-semibold ${
            settled ? 'text-foreground' : 'text-danger'
          }`}
        >
          {DECISION_LABEL[conflict.decision]}
        </span>
      </header>

      <p className="text-sm font-medium text-foreground">{conflict.question}</p>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Side heading="מהקובץ שלך" side={conflict.left} />
        <Side heading="כבר קיים ב-ESTIA" side={conflict.right} />
      </dl>

      <div className="flex flex-col gap-2">
        {optionsFor(conflict.kind).map((option) => {
          const chosen = conflict.decision === option.decision
          return (
            <button
              key={option.decision}
              type="button"
              disabled={disabled}
              aria-pressed={chosen}
              onClick={() => onDecide(conflict.id, option.decision)}
              className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-right transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                chosen
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-muted hover:bg-surface'
              }`}
            >
              <span className="text-sm font-semibold text-foreground">
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {option.consequence}
              </span>
            </button>
          )
        })}
      </div>

      {settled && (
        <p className="text-xs text-muted-foreground">
          אפשר לשנות את ההחלטה עד לרגע הייבוא. כל שינוי מריץ את ההרצה היבשה
          מחדש, כדי שהמספרים שאתם קוראים יתארו את מה שבאמת ייכתב.
        </p>
      )}
    </article>
  )
}

function Side({ heading, side }: { heading: string; side: ConflictSide }) {
  return (
    <div className="rounded-lg border border-border bg-muted p-3">
      <dt className="text-xs font-semibold text-muted-foreground">{heading}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{side.label}</dd>
      <dd className="text-xs text-muted-foreground">{side.detail}</dd>
      <dd className="mt-1 text-xs text-muted-foreground">
        {side.origin === 'import' ? 'שורה' : 'מזהה'} {side.reference}
      </dd>
    </div>
  )
}
