'use client'

/**
 * Writing down a cost the business carries.
 *
 * ── The form asks which of two things this is, first ──────────────────────
 *
 * A fixed cost belongs to a period and has an amount; a variable cost is caused
 * by the stay and has a formula. They are not two flavours of one thing, and a
 * form that offered both an amount and a formula at once would let somebody
 * submit a rule the database refuses — `expense_rules_formula_pair` requires
 * `(kind = 'variable') = (formula is not null)`. So the choice comes first and
 * the fields below it change, which is the same constraint expressed as a
 * screen instead of as an error.
 *
 * ── Money is typed in shekels and sent in agorot ──────────────────────────
 *
 * Nobody types "310000" for ₪3,100. The one conversion in this file happens at
 * the moment of submission, with `Math.round`, and it is the only place in the
 * finance directory that multiplies by 100 — because it is the border between
 * what a person types and what the system stores. Everything the server sees is
 * an integer, and `s.agorot` refuses it if it is not.
 *
 * ── Duplicate submission, both halves ─────────────────────────────────────
 *
 * `useAsyncAction` refuses a second run synchronously, which covers the double
 * click. The rule's id — generated once per form instance and used as the
 * idempotency key as well — covers what a disabled button cannot: a retry after
 * a timeout, a resubmitted request, a flaky connection. The second request
 * replays the first answer instead of writing a second rule.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createExpenseRuleAction } from '@/app/(app)/finance/_lib/actions'
import {
  ALLOCATION_METHOD_LABEL,
  EXPENSE_FREQUENCY_LABEL,
  EXPENSE_KIND_LABEL,
  VARIABLE_FORMULA_LABEL,
} from '@/app/(app)/finance/_lib/labels'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import {
  ALLOCATION_METHODS,
  EXPENSE_FREQUENCIES,
  EXPENSE_KINDS,
  type AllocationMethod,
  type ExpenseFrequency,
  type ExpenseKind,
  type VariableFormula,
} from '@/lib/finance'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

/** The property picker's options. Empty means the organization has none in scope. */
export type ExpenseProperty = { id: string; name: string }

const FORMULA_KINDS = [
  'per_night',
  'per_guest_night',
  'per_booking',
  'per_guest',
  'percent_of_revenue',
] as const satisfies readonly VariableFormula['kind'][]

/**
 * A fixed rule that recurs is prorated over the period it is read for, so
 * `one_time` is offered but is not the default — a monthly cost typed as
 * one-off would be counted once and never again.
 */
const DEFAULT_FREQUENCY: ExpenseFrequency = 'monthly'

