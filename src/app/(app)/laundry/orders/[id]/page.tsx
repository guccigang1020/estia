import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { Explanation } from '@/components/laundry/explanation'
import { AdjustLineForm } from '@/components/laundry/adjust-line-form'
import { SendOrderPanel } from '@/components/laundry/send-order-panel'
import { Quantity } from '@/components/laundry/quantity'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'
import {
  assessOne,
  latestPickupFor,
  renderOrderMessage,
  toMessageView,
  type LaundryRequirement,
} from '@/lib/laundry'

import {
  CHANNEL_LABEL,
  DISPATCH_LABEL,
  dateAndTime,
  statusLabel,
} from '../../_lib/labels'
import {
  adjustLineAction,
  sendOrderAction,
  submitForApprovalAction,
} from '../../_lib/actions'
import { loadOrder, loadProviders } from '../../_lib/queries'
import { laundryView, nameOf } from '../../_lib/view'

export const metadata: Metadata = { title: 'הזמנת כביסה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One run, in full.
 *
 * ── Who sees the message, and who may send it ─────────────────────────────
 *
 * Everything else on this page is `laundry.view`. The rendered provider
 * message is not: it carries the provider's contact details and the standing
 * notes, which are commercial information, on the one screen where they would
 * otherwise read as ordinary page copy.
 *
 * It is shown to anybody holding `laundry.order_create` OR `laundry.order_send`
 * — the supervisor preparing the run genuinely needs to see what the provider
 * will read, and withholding it would mean raising an order sight-unseen. What
 * the supervisor does not get is the send button, and `SendOrderPanel` renders
 * a sentence naming who does rather than a disabled control, because a disabled
 * button reads as a fault with your own account.
 *
 * It is rendered from `toMessageView`, which is the same function the send
 * operation uses, so what is previewed is what would be sent. A preview built
 * by a second renderer is a preview that eventually differs from the message,
 * and the difference is discovered by the provider. The action re-renders it
 * server-side at the moment of sending rather than accepting the body from the
 * form — see `actions.ts` for why that is a security decision.
 *
 * ── Turnaround is computed here rather than read ──────────────────────────
 *
 * The order stores `expected_return_at` as it stood when the order was built.
 * That is the right thing to store and the wrong thing to show alone: a
 * provider's turnaround may have changed since. So the page recomputes against
 * the current figure and shows both when they disagree, rather than choosing
 * one silently.
 */
export default async function LaundryOrderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const view = await laundryView('laundry.view', 'orders')
  if (!view) return null

  const { vocabulary } = view
  const mode = view.context.settings.settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading={vocabulary.batch} tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const [{ order, gap }, { providers }] = await Promise.all([
    loadOrder(id),
    loadProviders(view.actor),
  ])

  if (gap !== null) {
    return (
      <LaundryShell heading={vocabulary.batch} tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  if (!order) notFound()

  const provider =
    order.providerId === null
      ? null
      : ((providers ?? []).find((entry) => entry.id === order.providerId) ??
        null)

  // Group the lines by property. The breakdown is the delivery instruction and
  // is never collapsed — see `src/lib/laundry/consolidation.ts`.
  const byProperty = new Map<string, typeof order.lines>()
  for (const line of order.lines) {
    const existing = byProperty.get(line.propertyId)
    if (existing) byProperty.set(line.propertyId, [...existing, line])
    else byProperty.set(line.propertyId, [line])
  }

  const pickupAt = order.pickupAt ?? new Date().toISOString()

  // Recomputed against the turnaround in force now, not the one frozen on the
  // row. Both are shown where they differ.
  const risks = order.lines.map((line) => {
    const asRequirement: LaundryRequirement = {
      itemId: line.itemId,
      label: line.label,
      unit: line.unit,
      category: 'linen',
      route: order.mode === 'external' ? 'external' : 'internal',
      propertyId: line.propertyId,
      requiredBy: line.requiredBy,
      sourceBookingId: line.sourceBookingId,
      preparationQuantity: line.quantity.calculated,
      buffer: 0,
      bundleSize: 1,
      bundles: line.quantity.final,
      quantity: line.quantity.final,
      providerId: order.providerId,
      turnaroundHours:
        provider?.turnaroundHours ??
        view.context.settings.settings.turnaroundHours,
      explanation: line.explanation,
    }
    return {
      line,
      assessment: assessOne(asRequirement, pickupAt),
      latestPickup: latestPickupFor(asRequirement),
    }
  })

  const atRisk = risks.filter((entry) => entry.assessment.atRisk)

  // `completed` and `cancelled` only. A COMMITTED order is still adjustable on
  // purpose: the van arriving and finding four fewer sheets than the note said
  // is exactly when somebody must be able to write down what really went, and
  // refusing it would make the record stop matching reality at the moment it
  // starts to matter. See `operations.ts`.
  const closed = TERMINAL_LAUNDRY_STATUSES.includes(order.status)

  // Rendered for anybody who may raise or send. A supervisor preparing the
  // run needs to see what the provider will read; only the send button is
  // withheld from them, not the truth about what is going out.
  const preview =
    view.maySend || view.mayCreateOrders
      ? renderOrderMessage(
          toMessageView({
            order,
            organizationName: 'ESTIA',
            propertyNames: view.properties,
            contactName: provider?.contactName ?? null,
            contactPhone: provider?.phone ?? null,
            standingNotes: view.context.settings.settings.standingNotes,
          }),
          order.channel,
        )
      : null

  return (
    <LaundryShell
      heading={order.reference}
      tagline={`${statusLabel(order.status, mode)} · נדרש ${dateAndTime(order.requiredBy)}`}
    >
      {/* The turnaround verdict first, because it is the only thing on this
          page that can still be acted on. */}
      {atRisk.length > 0 && (
        <section
          role="alert"
          aria-labelledby="risk-title"
          className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-surface px-5 py-5 shadow-soft"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="accent">זמן הטיפול אינו מספיק</Badge>
            <h2
              id="risk-title"
              className="font-display text-base font-bold text-foreground"
            >
              {atRisk.length} פריטים לא יחזרו בזמן
            </h2>
          </div>

          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {atRisk.map((entry) => (
              <li key={entry.line.id} className="flex flex-col gap-0.5">
                <span className="text-foreground">
                  {entry.assessment.explanation}
                </span>
                {/* The actionable half. "At risk" is a problem; "collect by
                    Wednesday 08:00" is what to do about it. */}
                <span className="text-xs">
                  כדי לעמוד במועד יש לאסוף לא יאוחר מ-
                  {dateAndTime(entry.latestPickup)}.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        aria-label="פרטי ההזמנה"
        className="grid gap-4 rounded-xl border border-border bg-surface px-5 py-5 text-sm shadow-soft sm:grid-cols-2 lg:grid-cols-3"
      >
        <Fact label="סטטוס" value={statusLabel(order.status, mode)} />
        <Fact label="נדרש עד" value={dateAndTime(order.requiredBy)} />
        <Fact
          label="מועד איסוף"
          value={
            order.pickupAt === null ? 'טרם נקבע' : dateAndTime(order.pickupAt)
          }
        />
        <Fact
          label="חזרה צפויה"
          value={
            order.expectedReturnAt === null
              ? 'לא ידוע'
              : dateAndTime(order.expectedReturnAt)
          }
        />
        <Fact label="ערוץ" value={CHANNEL_LABEL[order.channel]} />
        <Fact label="אופן שליחה" value={DISPATCH_LABEL[order.dispatchMode]} />
        <Fact
          label="נשלח"
          value={order.sentAt === null ? 'טרם נשלח' : dateAndTime(order.sentAt)}
        />
        {/* The provider row appears only for somebody who may see providers.
            A cleaner reading this page sees the linen and the deadline. */}
        {provider !== null && <Fact label="ספק" value={provider.name} />}
      </section>

      {/* The per-property breakdown, with every figure's arithmetic. */}
      {[...byProperty.entries()].map(([propertyId, lines]) => (
        <section
          key={propertyId}
          aria-labelledby={`property-${propertyId}`}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
            <h2
              id={`property-${propertyId}`}
              className="font-display text-lg font-bold tracking-tight text-foreground"
            >
              {nameOf(view.properties, propertyId)}
            </h2>
            <span className="text-sm text-muted-foreground">
              {lines.reduce((sum, line) => sum + line.quantity.final, 0)} יחידות
            </span>
          </div>

          <ul className="flex flex-col gap-3">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="font-semibold text-foreground">
                    {line.label}
                  </span>
                  <Explanation
                    steps={line.explanation}
                    expected={line.quantity.calculated}
                  />
                </div>
                <div className="shrink-0">
                  <Quantity quantity={line.quantity} unit={line.unit} />
                </div>
                {view.mayCreateOrders && !closed && (
                  <div className="w-full border-t border-border pt-3 sm:w-auto sm:basis-full">
                    <AdjustLineForm
                      orderId={order.id}
                      lineId={line.id}
                      label={line.label}
                      calculated={line.quantity.calculated}
                      adjustment={line.quantity.adjustment}
                      reason={line.quantity.reason}
                      version={order.version}
                      action={adjustLineAction}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {order.internalNotes !== null && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised px-5 py-4">
          <span className="text-xs font-semibold text-muted-foreground">
            הערה פנימית — אינה נשלחת לספק
          </span>
          <p className="text-sm text-foreground">{order.internalNotes}</p>
        </section>
      )}

      {preview !== null && (
        <SendOrderPanel
          orderId={order.id}
          preview={preview}
          channel={order.channel}
          channelLabel={CHANNEL_LABEL[order.channel]}
          dispatchLabel={DISPATCH_LABEL[order.dispatchMode]}
          needsApproval={
            order.dispatchMode === 'approval_required' &&
            order.status === 'draft'
          }
          alreadySent={order.sentAt !== null}
          mayRaise={view.mayCreateOrders}
          maySend={view.maySend}
          providerName={provider?.name ?? null}
          sendAction={sendOrderAction}
          raiseAction={submitForApprovalAction}
          version={order.version}
        />
      )}

      {order.sentBody !== null && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-5 shadow-soft">
          <h2 className="font-display text-base font-bold text-foreground">
            מה נשלח בפועל
          </h2>
          <p className="text-xs text-muted-foreground">
            הנוסח כפי שנשלח, ולא כפי שהיה נוצר היום. זהו הרישום.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm text-foreground">
            {order.sentBody}
          </pre>
        </section>
      )}
    </LaundryShell>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  )
}
