/**
 * The documents ESTIA has references to, as rows a person can act on.
 *
 * ── The number column is empty when there is no number ────────────────────
 *
 * Not "—", not the internal id, not the provider's opaque key dressed up to
 * look like one. `Withheld` is not used either: that component means "there is
 * a value and you may not see it", which is a different and false statement
 * here. A document with no number has no number, and the row says so in words.
 *
 * No `"use client"`: it renders text.
 */

import { Row, RowList } from '@/components/shell-screens/screen'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  FISCAL_DOCUMENT_TYPE_LABEL,
  FISCAL_STATUS_LABEL,
  type FiscalDocument,
  type FiscalDocumentStatus,
} from '@/lib/fiscal'
import { formatAgorot } from '@/lib/plans/plan'

const STATUS_TONE: Record<FiscalDocumentStatus, BadgeTone> = {
  pending: 'neutral',
  issued: 'brand',
  failed: 'accent',
  refused: 'accent',
  unknown: 'accent',
  cancelled: 'neutral',
  credited: 'neutral',
}

export type DocumentListItem = {
  document: FiscalDocument
  bookingReference: string | null
}

/** Has the provider's signed link outlived its expiry? */
function linkIsLive(document: FiscalDocument, now: Date): boolean {
  if (document.documentUrl === null) return false
  if (document.documentUrlExpiresAt === null) return true
  return document.documentUrlExpiresAt.getTime() > now.getTime()
}

export function DocumentList({
  items,
  now,
}: {
  items: readonly DocumentListItem[]
  /** Injected rather than read, so the rendered output is deterministic. */
  now: Date
}) {
  return (
    <RowList>
      {items.map(({ document, bookingReference }) => (
        <Row key={document.id} className="flex-col items-stretch gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {FISCAL_DOCUMENT_TYPE_LABEL[document.type]}
              </span>
              <Badge tone={STATUS_TONE[document.status]}>
                {FISCAL_STATUS_LABEL[document.status]}
              </Badge>
            </div>
            <span className="tabular-nums font-medium text-foreground">
              {formatAgorot(document.amountAgorot)}
            </span>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{document.customerName}</span>

            {bookingReference !== null && (
              <span dir="ltr" className="font-mono text-xs">
                {bookingReference}
              </span>
            )}

            {document.providerDocumentNumber === null ? (
              <span>טרם התקבל מספר מסמך מהספק</span>
            ) : (
              <span dir="ltr" className="font-mono text-xs">
                {document.providerDocumentNumber}
              </span>
            )}

            {document.issueDate !== null && <span>{document.issueDate}</span>}
          </div>

          {document.failure !== null && (
            <p className="text-sm text-muted-foreground">
              {document.failure.reason}
            </p>
          )}

          {/*
           * The link only where the provider gave one and it has not expired.
           * A signed URL past its expiry is a button that fails, and rendering
           * it is worse than not offering it — the person clicks, nothing
           * happens, and they conclude the document is gone.
           */}
          {linkIsLive(document, now) && document.documentUrl !== null && (
            <a
              href={document.documentUrl}
              rel="noreferrer noopener"
              target="_blank"
              className="text-sm font-medium text-primary underline underline-offset-4"
            >
              פתיחת המסמך אצל הספק
            </a>
          )}
        </Row>
      ))}
    </RowList>
  )
}