export function CreateExpenseForm({
  properties,
}: {
  properties: readonly ExpenseProperty[]
}) {
  const router = useRouter()

  const [label, setLabel] = useState('')
  const [category, setCategory] = useState('')
  const [kind, setKind] = useState<ExpenseKind>('fixed')
  const [frequency, setFrequency] =
    useState<ExpenseFrequency>(DEFAULT_FREQUENCY)
  const [amount, setAmount] = useState('')
  const [allocation, setAllocation] = useState<AllocationMethod>('per_booking')
  const [propertyId, setPropertyId] = useState('')
  const [formulaKind, setFormulaKind] =
    useState<VariableFormula['kind']>('per_night')
  const [rate, setRate] = useState('')
  const [percent, setPercent] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today())
  const [approvalRequired, setApprovalRequired] = useState(false)

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [touched, setTouched] = useState(false)

  const create = useAsyncAction<void>()

  /**
   * One id for the life of this form instance. Regenerated only when the
   * component remounts — which is what makes a resubmission of *this* rule a
   * replay, while a genuinely new rule gets a new id.
   */
  const ruleId = useMemo(() => crypto.randomUUID(), [])

  const amountAgorot = toAgorot(amount)
  const rateAgorot = toAgorot(rate)
  const percentValue = Number.parseFloat(percent)

  const issues = validate({
    label,
    category,
    kind,
    amountAgorot,
    formulaKind,
    rateAgorot,
    percentValue,
    effectiveFrom,
  })
  const ready = issues.length === 0

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (!ready || create.pending) return

        setFailure(null)
        void create.run(async () => {
          const formula: VariableFormula | null =
            kind !== 'variable'
              ? null
              : formulaKind === 'percent_of_revenue'
                ? { kind: 'percent_of_revenue', percent: percentValue }
                : { kind: formulaKind, rateAgorot: rateAgorot ?? 0 }

          const result = await createExpenseRuleAction({
            ruleId,
            idempotencyKey: ruleId,
            label: label.trim(),
            category: category.trim(),
            kind,
            frequency: kind === 'variable' ? 'one_time' : frequency,
            amountAgorot: kind === 'variable' ? 0 : (amountAgorot ?? 0),
            allocation,
            propertyId: propertyId.length > 0 ? propertyId : null,
            formula,
            effectiveFrom,
            // Deliberately not offered. A rule is written down because it is in
            // force; ending one is an edit, and an end date typed at creation
            // is a rule that silently stops working on a day nobody remembers.
            effectiveTo: null,
            approvalRequired,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          // Straight back to the list, where the new rule is now a row. A
          // "saved" toast on the form leaves the person wondering where it went.
          router.push('/finance/expenses')
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="שם ההוצאה"
          description="איך היא תיקרא בדוחות. לדוגמה: ״ניקיון יחידה״."
          required
          error={
            touched && label.trim().length < 2
              ? 'שם ההוצאה חייב להכיל לפחות שני תווים.'
              : undefined
          }
        >
          <TextInput
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="קטגוריה"
          description="לדוגמה: תפעול, תשתיות, מיסים."
          required
          error={
            touched && category.trim().length < 2
              ? 'הקטגוריה חייבת להכיל לפחות שני תווים.'
              : undefined
          }
        >
          <TextInput
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="סוג ההוצאה"
          description="קבועה קיימת גם אם אף אחד לא הגיע. משתנה נגרמת על ידי השהות עצמה."
          required
          className="sm:col-span-2"
        >
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as ExpenseKind)}
          >
            {EXPENSE_KINDS.map((option) => (
              <option key={option} value={option}>
                {EXPENSE_KIND_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'fixed' ? (
          <>
            <Field
              label="סכום לתקופה (₪)"
              description="הסכום לתקופה אחת. חישוב לתקופה חלקית נעשה בשרת לפי אורך החודש האמיתי."
              required
              error={
                touched && (amountAgorot === null || amountAgorot <= 0)
                  ? 'הוצאה קבועה חייבת סכום גדול מאפס.'
                  : undefined
              }
            >
              <TextInput
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>

            <Field label="תדירות" required>
              <Select
                value={frequency}
                onChange={(event) =>
                  setFrequency(event.target.value as ExpenseFrequency)
                }
              >
                {EXPENSE_FREQUENCIES.map((option) => (
                  <option key={option} value={option}>
                    {EXPENSE_FREQUENCY_LABEL[option]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <>
            <Field
              label="נוסחה"
              description="חמש נוסחאות סגורות. אין שדה שמקבל ביטוי חופשי — ביטוי שמורץ בזמן אמת הוא חור אבטחה בתחפושת של גיליון."
              required
            >
              <Select
                value={formulaKind}
                onChange={(event) =>
                  setFormulaKind(event.target.value as VariableFormula['kind'])
                }
              >
                {FORMULA_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {VARIABLE_FORMULA_LABEL[option]}
                  </option>
                ))}
              </Select>
            </Field>

            {formulaKind === 'percent_of_revenue' ? (
              <Field
                label="אחוז מההכנסה נטו"
                required
                error={
                  touched &&
                  (Number.isNaN(percentValue) ||
                    percentValue <= 0 ||
                    percentValue > 100)
                    ? 'האחוז חייב להיות בין 0 ל-100.'
                    : undefined
                }
              >
                <TextInput
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.01"
                  value={percent}
                  onChange={(event) => setPercent(event.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="תעריף (₪)"
                required
                error={
                  touched && (rateAgorot === null || rateAgorot <= 0)
                    ? 'התעריף חייב להיות גדול מאפס.'
                    : undefined
                }
              >
                <TextInput
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={rate}
                  onChange={(event) => setRate(event.target.value)}
                />
              </Field>
            )}
          </>
        )}

        <Field
          label="שיטת ייחוס להזמנות"
          description="השיטה קובעת אילו הזמנות ייראו רווחיות, ולכן היא החלטה עסקית ולא עיגול."
          required
          className="sm:col-span-2"
        >
          <Select
            value={allocation}
            onChange={(event) =>
              setAllocation(event.target.value as AllocationMethod)
            }
          >
            {ALLOCATION_METHODS.map((option) => (
              <option key={option} value={option}>
                {ALLOCATION_METHOD_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="תחולה"
          description="כלל שחל על כל הארגון נספר בכל נכס. כלל לנכס מסוים נספר רק שם."
        >
          <Select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
          >
            <option value="">כל הארגון</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="בתוקף מ־"
          description="כלל אינו חל על שהות שהתחילה לפני שהוא נוצר."
          required
          error={
            touched && effectiveFrom.length === 0
              ? 'צריך לבחור תאריך תחילה.'
              : undefined
          }
        >
          <TextInput
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Checkbox
            checked={approvalRequired}
            onChange={(event) => setApprovalRequired(event.target.checked)}
            label="דורש אישור לפני תשלום"
            description="הכסף לא יוצא לפני שמישהו חותם. זה תנאי של הכלל, ולא התראה."
          />
        </div>
      </div>

      {failure && <ActionError error={failure} />}

      {touched && !ready && (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-danger"
        >
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'שומר…' : 'שמור כלל הוצאה'}
        </Button>
        <Button href="/finance/expenses" variant="ghost">
          ביטול
        </Button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------ validation -- */

/**
 * The same checks the operation makes, said before the round trip.
 *
 * Not instead of it. `expense.rule.create` refuses every one of these again on
 * the server, because a Server Action is a POST and this component is a
 * courtesy. Keeping the wording close means the person is told the same thing
 * either way.
 */
function validate(input: {
  label: string
  category: string
  kind: ExpenseKind
  amountAgorot: number | null
  formulaKind: VariableFormula['kind']
  rateAgorot: number | null
  percentValue: number
  effectiveFrom: string
}): string[] {
  const issues: string[] = []

  if (input.label.trim().length < 2) issues.push('חסר שם להוצאה.')
  if (input.category.trim().length < 2) issues.push('חסרה קטגוריה.')
  if (input.effectiveFrom.length === 0) issues.push('חסר תאריך תחילה.')

  if (input.kind === 'fixed') {
    if (input.amountAgorot === null || input.amountAgorot <= 0) {
      issues.push('הוצאה קבועה חייבת סכום גדול מאפס.')
    }
  } else if (input.formulaKind === 'percent_of_revenue') {
    if (
      Number.isNaN(input.percentValue) ||
      input.percentValue <= 0 ||
      input.percentValue > 100
    ) {
      issues.push('האחוז חייב להיות בין 0 ל-100.')
    }
  } else if (input.rateAgorot === null || input.rateAgorot <= 0) {
    issues.push('התעריף חייב להיות גדול מאפס.')
  }

  return issues
}

/**
 * Shekels as typed, into integer agorot.
 *
 * The one multiplication by 100 in this directory, at the border between what a
 * person types and what the system stores. `Math.round` rather than a cast:
 * `52.005 * 100` is `5200.499999999999` in floating point, and an integer
 * column would reject it while a truncation would quietly lose an agora.
 */
function toAgorot(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number.parseFloat(trimmed)
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed < 0)
    return null
  return Math.round(parsed * 100)
}

/** Today, as the browser's own calendar day. The server re-reads nothing here:
 * a rule's start is a date the person chose, not an instant. */
function today(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
