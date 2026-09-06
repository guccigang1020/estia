/**
 * The last time anybody compared ESTIA's references with the vendor's list.
 *
 * ── A refused run is a run, and it is recorded ────────────────────────────
 *
 * `refusalReason` is non-null exactly when nothing was compared, and the panel
 * prints it. That is the pattern `site_generation_requests` established for an
 * absent provider: an honest refusal is stored and shown, rather than the
 * attempt disappearing and leaving a screen that looks like nobody has ever
 * run one. "We asked and were told there is no vendor to ask" and "nobody has
 * ever asked" are different sentences and a business acts differently on each.
 *
 * ── Never "0 הפרשים" when nothing was compared ────────────────────────────
 *
 * The difference count is `null` for a refused run, and `null` renders as the
 * refusal rather than as zero. A zero would be the most dangerous number on
 * this screen: it reads as "everything matches".
 *
 * No `"use client"`: it renders text.
 */

import { FactRow, PanelNote } from '@/components/shell-screens/screen'
import { formatAgorot } from '@/lib/plans/plan'

export type ReconciliationSummaryProps = {
  provider: string
  from: string
  to: string
  ranAt: Date
  differenceCount: number | null
  differenceAgorot: number | null
  refusalReason: string | null
}

export function ReconciliationSummary({
  provider,
  from,
  to,
  ranAt,
  differenceCount,
  differenceAgorot,
  refusalReason,
}: ReconciliationSummaryProps) {
  const compared = refusalReason === null && differenceCount !== null

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col">
        <FactRow label="הופעל בתאריך">{ranAt.toLocaleString('he-IL')}</FactRow>
        <FactRow label="תקופה">
          <span dir="ltr">{`${from} – ${to}`}</span>
        </FactRow>
        <FactRow label="מול הספק">
          <span dir="ltr" className="font-mono text-xs">
            {provider}
          </span>
        </FactRow>

        {compared && (
          <>
            <FactRow label="הפרשים">
              <span className="tabular-nums">{differenceCount}</span>
            </FactRow>
            <FactRow label="סכום במחלוקת">
              <span className="tabular-nums">
                {formatAgorot(differenceAgorot ?? 0)}
              </span>
            </FactRow>
          </>
        )}
      </dl>

      {!compared && refusalReason !== null && (
        <PanelNote tone="attention">{refusalReason}</PanelNote>
      )}
    </div>
  )
}
