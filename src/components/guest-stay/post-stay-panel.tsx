/**
 * EXECUTION CONTEXT — SERVER COMPONENT. After the guest has gone.
 *
 * ── The public review link is not behind anything ─────────────────────────
 *
 * Where a business has both, the private prompt sits above the public link and
 * the link is rendered unconditionally, in the same pass, with no branch that
 * reads what the guest wrote. Asking privately first is courtesy; deciding who
 * may reach the public link by what they said is review gating, and this
 * product does not do it. `guestReviewOffer` takes no rating to give it, and
 * this component does not go looking for one.
 *
 * ── The primary action is chosen once, in the domain ──────────────────────
 *
 * `view.action` is the single thing this screen asks. The review, the receipt
 * and the rebook card are all present as sections; exactly one of them gets
 * the full-width control. A screen with four equal buttons has no next action,
 * it has a menu, and a person who has just driven home does not want a menu.
 *
 * ── No price on the rebook card, at any size ──────────────────────────────
 *
 * `GuestRebookOffer` carries no money member, so there is nothing here to
 * render one from. With no known open dates the card asks — and its wording
 * says we cannot show availability, rather than implying there is none.
 */

import { formatDayMonth } from '@/lib/booking/dates'
import type { GuestPostStayView } from '@/lib/guest-journey/post-stay'

import { ContactActions, type GuestContact } from './contact-actions'

export function PostStayPanel({
  view,
  contact,
  feedbackForm,
}: {
  view: GuestPostStayView
  contact?: GuestContact
  /**
   * The private feedback form, when the business has somewhere to store one.
   * A slot rather than a component here, because nothing in migration 0034
   * writes guest feedback yet — see `guestReviewOffer`.
   */
  feedbackForm?: React.ReactNode
}) {
  const primary = view.action

  return (
    <main className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {view.headline}
        </h1>
        <p className="text-sm text-muted-foreground">{view.body}</p>
      </header>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4">
        <h2 className="font-display text-base font-bold text-foreground">
          סיכום השהות
        </h2>
        <dl className="flex flex-col gap-2 text-sm">
          <SummaryRow
            label="תאריכים"
            value={`${formatDayMonth(view.summary.checkIn)}–${formatDayMonth(view.summary.checkOut)}`}
          />
          <SummaryRow label="לילות" value={view.summary.nightsLabel} />
          <SummaryRow label="אורחים" value={view.summary.partyLabel} />
          {view.summary.totalLabel && (
            <SummaryRow label="סה״כ" value={view.summary.totalLabel} />
          )}
        </dl>
      </section>

      {view.receipt && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="font-display text-base font-bold text-foreground">
            קבלה
          </h2>
          {view.receipt.notice && (
            <p role="status" className="text-sm text-foreground">
              {view.receipt.notice.message}
            </p>
          )}
          {view.receipt.href ? (
            <a
              href={view.receipt.href}
              className="flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {`הורדת הקבלה · ${view.receipt.totalLabel}`}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              {`הקבלה תישלח מבית האירוח · ${view.receipt.totalLabel}`}
            </p>
          )}
        </section>
      )}

      {view.review && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-base font-bold text-foreground">
              {view.review.headline}
            </h2>
            <p className="text-sm text-muted-foreground">{view.review.body}</p>
          </div>

          {view.review.internalPrompt && feedbackForm}

          {/*
            Rendered whenever it exists. There is no condition above it and
            there must never be one — see the header.
          */}
          {view.review.externalUrl && view.review.externalLabel && (
            <a
              href={view.review.externalUrl}
              target="_blank"
              // `noreferrer` as well as `noopener`: the portal's URL is a
              // bearer credential for this booking, and a Referer header
              // carrying it to a review site would publish somebody's stay.
              rel="noopener noreferrer"
              className={
                primary.id === 'review' && view.review.mode === 'external'
                  ? 'inline-flex min-h-13 w-full items-center justify-center rounded-full bg-primary px-7 text-base font-medium text-primary-foreground shadow-soft hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                  : 'flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              }
            >
              {view.review.externalLabel}
            </a>
          )}
        </section>
      )}

      {view.rebook.kind !== 'off' && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-base font-bold text-foreground">
              {view.rebook.headline}
            </h2>
            <p className="text-sm text-muted-foreground">{view.rebook.body}</p>
          </div>

          {view.rebook.kind === 'dates' && (
            <ul className="flex flex-col gap-2">
              {view.rebook.ranges.map((range) => (
                <li
                  key={`${range.start}-${range.end}`}
                  className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
                >
                  {`${formatDayMonth(range.start)}–${formatDayMonth(range.end)}`}
                </li>
              ))}
            </ul>
          )}

          {primary.id === 'rebook' ? (
            <ContactActions
              contact={contact}
              label={primary.label ?? view.rebook.actionLabel}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {view.rebook.actionLabel}
            </p>
          )}
        </section>
      )}
    </main>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  )
}
