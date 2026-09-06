'use client'

/**
 * The decision flow: a person, a ground, a sentence and four amounts.
 *
 * ══ WHAT THIS FORM DELIBERATELY DOES NOT DO ════════════════════════════════
 *
 * It does not suggest an outcome. It does not pre-fill the guest's share from
 * the inspection differences, it does not pre-select "the guest is
 * responsible" because two photographs are unlike each other, and there is no
 * "recommended" anything on it. The whole module is built so that a comparison
 * cannot assert liability — `LIABILITY_BASES` has no value meaning
 * "automatic", and `evaluateLiability` refuses a decider that is not a person
 * — and a form that pre-filled a verdict would defeat all of it by making the
 * default the answer. The only thing filled in advance is the *assessed
 * amount*, which is arithmetic on the case's own cost lines and is not a claim
 * about anybody.
 *
 * ── Why the reasoning field is not optional and not short ─────────────────
 *
 * It becomes the operation's `reason`, which `requiresReason: true` makes
 * mandatory, and `evaluateLiability` refuses a blank one independently. It is
 * stored on the decision row and printed on the case for as long as the case
 * exists. Six months later, in a dispute, it is the only thing that says why.
 *
 * ── The allocation is checked while typing, and again on the server ───────
 *
 * `checkAllocation` is the same pure function the domain runs, imported from
 * the barrel — which is safe for a Client Component because it re-exports
 * neither the repository nor the operations. So the shortfall the reader sees
 * is the shortfall the server would refuse on, to the agora.
 *
 * ── And it moves no money ─────────────────────────────────────────────────
 *
 * Submitting records a decision. Applying it to a deposit is
 * `money_access_cancellation` and happens in the payments module under its own
 * grants. The note at the foot of the form says so, in those words.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { decideLiabilityAction } from '@/app/(app)/incidents/cases/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
import {
  LIABILITY_BASES,
  LIABILITY_BASIS_LABEL,
  LIABILITY_OUTCOMES,
  LIABILITY_OUTCOME_LABEL,
  MIN_RATIONALE_LENGTH,
  checkAllocation,
  type LiabilityBasis,
  type LiabilityOutcome,
} from '@/lib/incidents'
import { formatAgorot } from '@/lib/payments/resolver'

/** Shekels in the box, agorot on the wire. Never a float anywhere. */
function toAgorot(value: string): number {
  const shekels = Number.parseFloat(value.replace(',', '.'))
  if (!Number.isFinite(shekels)) return 0
  return Math.round(shekels * 100)
}

function toShekelField(agorot: number): string {
  return (agorot / 100).toFixed(2)
}

