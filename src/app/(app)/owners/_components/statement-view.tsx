/**
 * The statement, rendered.
 *
 * ── Why the lines are rendered and never summed ───────────────────────────
 *
 * Every figure here comes off the statement as it was issued. This component
 * adds nothing up, applies no percentage and derives no total — `statement.ts`
 * already proved that each section's lines add to its own total with
 * `assertSumsExactly`, and a component that recomputed a total would be a
 * second answer that can drift from the document a person was sent.
 *
 * ── Why the withheld line says so ─────────────────────────────────────────
 *
 * A reader without `owner.view_commission` sees one combined "ניכויים ועמלות"
 * line rather than a discount line and a commission line. That is a real,
 * deliberate difference between two readers' copies of the same document, and
 * the honest thing is to say it out loud: a person comparing their statement
 * with a manager's over the telephone and finding two different numbers under
 * two different labels has been set up for an argument nobody can win.
 *
 * ── The sign is a fact about the line, not about the layout ───────────────
 *
 * `kind` decides the styling; the amount is rendered exactly as it is stored,
 * negative sign included. Formatting a cost as a positive number under a
 * heading that implies subtraction is how a statement stops being checkable.
 *
 * No `"use client"`: values in, markup out.
 */

import { Badge } from '@/components/ui/badge'
import type { OwnerStatement, OwnerStatementLine } from '@/lib/owners'
import { OWNER_STATEMENT_STATUS_LABEL } from '@/lib/owners'
import { formatAgorot } from '@/lib/plans/plan'

const KIND_CLASS: Record<OwnerStatementLine['kind'], string> = {
  revenue: 'text-foreground',
  cost: 'text-muted-foreground',
  carried: 'text-muted-foreground',
  result: 'font-semibold text-foreground',
}

function LineRows({ lines }: { lines: readonly OwnerStatementLine[] }) {
  return (
    <>
      {lines.map((line) => (
        <tr
          key={line.key}
          className={
            line.kind === 'result'
              ? 'border-t border-border-strong bg-muted/40'
              : 'border-t border-border'
          }
        >
          <th
            scope="row"
            className={`px-4 py-2.5 text-start text-sm font-normal ${KIND_CLASS[line.kind]}`}
          >
            {line.label}
          </th>
          <td
            // Numbers stay LTR inside an RTL page: "₪-1,234" reads as a
            // negative amount and "1,234-₪" does not.
            dir="ltr"
            className={`px-4 py-2.5 text-end text-sm tabular-nums ${KIND_CLASS[line.kind]}`}
          >
            {formatAgorot(line.amountAgorot)}
          </td>
        </tr>
      ))}
    </>
  )
}

export type StatementViewProps = {
  statement: OwnerStatement
  propertyName: string | null
  ownerName: string
}

export function StatementView({
  statement,
  propertyName,
  ownerName,
}: StatementViewProps) {
  const sharePercent = (statement.shareBps / 100).toLocaleString('he-IL')
  const commissionWithheld = statement.withheld.includes('sales_commission')

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-5 shadow-soft">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={statement.status === 'issued' ? 'brand' : 'neutral'}>
            {OWNER_STATEMENT_STATUS_LABEL[statement.status]}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {statement.periodStart} – {statement.periodEnd}
          </span>
          {statement.status === 'issued' && (
            <span className="text-xs text-muted-foreground">
              דוח שהופק אינו משתנה. תיקון נעשה בהפקת דוח מתקן לאותה תקופה.
            </span>
          )}
        </div>

        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          {ownerName} — {propertyName ?? 'הנכס שלך'}
        </h2>

        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          חלקך בנכס בתקופה הזו: {sharePercent}%. הדוח מבוסס על{' '}
          {statement.bookingCount === 1
            ? 'שהות אחת'
            : `${statement.bookingCount} שהויות`}{' '}
          שהתקיימו בנכס בתקופה. כל שורה מוצגת בנפרד כדי שאפשר יהיה לבדוק את
          הסכום, ולא רק לקבל אותו.
        </p>
      </header>

      <section
        aria-labelledby="statement-property"
        className="flex flex-col gap-3"
      >
        <h3
          id="statement-property"
          className="font-display text-lg font-bold tracking-tight text-foreground"
        >
          מה הנכס הניב בתקופה
        </h3>

        {commissionWithheld && (
          <p
            role="status"
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
          >
            שורת ״ניכויים ועמלות״ מאחדת הנחות ועמלות מכירה. פירוט עמלות המכירה
            אינו חלק ממה שבעלים רואה — הוא ההסכם המסחרי של העסק מול מי שמוכר,
            ולא של הנכס. הסכומים בטור מסתכמים לחלק הבעלים בדיוק, בין אם השורה
            מאוחדת ובין אם לא.
          </p>
        )}

        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-soft">
          <table className="w-full min-w-100 border-collapse">
            <caption className="sr-only">
              שרשרת החישוב מהכנסה ברוטו ועד לחלק הבעלים בנכס
            </caption>
            <tbody>
              <LineRows lines={statement.resultLines} />
            </tbody>
          </table>
        </div>

        {statement.expenses.length > 0 && (
          <details className="rounded-xl border border-border bg-surface px-4 py-3 shadow-soft">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">
              פירוט ההוצאות ({statement.expenses.length})
            </summary>
            <ul className="mt-3 flex flex-col gap-1.5">
              {statement.expenses.map((expense) => (
                <li
                  key={expense.ruleId}
                  className="flex items-baseline justify-between gap-4 text-sm"
                >
                  <span className="text-muted-foreground">{expense.label}</span>
                  <span dir="ltr" className="tabular-nums text-foreground">
                    {formatAgorot(expense.amountAgorot)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section
        aria-labelledby="statement-balance"
        className="flex flex-col gap-3"
      >
        <h3
          id="statement-balance"
          className="font-display text-lg font-bold tracking-tight text-foreground"
        >
          החשבון שלך
        </h3>
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-soft">
          <table className="w-full min-w-100 border-collapse">
            <caption className="sr-only">
              יתרת פתיחה, חלקך בתקופה, תנועות, ויתרת סגירה
            </caption>
            <tbody>
              <LineRows lines={statement.balanceLines} />
            </tbody>
          </table>
        </div>
      </section>
    </article>
  )
}
