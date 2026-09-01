'use client'

/**
 * The organization's collection policy, edited.
 *
 * ── This screen is for somebody who takes no cards ────────────────────────
 *
 * That person is the majority, so the form is not a payments integration with
 * the integration missing. Live processing is one switch near the bottom, off
 * by default, and everything above it works without it: what is asked of a
 * guest, how much, and by when.
 *
 * The deposit fields appear only when the chosen policy actually wants money,
 * because a percentage box under "ללא תשלום מראש" is a question nobody can
 * answer.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  saveCollectionPolicyAction,
  type CollectionPolicyInput,
} from '@/app/(app)/settings/payments/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, Textarea, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import { fieldErrorsFrom } from '@/components/onboarding/field-errors'
import {
  CONFIRMATION_REQUIREMENTS,
  PAYMENT_COLLECTION_POLICIES,
  type ConfirmationRequirement,
  type PaymentCollectionPolicy,
} from '@/lib/contracts/states'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
// Leaf modules, never the `@/lib/payments` barrel — see the note in
// `manual-channels-form.tsx`. The barrel reaches the `postgres` driver.
import {
  COLLECTION_POLICY_DESCRIPTION,
  COLLECTION_POLICY_LABEL,
  REQUIREMENT_DESCRIPTION,
  REQUIREMENT_LABEL,
} from '@/lib/payments/resolver'
import type { CollectionSettings } from '@/lib/payments/types'

/** Policies that ask a guest for money before the booking is confirmed. */
const WANTS_MONEY: readonly PaymentCollectionPolicy[] = [
  'manual',
  'deposit',
  'schedule',
]

type DepositShape = 'percent' | 'fixed'

