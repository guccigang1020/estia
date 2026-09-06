'use client'

/**
 * THE CODE ITSELF, ON ITS OWN FORM.
 *
 * ══ WHY THIS IS NOT A FIELD ON THE ENTRY FORM ══════════════════════════════
 *
 * If it were, every ordinary edit to the pool hours would carry the door code
 * through the request body, through validation, into the audit diff and into
 * whatever logs the request. It is a different form, a different Server Action
 * and a different audit line — and that line records that a code changed and
 * never what it changed to.
 *
 * ══ IT NEVER SHOWS THE CURRENT VALUE, AND CANNOT ═══════════════════════════
 *
 * The field starts empty every time, for the person who set it as much as for
 * anybody else. That is not caution in this component: `guide_entry_secrets`
 * grants `select (entry_id)` and nothing more, so PostgREST refuses to read
 * the value at all. Nothing on the server ever had it to pass down.
 *
 * The product consequence is stated on the form rather than discovered:
 * rotating a code means typing the new one, which is what rotating a door code
 * means anyway. What it buys is that a compromised session cannot read back
 * the codes of every property it can see.
 *
 * ── Clearing is a real action ─────────────────────────────────────────────
 *
 * A separate button, because "delete the code" and "leave it alone" are
 * different intentions and a form that treated an empty field as either one
 * would silently do the wrong thing about half the time.
 */

import { useState } from 'react'

import { setGuideSecretAction } from '@/app/(app)/settings/guest-guide/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { RELEASE_MODE_LABEL } from '@/lib/guest-guide/labels'
import type { GuideReleaseRule } from '@/lib/guest-guide/types'

export function SecretForm({
  propertyId,
  entryId,
  entryTitle,
  release,
  isSet,
}: {
  propertyId: string
  entryId: string
  entryTitle: string
  /** The entry's own rule. The secret has none — see `types.ts`. */
  release: GuideReleaseRule
  /** Whether a value exists. Never the value. */
  isSet: boolean
}) {
  const [value, setValue] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [outcome, setOutcome] = useState<'saved' | 'cleared' | null>(null)
  const action = useAsyncAction<void>()

  function submit(next: string | null) {
    if (action.pending) return
    setFailure(null)
    setOutcome(null)

    void action.run(async () => {
      const result = await setGuideSecretAction({
        propertyId,
        entryId,
        value: next === null ? null : { he: next },
        idempotencyKey: crypto.randomUUID(),
      })

      if (!result.ok) {
        setFailure(result.error)
        return
      }
      setValue('')
      setOutcome(result.data.set ? 'saved' : 'cleared')
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-strong bg-accent-soft p-4 text-accent-foreground">
      {failure && <ActionError error={failure} />}

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">קוד או סוד · {entryTitle}</h4>
        <p className="text-sm">
          {isSet ? 'קיים ערך שמור.' : 'עדיין לא הוזן ערך.'} הוא ייחשף לאורח{' '}
          {RELEASE_MODE_LABEL[release.mode]}
          {release.mode === 'hours_before' ? ` (${release.hours} שעות)` : ''}.
        </p>
        <p className="text-xs">
          הערך השמור לעולם אינו מוצג כאן — גם לא למי שהזין אותו. החלפת קוד היא
          הקלדה של הקוד החדש.
        </p>
      </div>

      <Field
        label="ערך חדש"
        description="קוד דלת, קוד אזעקה, מיקום תיבת מפתחות או סיסמת רשת."
      >
        <TextInput
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={200}
          autoComplete="off"
          // Not `type="password"`: the person typing it is the person who
          // chose it and needs to see it. The masking that matters happened
          // at the database, not at the input.
          spellCheck={false}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={value.trim().length === 0 || action.pending}
          onClick={() => submit(value.trim())}
        >
          {action.pending ? 'שומר…' : 'שמור ערך'}
        </Button>

        {isSet && (
          <Button
            type="button"
            variant="danger"
            disabled={action.pending}
            onClick={() => submit(null)}
          >
            מחק את הערך
          </Button>
        )}

        {outcome === 'saved' && <span className="text-sm">נשמר.</span>}
        {outcome === 'cleared' && (
          <span className="text-sm">
            נמחק. אורח שיעמוד בתנאים יראה כותרת בלי תוכן עד שיוזן ערך חדש.
          </span>
        )}
      </div>
    </div>
  )
}
