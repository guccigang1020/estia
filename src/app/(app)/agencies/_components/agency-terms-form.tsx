'use client'

/**
 * The commission this agency earns.
 *
 * ── It writes the deal in two places, and the screen says so ──────────────
 *
 * `agency_agreements.rule` is the commercial document — it is what the card
 * above renders. `agent_commission_rules` is the row `selectCommissionRule`
 * resolves when a booking is priced; nothing in the product reads the
 * agreement's rule to compute money. `agency.set_terms` writes both in one
 * operation for that reason, and there is no other path to either, which is
 * what keeps them from disagreeing. Saying it here as well, because somebody
 * looking for "where is the rate set" needs to find one answer.
 *
 * ── The reason is collected before the round trip ─────────────────────────
 *
 * `agent_agreement.manage` is in `SENSITIVE_ACTIONS`, so the server refuses a
 * blank reason whatever this form does. The field is here so the person is
 * asked first rather than after a rejected submit — and "why did our rate with
 * this agency change in April" is read months later by somebody settling an
 * argument about money.
 *
 * ── What it does not offer, and why ───────────────────────────────────────
 *
 * Four of the six commission bases and the `tiered` rule kind are absent. The
 * reasons are in `terms-vocabulary.ts`; both are stated to the reader rather
 * than hidden, and an agreement already holding one keeps it.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput, Textarea } from '@/components/ui/input'
import {
  COMMISSION_CONDITIONS,
  COMMISSION_CONDITION_LABEL,
  type CommissionCondition,
  type CommissionRuleInput,
} from '@/lib/agents'
import {
  COMMISSION_BASE_LABEL,
  type CommissionBase,
} from '@/lib/contracts/states'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { setAgencyTermsAction } from '../_lib/actions'
import {
  TERMS_BASES,
  TERMS_RULE_KINDS,
  TERMS_RULE_KIND_LABEL,
  type TermsRuleKind,
} from './terms-vocabulary'

export type TermsFormValues = {
  kind: string
  percent: number | null
  amountAgorot: number | null
  base: CommissionBase
  eligibility: readonly CommissionCondition[]
  activeFrom: string
  activeUntil: string | null
  paymentTermsDays: number
  note: string | null
}

export function AgencyTermsForm({
  agencyId,
  agencyName,
  version,
  initial,
}: {
  agencyId: string
  agencyName: string
  /** The **agreement's** version. The agency's would lock the wrong row. */
  version: number
  initial: TermsFormValues
}) {
  const router = useRouter()

  const tiered = initial.kind === 'tiered'
  const [kind, setKind] = useState<TermsRuleKind>(
    isBuildable(initial.kind) ? initial.kind : 'percentage',
  )
  const [percent, setPercent] = useState(
    initial.percent === null ? '' : String(initial.percent),
  )
  const [shekels, setShekels] = useState(
    initial.amountAgorot === null ? '' : String(initial.amountAgorot / 100),
  )
  const [base, setBase] = useState<CommissionBase>(initial.base)
  const [eligibility, setEligibility] = useState<
    readonly CommissionCondition[]
  >(initial.eligibility)
  const [activeFrom, setActiveFrom] = useState(initial.activeFrom)
  const [activeUntil, setActiveUntil] = useState(initial.activeUntil ?? '')
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    String(initial.paymentTermsDays),
  )
  const [note, setNote] = useState(initial.note ?? '')
  const [reason, setReason] = useState('')

  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reasonTooShort = reason.trim().length < 8
  const baseUncomputable = !TERMS_BASES.includes(initial.base)

  function toggle(condition: CommissionCondition): void {
    setEligibility((current) =>
      current.includes(condition)
        ? current.filter((value) => value !== condition)
        : [...current, condition],
    )
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (reasonTooShort || busy) return

    setBusy(true)
    setFailure(null)
    setDone(null)

    const result = await setAgencyTermsAction({
      agencyId,
      version,
      reason: reason.trim(),
      rule: ruleFrom(kind, percent, shekels),
      base,
      eligibility,
      activeFrom,
      activeUntil: activeUntil.trim() === '' ? null : activeUntil,
      paymentTermsDays: Number(paymentTermsDays),
      note: note.trim() === '' ? null : note.trim(),
    })

    setBusy(false)

    if (!result.ok) {
      setFailure(result.error)
      return
    }

    setDone(
      `התנאים של ${agencyName} עודכנו — גם במסמך ההסכם וגם בכלל העמלה שממנו מחושב הכסף. עמלות שכבר נרשמו אינן משתנות: הן חושבו לפי התנאים כפי שהיו באותו יום.`,
    )
    setReason('')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {tiered && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          להסכם הזה עמלה מדורגת. הטופס הזה אינו בונה מדרגות, ושמירה כאן תחליף
          אותן בעמלה פשוטה. אם זו לא הכוונה — אל תשמור.
        </p>
      )}

      {baseUncomputable && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          בסיס החישוב השמור הוא &quot;{COMMISSION_BASE_LABEL[initial.base]}
          &quot;, ומנוע העמלות אינו יודע לחשב אותו משורות המחיר של הזמנה. שמירה
          כאן תעביר את ההסכם לאחד משני הבסיסים שהוא כן יודע לחשב, וזה ישנה את מה
          שהסוכנות מרוויחה.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="סוג העמלה">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as TermsRuleKind)}
          >
            {TERMS_RULE_KINDS.map((value) => (
              <option key={value} value={value}>
                {TERMS_RULE_KIND_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'percentage' && (
          <Field label="אחוז">
            <TextInput
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
              inputMode="decimal"
              dir="ltr"
            />
          </Field>
        )}

        {kind === 'fixed' && (
          <Field label="סכום בשקלים" description="נשמר באגורות שלמות.">
            <TextInput
              value={shekels}
              onChange={(event) => setShekels(event.target.value)}
              inputMode="decimal"
              dir="ltr"
            />
          </Field>
        )}

        <Field
          label="בסיס חישוב"
          description='"עשרה אחוז" בלי בסיס מוצהר הם שני מספרים שונים ששני אנשים חושבים שהסכימו עליהם.'
        >
          <Select
            value={base}
            onChange={(event) => setBase(event.target.value as CommissionBase)}
          >
            {TERMS_BASES.map((value) => (
              <option key={value} value={value}>
                {COMMISSION_BASE_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium text-foreground">
          מתי העמלה הופכת לחוב
        </legend>
        <p className="text-xs text-muted-foreground">
          עמלה נרשמת עם ההזמנה והיא הבטחה, לא חוב, עד שהתנאים כאן מתקיימים. בלי
          אף תנאי היא זכאית מיד — כלומר תשלום על שהיות שאולי לא יתקיימו.
        </p>
        {COMMISSION_CONDITIONS.map((condition) => (
          <Checkbox
            key={condition}
            label={COMMISSION_CONDITION_LABEL[condition]}
            checked={eligibility.includes(condition)}
            onChange={() => toggle(condition)}
          />
        ))}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="בתוקף מ־">
          <TextInput
            type="date"
            value={activeFrom}
            onChange={(event) => setActiveFrom(event.target.value)}
            dir="ltr"
          />
        </Field>

        <Field label="בתוקף עד" description="ריק — ללא תאריך סיום.">
          <TextInput
            type="date"
            value={activeUntil}
            onChange={(event) => setActiveUntil(event.target.value)}
            dir="ltr"
          />
        </Field>

        <Field label="ימי תשלום" description="מאישור העמלה ועד התשלום בפועל.">
          <TextInput
            value={paymentTermsDays}
            onChange={(event) => setPaymentTermsDays(event.target.value)}
            inputMode="numeric"
            dir="ltr"
          />
        </Field>
      </div>

      <Field label="הערה להסכם">
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
        />
      </Field>

      <Field
        label="נימוק"
        required
        description="נשמר ביומן הביקורת. שינוי תנאי עמלה הוא שינוי במחיר של כל מכירה עתידית, ולכן הוא מחייב הסבר."
        error={
          reason !== '' && reasonTooShort
            ? 'נדרש נימוק של שמונה תווים לפחות.'
            : undefined
        }
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          placeholder="למשל: סוכם בשיחה עם מנהל הסוכנות על הורדה ל-8% מהרבעון הבא"
        />
      </Field>

      {failure && <ActionError error={failure} />}

      {done && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          {done}
        </p>
      )}

      <div>
        <Button type="submit" disabled={reasonTooShort || busy}>
          {busy ? 'שומר…' : 'שמור תנאים'}
        </Button>
      </div>
    </form>
  )
}

function isBuildable(kind: string): kind is TermsRuleKind {
  return (TERMS_RULE_KINDS as readonly string[]).includes(kind)
}

/**
 * The form's fields as the operation's rule input.
 *
 * Shekels become agorot here, through `Math.round`, because money is an integer
 * of agorot everywhere in this product and `52.005` shekels is not a price
 * anybody can pay. The server rebuilds the union and refuses a percentage with
 * no percentage — this only shapes what it is asked.
 */
function ruleFrom(
  kind: TermsRuleKind,
  percent: string,
  shekels: string,
): CommissionRuleInput {
  switch (kind) {
    case 'none':
      return { kind: 'none' }
    case 'percentage':
      return { kind: 'percentage', percent: Number(percent) }
    case 'fixed':
      return { kind: 'fixed', amountAgorot: Math.round(Number(shekels) * 100) }
  }
}
