/**
 * EXECUTION CONTEXT — SERVER COMPONENT. "ההזמנה עודכנה", with the receipts.
 *
 * ── Why this shows the old value and the new one ──────────────────────────
 *
 * A screen that says "the booking has changed, please confirm again" trains
 * people to press the button without reading, and the third time it happens
 * they stop looking altogether. Then the one that mattered — the ₪500 — goes
 * through unnoticed, and the argument at the front door has no record either
 * side can point at.
 *
 * So every change is one line naming the field, what the guest agreed to, and
 * what it is now: **מחיר · קודם ₪7,500 · עכשיו ₪8,000**. The "before" comes
 * from `booking_guest_confirmations.snapshot`, frozen by the database at the
 * moment of approval, so it stays true however many times the price moves
 * afterwards.
 *
 * ── Two kinds of change, shown differently ────────────────────────────────
 *
 * `changes` are the ones this business treats as material — they need a fresh
 * approval, and they lead the card. `informational` are ones it does not: they
 * are still shown, quietly, below a rule. A guest whose cancellation terms
 * moved is entitled to notice even where the business does not re-ask.
 */

import type {
  GuestTermsChange,
  ReconfirmationVerdict,
} from '@/lib/guest-journey'
import { reconfirmationHeadline } from '@/lib/guest-journey'

function ChangeRow({
  change,
  muted,
}: {
  change: GuestTermsChange
  muted?: boolean
}) {
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <span
        className={
          muted
            ? 'text-xs font-medium text-muted-foreground'
            : 'text-sm font-semibold text-foreground'
        }
      >
        {change.label}
      </span>

      {/* Stacked rather than side by side. Two money figures on one line on a
          360px screen wrap into something nobody can read at a glance. */}
      <div className="flex flex-col gap-0.5 text-sm">
        {change.before !== null && (
          <span className="text-muted-foreground">
            קודם:{' '}
            <span className="line-through decoration-muted-foreground/60">
              {change.before}
            </span>
          </span>
        )}
        <span className="font-semibold text-foreground">
          עכשיו: {change.after}
        </span>
      </div>
    </li>
  )
}

export function ReconfirmNotice({
  verdict,
  children,
}: {
  verdict: ReconfirmationVerdict
  /** The reconfirm control. Owned by the route, not invented here. */
  children?: React.ReactNode
}) {
  if (!verdict.changed) return null

  const heading = reconfirmationHeadline(verdict)

  return (
    <section
      // `alert` rather than `status`: this interrupts, and a guest using a
      // screen reader must not have to go looking for it.
      role={verdict.required ? 'alert' : 'status'}
      aria-labelledby="reconfirm-heading"
      className={
        verdict.required
          ? // No `warning-soft` token exists, so the tint is an opacity of the
            // warning colour itself rather than a new palette entry invented
            // here — `src/app/globals.css` belongs to the coordinator.
            'flex flex-col gap-3 rounded-2xl border-2 border-warning bg-warning/10 px-4 py-4 sm:px-5'
          : 'flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5'
      }
    >
      <div className="flex flex-col gap-1">
        <h2
          id="reconfirm-heading"
          className="font-display text-lg font-bold text-foreground"
        >
          {heading}
        </h2>
        <p className="text-sm text-foreground">
          {verdict.required
            ? 'הפרטים שאישרת השתנו. בדוק את השינוי ואשר מחדש כדי שההזמנה תישאר בתוקף.'
            : 'הפרטים הבאים השתנו מאז שאישרת. אין צורך בפעולה מצדך.'}
        </p>
      </div>

      {verdict.changes.length > 0 && (
        <ul className="flex flex-col rounded-xl bg-surface px-4">
          {verdict.changes.map((change) => (
            <ChangeRow key={change.trigger} change={change} />
          ))}
        </ul>
      )}

      {verdict.informational.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            שינויים נוספים, שאינם דורשים אישור מחדש:
          </p>
          <ul className="flex flex-col rounded-xl bg-surface/70 px-4">
            {verdict.informational.map((change) => (
              <ChangeRow key={change.trigger} change={change} muted />
            ))}
          </ul>
        </div>
      )}

      {verdict.required && children}
    </section>
  )
}