export function LiabilityDecisionForm({
  caseId,
  assessedAgorot,
  supersedesDecisionId,
  evidenceIds,
}: {
  caseId: string
  /** The case's own arithmetic. Not a suggestion about anybody. */
  assessedAgorot: number
  supersedesDecisionId: string | null
  evidenceIds: readonly string[]
}) {
  const router = useRouter()

  // No default outcome. The reader picks, or nothing is submitted.
  const [outcome, setOutcome] = useState<LiabilityOutcome | ''>('')
  const [basis, setBasis] = useState<LiabilityBasis | ''>('')
  const [rationale, setRationale] = useState('')
  const [assessed, setAssessed] = useState(toShekelField(assessedAgorot))
  const [guest, setGuest] = useState('0.00')
  const [owner, setOwner] = useState('0.00')
  const [absorbed, setAbsorbed] = useState(toShekelField(assessedAgorot))

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [touched, setTouched] = useState(false)
  const submit = useAsyncAction<void>()

  /** One key per form instance: a resubmission replays rather than re-decides. */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])

  const amounts = {
    assessedTotalAgorot: toAgorot(assessed),
    guestChargeAgorot: toAgorot(guest),
    ownerChargeAgorot: toAgorot(owner),
    businessAbsorbedAgorot: toAgorot(absorbed),
  }

  const allocation = checkAllocation(amounts)

  const issues: string[] = []
  if (outcome === '') issues.push('יש לבחור מה הוכרע.')
  if (basis === '') issues.push('יש לציין על סמך מה הוכרע.')
  if (rationale.trim().length < MIN_RATIONALE_LENGTH) {
    issues.push('יש לנמק את ההכרעה במשפט שאפשר יהיה לקרוא בעוד חצי שנה.')
  }
  if (!allocation.ok) {
    issues.push(
      allocation.differenceAgorot > 0
        ? `חולקו ${formatAgorot(allocation.differenceAgorot)} יותר מהסכום שנבחן.`
        : `חסרים ${formatAgorot(-allocation.differenceAgorot)} בחלוקה.`,
    )
  }
  if (
    amounts.guestChargeAgorot > 0 &&
    outcome !== 'guest_responsible' &&
    outcome !== 'shared'
  ) {
    issues.push('לא ניתן לחייב את האורח בהכרעה שאינה קובעת שהוא נושא בעלות.')
  }

  const ready = issues.length === 0

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (!ready || outcome === '' || basis === '') return

        void submit.run(async () => {
          setFailure(null)
          const result = await decideLiabilityAction({
            caseId,
            outcome,
            basis,
            rationale: rationale.trim(),
            ...amounts,
            supportingEvidenceIds: [...evidenceIds],
            supersedesDecisionId,
            idempotencyKey,
          })
          if (!result.ok) {
            setFailure(result.error)
            return
          }
          router.refresh()
        })
      }}
    >
      {failure && <ActionError error={failure} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="מה הוכרע" required>
          <Select
            value={outcome}
            onChange={(event) =>
              setOutcome(event.target.value as LiabilityOutcome | '')
            }
          >
            <option value="">בחר…</option>
            {LIABILITY_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {LIABILITY_OUTCOME_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="על סמך מה"
          required
          description="כל אפשרות כאן היא משהו שאדם עשה. השוואת תמונות אינה אחת מהן — היא ראיה שאדם שוקל."
        >
          <Select
            value={basis}
            onChange={(event) =>
              setBasis(event.target.value as LiabilityBasis | '')
            }
          >
            <option value="">בחר…</option>
            {LIABILITY_BASES.map((value) => (
              <option key={value} value={value}>
                {LIABILITY_BASIS_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="הנימוק"
        required
        description="מה נבדק, מה נמצא ולמה הוכרע כך. זה הטקסט שיקרא מי שיתמודד עם מחלוקת בעוד חצי שנה."
      >
        <Textarea
          rows={4}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
        />
      </Field>

      <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium text-foreground">
          חלוקת הסכום (בשקלים)
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="הסכום שנבחן"
            description="מחושב משורות העלות של התיק. אפשר לשנות, וההפרש ייבדק."
          >
            <TextInput
              inputMode="decimal"
              value={assessed}
              onChange={(event) => setAssessed(event.target.value)}
            />
          </Field>
          <Field label="על האורח">
            <TextInput
              inputMode="decimal"
              value={guest}
              onChange={(event) => setGuest(event.target.value)}
            />
          </Field>
          <Field label="על הבעלים">
            <TextInput
              inputMode="decimal"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
            />
          </Field>
          <Field label="נספג על ידי העסק">
            <TextInput
              inputMode="decimal"
              value={absorbed}
              onChange={(event) => setAbsorbed(event.target.value)}
            />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          שלושת הסכומים חייבים להסתכם בדיוק בסכום שנבחן. הכל נשמר באגורות שלמות.
        </p>
      </fieldset>

      {touched && issues.length > 0 && (
        <ul
          role="alert"
          className="flex list-disc flex-col gap-1 rounded-lg border border-danger bg-surface px-6 py-3 text-sm text-foreground"
        >
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submit.pending}>
          {submit.pending ? 'רושם את ההכרעה…' : 'רשום את ההכרעה'}
        </Button>
        <p className="text-xs text-muted-foreground">
          ההכרעה נרשמת על שמך. היא אינה גובה כסף ואינה נוגעת בפיקדון — חיוב
          פיקדון או גבייה נוספת מתבצעים במסלול התשלומים ובהרשאות שלו.
        </p>
      </div>
    </form>
  )
}
