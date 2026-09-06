'use client'

/**
 * Step four: every row read, and what was wrong with the ones that were.
 *
 * ── Still nothing has left this machine ───────────────────────────────────
 *
 * `validateRows` is pure — no clock, no client, no randomness — so it runs in
 * the browser and produces exactly the records the server will produce from the
 * same file and the same mapping. A person can therefore see what ESTIA made of
 * their file, row by row, before a single byte is uploaded.
 *
 * ── The date order is the one assumption worth interrupting for ───────────
 *
 * `03/04/2023` is the fourth of March or the third of April, and a file whose
 * days never exceed twelve settles nothing. `inferDateOrder` says so with its
 * own issue code — `date_order_assumed` — precisely because nothing is wrong
 * with any row: an operator sent hunting for a bad date would find none. So it
 * is shown here as an assumption with a control beside it, and overruling it
 * re-reads the whole file.
 *
 * Getting this wrong is the most expensive silent error in the feature: three
 * years of stays on plausible wrong days, discovered when somebody arrives.
 */

import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { IssueList } from '@/components/migration/issue-list'
import { RecordTable } from '@/components/migration/record-table'
import { useMigration } from '@/components/migration/wizard-state'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import { blockedReason } from '@/app/(app)/migration/_lib/steps'
import {
  DATE_ORDERS,
  DATE_ORDER_LABEL,
  type DateOrder,
} from '@/lib/migration/validate'

export function ValidateStep() {
  const { validation, parsed, chooseDateOrder, dateOrder, progress } =
    useMigration()
  const blocked = blockedReason('validate', progress)

  if (blocked !== null || validation === null || parsed === null) {
    return (
      <StepBlocked
        step="validate"
        reason={blocked ?? 'אין עדיין מיפוי לבדוק לפיו.'}
      />
    )
  }

  const errors = validation.issues.filter((issue) => issue.severity === 'error')
  const warnings = validation.issues.filter(
    (issue) => issue.severity === 'warning',
  )
  const notices = validation.issues.filter((issue) => issue.severity === 'info')

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="validate">
        <p className="text-sm text-foreground">
          {validation.records.length} שורות נקראו במלואן, {errors.length} נדחו,{' '}
          {warnings.length} עם אזהרה. עדיין לא נשלח שום דבר לשרת.
        </p>
      </StepHeader>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          איך נקראו התאריכים
        </h3>
        <p className="text-sm text-muted-foreground">
          {validation.dateOrderInferred
            ? 'הקובץ לא הכיל ערך שמכריע בין יום-חודש לחודש-יום, ולכן הונחה ברירת המחדל הישראלית. אם המערכת הקודמת שלכם אמריקאית — שנו כאן, והקובץ ייקרא מחדש.'
            : 'הקובץ עצמו הכריע: יש בו תאריך שאי אפשר לקרוא אחרת.'}
        </p>
        <div className="sm:w-72">
          <Field label="סדר התאריכים בקובץ">
            <Select
              value={dateOrder ?? validation.dateOrder}
              onChange={(event) =>
                chooseDateOrder(event.target.value as DateOrder)
              }
            >
              {DATE_ORDERS.map((order) => (
                <option key={order} value={order}>
                  {DATE_ORDER_LABEL[order]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      {notices.length > 0 && (
        <ul className="flex flex-col gap-2">
          {notices.map((notice, index) => (
            <li
              key={`${notice.code}-${index}`}
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              {notice.message}
            </li>
          ))}
        </ul>
      )}

      <IssueList
        title="שורות שלא ייובאו"
        description="כל שורה כאן נדחתה לבדה. השאר ייובא. השורות ממוספרות כפי שהעורך שלכם מספר אותן, כולל שורת הכותרת."
        issues={errors}
        emptyNote="אף שורה לא נדחתה."
      />

      <IssueList
        title="אזהרות"
        description="השורות האלה ייובאו. שדה אחד בכל אחת מהן לא נקרא, וכתוב מה הונח במקומו."
        issues={warnings}
        emptyNote="אין אזהרות."
      />

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          מה ESTIA הבינה מהקובץ
        </h3>
        <RecordTable
          records={validation.records}
          caption="פתחו שורה כדי לראות את הערכים אחרי הקריאה — לא כפי שנכתבו בקובץ, אלא כפי שיישמרו. הטלפון המנורמל הוא השדה שהכי כדאי לבדוק."
        />
      </section>

      <StepNav
        back="map"
        forward="dry_run"
        forwardBlocked={blockedReason('dry_run', progress)}
      />
    </section>
  )
}