export function CollectionPolicyForm({
  initial,
}: {
  /** `null` when nothing was ever saved. Not an error, and not a prompt. */
  initial: CollectionSettings | null
}) {
  const router = useRouter()

  const [policy, setPolicy] = useState<PaymentCollectionPolicy>(
    initial?.policy ?? 'none',
  )
  const [requirements, setRequirements] = useState<
    readonly ConfirmationRequirement[]
  >(initial?.requirements ?? [])
  const [shape, setShape] = useState<DepositShape>(
    initial?.depositFixedAgorot !== null &&
      initial?.depositFixedAgorot !== undefined
      ? 'fixed'
      : 'percent',
  )
  const [percent, setPercent] = useState(
    initial?.depositPercentBps === null ||
      initial?.depositPercentBps === undefined
      ? ''
      : String(initial.depositPercentBps / 100),
  )
  const [fixedShekels, setFixedShekels] = useState(
    initial?.depositFixedAgorot === null ||
      initial?.depositFixedAgorot === undefined
      ? ''
      : String(initial.depositFixedAgorot / 100),
  )
  const [dueDays, setDueDays] = useState(
    initial?.balanceDueDaysBefore === null ||
      initial?.balanceDueDaysBefore === undefined
      ? ''
      : String(initial.balanceDueDaysBefore),
  )
  const [liveEnabled, setLiveEnabled] = useState(
    initial?.livePaymentsEnabled ?? false,
  )
  const [liveProvider, setLiveProvider] = useState(initial?.liveProvider ?? '')
  const [instructions, setInstructions] = useState(
    initial?.guestInstructions ?? '',
  )

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)

  const save = useAsyncAction<void>()
  const errors = fieldErrorsFrom(failure)

  const asksForMoney =
    WANTS_MONEY.includes(policy) ||
    requirements.includes('deposit_recorded') ||
    requirements.includes('deposit_paid_live')

  function toggleRequirement(requirement: ConfirmationRequirement) {
    setRequirements((current) =>
      current.includes(requirement)
        ? current.filter((entry) => entry !== requirement)
        : [...current, requirement],
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setFailure(null)
        setSaved(false)
        if (save.pending) return

        const percentBps =
          asksForMoney && shape === 'percent' && percent.trim().length > 0
            ? Math.round(Number(percent) * 100)
            : null
        const fixedAgorot =
          asksForMoney && shape === 'fixed' && fixedShekels.trim().length > 0
            ? Math.round(Number(fixedShekels) * 100)
            : null

        const input: CollectionPolicyInput = {
          policy,
          requirements,
          depositPercentBps: percentBps,
          depositFixedAgorot: fixedAgorot,
          balanceDueDaysBefore:
            dueDays.trim().length > 0 ? Number.parseInt(dueDays, 10) : null,
          livePaymentsEnabled: liveEnabled,
          liveProvider:
            liveProvider.trim().length > 0 ? liveProvider.trim() : null,
          guestInstructions:
            instructions.trim().length > 0 ? instructions.trim() : null,
          // One key per submission, so a double click is one save and a
          // deliberate second edit is a second one.
          idempotencyKey: crypto.randomUUID(),
        }

        void save.run(async () => {
          const result = await saveCollectionPolicyAction(input)
          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setSaved(true)
          router.refresh()
        })
      }}
      noValidate
    >
      {failure && <ActionError error={failure} />}

      <Field
        label="מה נדרש מהאורח לפני שההזמנה מאושרת"
        description={COLLECTION_POLICY_DESCRIPTION[policy]}
        error={errors.policy}
        required
      >
        <Select
          value={policy}
          onChange={(event) =>
            setPolicy(event.target.value as PaymentCollectionPolicy)
          }
          disabled={save.pending}
        >
          {PAYMENT_COLLECTION_POLICIES.map((option) => (
            <option key={option} value={option}>
              {COLLECTION_POLICY_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      {asksForMoney && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-muted p-4">
          <Field label="סכום המקדמה" error={errors.depositPercentBps}>
            <Select
              value={shape}
              onChange={(event) => setShape(event.target.value as DepositShape)}
              disabled={save.pending}
            >
              <option value="percent">אחוז מסכום ההזמנה</option>
              <option value="fixed">סכום קבוע בשקלים</option>
            </Select>
          </Field>

          {shape === 'percent' ? (
            <Field
              label="אחוז"
              description="למשל 30 עבור שלושים אחוז מסכום ההזמנה."
              error={errors.depositPercentBps}
            >
              <TextInput
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
                inputMode="decimal"
                dir="ltr"
                disabled={save.pending}
              />
            </Field>
          ) : (
            <Field
              label="סכום בשקלים"
              description="הסכום נשמר באגורות. אם הוא גדול מסכום ההזמנה, ייגבה סכום ההזמנה בלבד."
              error={errors.depositFixedAgorot}
            >
              <TextInput
                value={fixedShekels}
                onChange={(event) => setFixedShekels(event.target.value)}
                inputMode="decimal"
                dir="ltr"
                disabled={save.pending}
              />
            </Field>
          )}

          <Field
            label="כמה ימים לפני ההגעה נגבית היתרה"
            description="ריק פירושו שלא נקבע מועד."
            error={errors.balanceDueDaysBefore}
          >
            <TextInput
              value={dueDays}
              onChange={(event) => setDueDays(event.target.value)}
              inputMode="numeric"
              dir="ltr"
              disabled={save.pending}
            />
          </Field>
        </div>
      )}

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold text-foreground">
          דרישות נוספות לאישור
        </legend>
        <p className="text-sm text-muted-foreground">
          אפשר לבחור יותר מאחת. אם לא נבחרה אף אחת, ההזמנה מאושרת על ידי הצוות
          בלבד — וזו תשובה מלאה.
        </p>
        {CONFIRMATION_REQUIREMENTS.map((requirement) => (
          <Checkbox
            key={requirement}
            label={REQUIREMENT_LABEL[requirement]}
            description={REQUIREMENT_DESCRIPTION[requirement]}
            checked={requirements.includes(requirement)}
            onChange={() => toggleRequirement(requirement)}
            disabled={save.pending}
          />
        ))}
      </fieldset>

      <Field
        label="הודעה לאורח"
        description="מופיעה בעמוד האורח מעל הפעולה שנדרשת ממנו."
        error={errors.guestInstructions}
      >
        <Textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={2000}
          disabled={save.pending}
        />
      </Field>

      <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <Checkbox
          label="הפעל סליקה מקוונת"
          description="כבוי פירושו שהאורח לעולם לא יראה כפתור תשלום. זו ההגדרה הנפוצה, ואין בה שום דבר חסר."
          checked={liveEnabled}
          onChange={(event) => setLiveEnabled(event.target.checked)}
          disabled={save.pending}
        />

        {liveEnabled && (
          <Field
            label="ספק הסליקה"
            description="שם הספק בלבד. מפתחות וסודות אינם נשמרים כאן ולעולם לא יופיעו במסך הזה."
            error={errors.liveProvider}
            required
          >
            <TextInput
              value={liveProvider}
              onChange={(event) => setLiveProvider(event.target.value)}
              dir="ltr"
              maxLength={60}
              disabled={save.pending}
            />
          </Field>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.pending}>
          {save.pending ? 'שומר…' : 'שמור מדיניות'}
        </Button>
        {saved && (
          <span role="status" className="text-sm text-muted-foreground">
            נשמר.
          </span>
        )}
      </div>
    </form>
  )
}
