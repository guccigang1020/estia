/**
 * EXECUTION CONTEXT — SERVER COMPONENT. A cancelled booking's portal.
 *
 * ── The screen is defined by what is not on it ────────────────────────────
 *
 * No arrival instructions, no access code, no wifi, no store, no add-ons and
 * no requests form. A revoked door code still on a screen is a security
 * failure, not a cosmetic one — and this is the third of three layers that
 * keep it off:
 *
 *   · SQL should withhold it, and today does not: `guest_arrival_released`
 *     tests a status list containing neither `cancelled` nor `no_show`. That
 *     is reported and belongs in a migration.
 *   · `redactCancelledJourney` removes it from the journey the screens read.
 *   · `GuestCancelledView`, which is all this component receives, has no
 *     member that could carry one.
 *
 * The last of those is why this file takes a view rather than a journey. There
 * is no prop through which an address could reach it.
 *
 * ── Say it plainly, then be useful ────────────────────────────────────────
 *
 * The heading is four words and no euphemism. Under it goes what still
 * matters: the money, the documents, and one way to reach a person. Somebody
 * opening this link is usually opening it to find out about exactly those.
 */

import type { GuestCancelledView } from '@/lib/guest-journey/stay'
import { formatAgorot } from '@/lib/plans/plan'

import { ContactActions, type GuestContact } from './contact-actions'

export function CancelledPanel({
  token,
  view,
  contact,
}: {
  token: string
  view: GuestCancelledView
  contact?: GuestContact
}) {
  return (
    <main className="flex flex-col gap-5">
      <header className="flex flex-col gap-2 rounded-xl border border-border-strong bg-surface px-4 py-5">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {view.headline}
        </h1>
        <p className="text-sm text-muted-foreground">{view.body}</p>
      </header>

      {view.refund && (
        <section
          className={
            'flex flex-col gap-2 rounded-xl border px-4 py-4 ' +
            (view.refund.tone === 'warning'
              ? 'border-warning bg-warning/10'
              : view.refund.tone === 'danger'
                ? 'border-danger bg-danger/10'
                : 'border-border bg-surface')
          }
        >
          <h2 className="font-display text-base font-bold text-foreground">
            החזר כספי
          </h2>
          {/*
            `role="status"` and not `role="alert"`. A payment being checked is
            information a guest needs; announcing it as an alert on a screen
            they opened on purpose is alarming for no gain.
          */}
          <p role="status" className="text-sm text-foreground">
            {view.refund.message}
          </p>
          {view.refundAmountAgorot !== null && (
            <p className="text-sm text-muted-foreground">
              {`הסכום: ${formatAgorot(view.refundAmountAgorot)}`}
            </p>
          )}
        </section>
      )}

      {view.documents.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="font-display text-base font-bold text-foreground">
            מסמכים
          </h2>
          <ul className="flex flex-col gap-2">
            {view.documents.map((document) => (
              <li key={document.id}>
                <a
                  href={`/g/${token}/${document.path}`}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span>{document.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {`נחתם ${new Date(document.signedAt).toLocaleDateString('he-IL')}`}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ContactActions contact={contact} label={view.action.label} />
    </main>
  )
}
