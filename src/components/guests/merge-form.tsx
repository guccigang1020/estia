'use client'

/**
 * The merge screen: two columns, one decision per disagreement.
 *
 * ══ THE CONFIRMATION IS A NAME TYPED, NOT A BUTTON PRESSED ══════════════════
 *
 * §5.3 and ח40-10. A dialog with a button is dismissed by muscle memory; a
 * name has to be read off the correct column first, and that reading is the
 * whole mechanism. The name is checked against the SURVIVING profile, so
 * somebody who has the two columns the wrong way round finds out here rather
 * than after four bookings have moved.
 *
 * ══ WHAT THIS SCREEN DOES NOT OFFER ═════════════════════════════════════════
 *
 * There is no selector for marketing consent, blocking, tags or notes. Those
 * four are decided by rule inside `guest_merge_apply` — refusal wins on
 * consent, the block wins on blocking, tags are unioned, notes are
 * concatenated — and an option that is going to be ignored is worse than no
 * option: it teaches somebody that they chose something.
 *
 * There is also nothing here about a date of birth, an identity document or an
 * address. The merge never reads them, never copies them and never records
 * them, so there is nothing to choose. The merged profile keeps its own,
 * because it is soft-deleted rather than erased.
 *
 * ══ THE COUNTERS ARE NOT ESTIMATED ══════════════════════════════════════════
 *
 * "4 bookings · 2 conversations will move to…" comes from the server, counted
 * from the rows themselves. Where a count could not be read — the reader lacks
 * the grant for that table — it is reported absent with the reason rather than
 * shown as zero. A zero that means "you may not see this" is the worst
 * possible number to put next to an irreversible-feeling action.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { mergeGuestsAction } from '@/app/(app)/guests/merge/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import {
  MERGE_FIELD_LABEL,
  MERGE_REASON_MIN,
  problemsWithMerge,
  type MergeChoices,
  type MergeConflict,
  type MergeSide,
} from '@/lib/leads/merge'

export interface MergeSideView {
  id: string
  fullName: string
  version: number
}

/** A count, or the reason it could not be read. Never a zero standing in. */
export type MovingCount =
  | { kind: 'known'; label: string; count: number }
  | { kind: 'withheld'; label: string; grant: string }

export function MergeForm({
  survivor,
  merged,
  conflicts,
  moving,
}: {
  survivor: MergeSideView
  merged: MergeSideView
  conflicts: readonly MergeConflict[]
  moving: readonly MovingCount[]
}) {
  const router = useRouter()
  const run = useAsyncAction<void>()

  const [choices, setChoices] = useState<MergeChoices>({})
  const [reason, setReason] = useState('')
  const [typedName, setTypedName] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const problems = problemsWithMerge({
    survivorId: survivor.id,
    mergedId: merged.id,
    reason,
    typedSurvivorName: typedName,
    survivorName: survivor.fullName,
  })

  const problemFor = (field: string) =>
    touched
      ? problems.find((problem) => problem.field === field)?.message
      : undefined

  const pick = (field: MergeConflict['field'], side: MergeSide) =>
    setChoices((current) => ({ ...current, [field]: side }))

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (problems.length > 0 || run.pending) return

        setFailure(null)
        void run.run(async () => {
          const result = await mergeGuestsAction({
            survivorGuestId: survivor.id,
            mergedGuestId: merged.id,
            survivorVersion: survivor.version,
            mergedVersion: merged.version,
            typedSurvivorName: typedName,
            reason,
            choices,
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }
          router.push(`/guests/${survivor.id}`)
          router.refresh()
        })
      }}
    >
      {/* ------------------------------------------------------- counters -- */}
      <section className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <p className="font-semibold text-foreground">
          מה יעבור אל ״{survivor.fullName}״
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {moving.map((item) => (
            <li key={item.label}>
              {item.kind === 'known' ? (
                <>
                  <span className="tabular-nums font-semibold text-foreground">
                    {item.count}
                  </span>{' '}
                  {item.label}
                </>
              ) : (
                <>
                  {item.label}: לא ניתן לספור בהרשאות שלך ({item.grant})
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          הפרופיל שמוזג לא נמחק. הוא מסומן כמוזג, מצביע על הפרופיל השורד, ושומר
          את כל מה שהמיזוג לא מעתיק — תאריך לידה, מסמך מזהה וכתובת.
        </p>
      </section>

      {/* ------------------------------------------------------ conflicts -- */}
      {conflicts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          אין שדה שסותר בין שני הפרופילים, ולכן אין מה להכריע. כל מה שיקרה הוא
          העברת ההיסטוריה.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {conflicts.map((conflict) => {
            const chosen = choices[conflict.field] ?? 'survivor'
            return (
              <fieldset
                key={conflict.field}
                className="flex flex-col gap-2 rounded-lg border border-border p-4"
              >
                <legend className="px-1 text-sm font-medium text-foreground">
                  {MERGE_FIELD_LABEL[conflict.field]}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ChoiceButton
                    active={chosen === 'survivor'}
                    onSelect={() => pick(conflict.field, 'survivor')}
                    heading={survivor.fullName}
                    value={conflict.survivorValue}
                  />
                  <ChoiceButton
                    active={chosen === 'merged'}
                    onSelect={() => pick(conflict.field, 'merged')}
                    heading={merged.fullName}
                    value={conflict.mergedValue}
                  />
                </div>
              </fieldset>
            )
          })}
        </div>
      )}

      {/* ----------------------------------------------------- confirming -- */}
      <Field
        label="למה מיזגת"
        description={`לפחות ${MERGE_REASON_MIN} תווים. מישהו יקרא את זה בעוד חודשיים וינסה להבין מה קרה כאן.`}
        required
        error={problemFor('reason')}
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>

      <Field
        label="אישור"
        description={`הקלד את שם האורח שיישאר: ${survivor.fullName}`}
        required
        error={problemFor('typedSurvivorName')}
      >
        <TextInput
          value={typedName}
          onChange={(event) => setTypedName(event.target.value)}
          autoComplete="off"
        />
      </Field>

      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={run.pending || (touched && problems.length > 0)}
        >
          {run.pending ? 'ממזג…' : 'מזג פרופילים'}
        </Button>
        <Button href="/guests/merge" variant="ghost">
          ביטול
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        אפשר לבטל את המיזוג בתוך 30 יום, והביטול מחזיר בדיוק את השורות שהועברו.
        אם רשומה שהועברה נערכה מאז — הביטול ייעצר ויפרט מה השתנה, במקום למחוק את
        העבודה הזאת.
      </p>
    </form>
  )
}

function ChoiceButton({
  active,
  onSelect,
  heading,
  value,
}: {
  active: boolean
  onSelect: () => void
  heading: string
  value: string | null
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        'flex flex-col gap-1 rounded-lg border p-3 text-start text-sm ' +
        (active
          ? 'border-primary bg-accent-soft text-accent-foreground'
          : 'border-border bg-surface text-foreground hover:border-border-strong')
      }
    >
      <span className="text-xs text-muted-foreground">{heading}</span>
      <span className="font-medium" dir="auto">
        {/* An absence is named. A blank cell reads as "we did not load this". */}
        {value ?? '— אין ערך —'}
      </span>
    </button>
  )
}
