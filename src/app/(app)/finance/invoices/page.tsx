import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { InvoiceList } from '@/components/finance/invoice-list'
import { StatusFilterBar } from '@/components/finance/status-filter'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { INVOICE_STATUSES } from '@/lib/finance'

import { INVOICE_STATUS_LABEL } from '../_lib/labels'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from '../_lib/filters'
import {
  FINANCE_PAGE_SIZE,
  countInvoices,
  listInvoices,
  type InvoiceListItem,
} from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'חשבוניות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The documents the business issued.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.invoices` with their lines
 * embedded from `invoice_lines` and their settlement read from
 * `public.invoice_payments` — the join table 0022 created and 0024 backfilled
 * into, never `invoices.metadata.payment_ids`, which no longer holds them. A
 * fallback to that array would resurrect links somebody deliberately removed.
 *
 * GATING. `requireGrant('invoice.view')` refuses the route; `can()` per row
 * narrows to the properties this membership reaches; `redact()` removes the
 * customer's name and tax id without `guest.view_name`; and `invoices_select`
 * carries `has_permission(organization_id, 'invoice.view')` regardless of all
 * three. The payment details behind each document need `payment.view` as well,
 * because they are on the payment rows — a reader holding one grant and not
 * the other is told how many payments there are rather than shown none.
 *
 * NOTHING IS RECOMPUTED. An issued invoice's total is frozen: the only
 * correction to a legal document is a credit note, never an edit, and a screen
 * that rendered the sum of the lines in place of the stored total would be
 * quietly amending a tax record. Both are shown — the sum comes from
 * `sumAgorot` in `_lib/queries.ts` — and when they disagree the card says so
 * and asks the reader to trust neither.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('invoice.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const filter = parseStatusFilter(params, INVOICE_STATUSES)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const linkBookings = holdsGrant(actor, 'booking.view')

  let invoices: readonly InvoiceListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { repo } = await financeRepository()
    ;[invoices, total] = await Promise.all([
      listInvoices({
        repo,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filter,
      }),
      countInvoices(repo, actor.organizationId, propertyId),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const emptyReason = resolveEmptyReason({
    visibleCount: invoices.length,
    totalCount: total,
    hasActiveFilters: hasActiveStatusFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          חשבוניות
        </h1>
        <p className="text-muted-foreground">
          {propertyName
            ? `כל המסמכים שהופקו ב״${propertyName}״.`
            : 'כל המסמכים שהופקו בארגון, בכל הנכסים שבטווח שלך.'}{' '}
          {total === 1 ? 'מסמך אחד סה״כ' : `${total} מסמכים סה״כ`}. מסמך שבוטל
          שומר על מספרו — פער במספור נקרא לרשות המסים כמסמך חסר.
        </p>
      </header>

      <StatusFilterBar
        path="/finance/invoices"
        legend="סינון חשבוניות"
        statuses={INVOICE_STATUSES}
        labels={INVOICE_STATUS_LABEL}
        selected={filter.status}
        anyLabel="כל המסמכים"
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        // The preset exists for this module and already gets the Hebrew
        // agreement right for the filtered variant. Writing the copy again
        // here would be a second version of it to keep in step.
        <ModuleEmptyState
          module="invoices"
          reason={emptyReason}
          filterSummary={describeStatusFilter(
            filter,
            INVOICE_STATUS_LABEL,
            propertyName,
          )}
          renderAction={(label) =>
            emptyReason === 'no_results' ? (
              <Button href="/finance/invoices" variant="secondary">
                {label}
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <InvoiceList invoices={invoices} linkBookings={linkBookings} />

          {invoices.length === FINANCE_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {FINANCE_PAGE_SIZE} המסמכים האחרונים. צמצם את הסינון כדי
              לראות מסמכים נוספים.
            </p>
          )}
        </>
      )}
    </div>
  )
}
