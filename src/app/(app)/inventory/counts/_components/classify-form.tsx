'use client'

/**
 * Saying what one difference means.
 *
 * ── The options are this variance's, not a catalogue ──────────────────────
 *
 * `classificationsFor` decides which of the seven this particular difference
 * may be given, and this renders exactly what it was handed. A surplus is not
 * offered a write-off; an item the ledger shows no circulation for is not
 * offered "in the wash". A dropdown offering a choice the write path then
 * refuses teaches a person to distrust the screen.
 *
 * ── The help text under each option is the product's own reasoning ────────
 *
 * `LOSS_CLASS_HELP` says what the choice will do to the ledger before the
 * button is pressed, from the same table the write path obeys. So "נפגם" is
 * not a word the person has to interpret — it says the units move to
 * ״פגום״ and nothing is written off.
 *
 * ── "לא הוסבר" is a real answer and is offered as one ─────────────────────
 *
 * It writes nothing, it demands nothing, and the difference stays visible in
 * the exposure estimate. It is the honest choice when nobody knows, and it is
 * the last one on the list rather than the missing one.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, Textarea } from '@/components/ui/input'
import {
  LOSS_CLASS_HELP,
  LOSS_CLASS_LABEL,
  type LossClass,
} from '@/lib/inventory/loss'

import { classifyVarianceAction } from '../_lib/actions'

export interface ClassifyFormProps {
  sessionId: string
  varianceId: string
  /** Exactly what `classificationsFor` allowed for this variance. */
  options: readonly LossClass[]
  current: LossClass | null
}

/** The three that take stock out of the count and therefore need a sentence. */
const NEEDS_NOTE: readonly LossClass[] = ['damaged', 'disposed', 'lost']

export function ClassifyForm({
  sessionId,
  varianceId,
  options,
  current,
}: ClassifyFormProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [choice, setChoice] = useState<LossClass | ''>(current ?? '')
  const [note, setNote] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        אין סיווג אפשרי להפרש הזה.
      </p>
    )
  }

  const chosen = choice === '' ? null : choice
  const noteRequired = chosen !== null && NEEDS_NOTE.includes(chosen)

  function submit() {
    if (chosen === null) {
      setFailure('יש לבחור סיווג.')
      return
    }

    startTransition(async () => {
      const result = await classifyVarianceAction({
        sessionId,
        varianceId,
        classification: chosen,
        note: note.trim().length === 0 ? null : note.trim(),
      })

      if (result.ok) {
        setFailure(null)
        router.refresh()
        return
      }
      setFailure(result.error.message)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="סיווג ההפרש"
        description={chosen === null ? undefined : LOSS_CLASS_HELP[chosen]}
        error={failure ?? undefined}
      >
        <Select
          value={choice}
          onChange={(event) => setChoice(event.target.value as LossClass | '')}
        >
          <option value="">בחר סיווג</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {LOSS_CLASS_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      {noteRequired && (
        <Field
          label="נימוק"
          description="גריעה מהמלאי בלי נימוק היא מספר שאיש לא יוכל להסביר בעוד חודשיים."
          required
        >
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
          />
        </Field>
      )}

      <div>
        <Button
          size="sm"
          disabled={
            pending ||
            chosen === null ||
            (noteRequired && note.trim().length === 0)
          }
          onClick={submit}
        >
          {pending ? 'שומר…' : 'שמור סיווג'}
        </Button>
      </div>
    </div>
  )
}
