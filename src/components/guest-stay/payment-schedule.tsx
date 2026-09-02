/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What is paid, and what is still due.
 *
 * ── This component decides nothing about money ────────────────────────────
 *
 * `guestPaymentSchedule` hands it rows that are already labelled, already
 * formatted and already dated, and that function is itself a consumer of
 * `resolveCollectionPolicy` — the one implementation in this product of what a
 * booking must collect before it is confirmed. So there is no arithmetic in
 * this file, no percentage, and no `if` deciding whether a deposit counts. A
 * `formatAgorot` call here would be the beginning of a second rounding rule;
 * the amounts arrive as strings for that reason.
 *
 * The failure being defended against is not a rendering bug. It is the desk
 * believing a deposit was waived while the guest's screen asks for it, with no
 * record that can settle which is right.
 *
 * ── Nothing is conveyed by colour alone ───────────────────────────────────
 *
 * Every row carries its state in words — `שולם`, `לתשלום עד 12.9` — and the
 * tint is decoration on top of that. A guest reading this on a telephone in
 * sunlight, or with any of the common colour deficiencies, gets the whole
 * meaning from the text. The check mark beside a paid row is `aria-hidden` and
 * duplicated by that same word, never a substitute for it.
 *
 * ── An overdue row is stated, never accused ───────────────────────────────
 *
 * The domain already refuses the word "באיחור" and says `מועד התשלום היה 3.9`
 * instead, because a guest may have sent the transfer on Tuesday and be
 * waiting for somebody to record it. This file keeps that promise visually as
 * well: overdue is `warning`, not `danger`.
 */

import type {
  GuestInstalment,
  GuestPaymentSchedule,
} from '@/lib/guest-journey/stay'

const ROW_TINT: Record<GuestInstalment['state'], string> = {
  paid: 'text-muted-foreground',
  due: 'text-foreground',
  overdue: 'text-warning',
  upcoming: 'text-muted-foreground',
}

function Row({ line }: { line: GuestInstalment }) {
  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {line.label}
        </span>
        <span className={`text-xs ${ROW_TINT[line.state]}`}>
          {/* The tick repeats what the word already says. Decoration, so it is
              hidden from the accessibility tree rather than read aloud as
              "check mark" before the sentence that carries the meaning. */}
          {line.state === 'paid' && (
            <span aria-hidden="true" className="me-1">
              ✓
            </span>
          )}
          {line.detail}
        </span>
      </div>

      {/* The sum is the one thing a guest scans for, so it is the heaviest
          thing on the row. A paid line is struck through nowhere — money that
          arrived is not money cancelled. */}
      <span
        className={
          line.state === 'paid'
            ? 'shrink-0 text-sm font-semibold text-muted-foreground'
            : 'shrink-0 text-base font-bold text-foreground'
        }
      >
        {line.amountLabel}
      </span>
    </li>
  )
}

export function PaymentSchedule({
  schedule,
  children,
}: {
  /**
   * Null when the business collects nothing in advance and nothing has
   * arrived — the most common configuration in this market. The component
   * renders nothing at all rather than an empty card, which is the same rule
   * the domain follows by returning null in the first place.
   */
  schedule: GuestPaymentSchedule | null
  /** The pay control, when the caller has one. Never invented here. */
  children?: React.ReactNode
}) {
  if (!schedule) return null

  return (
    <section
      aria-labelledby="payment-schedule-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4"
    >
      <header className="flex flex-col gap-1">
        <h2
          id="payment-schedule-heading"
          className="font-display text-base font-bold text-foreground"
        >
          לוח התשלומים
        </h2>
        {/* The policy in one line — `30% בעת ההזמנה · 70% עד 3 ימים לפני
            ההגעה`. Absent when there is no split, so a pay-everything booking
            does not get a sentence describing a schedule it does not have. */}
        {schedule.policyLabel && (
          <p className="text-xs text-muted-foreground">
            {schedule.policyLabel}
          </p>
        )}
      </header>

      <ul className="flex flex-col">
        {schedule.instalments.map((line) => (
          <Row key={line.id} line={line} />
        ))}
      </ul>

      {/* Only when there is still something outstanding. A guest who has paid
          in full does not need a total repeated back at them, and the row
          above already says so. */}
      {schedule.outstandingAgorot > 0 && schedule.instalments.length > 1 && (
        <p className="text-xs text-muted-foreground">
          מתוך {schedule.totalLabel} סך ההזמנה
        </p>
      )}

      {children}
    </section>
  )
}
