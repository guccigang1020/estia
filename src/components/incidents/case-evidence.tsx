/**
 * The evidence on a case, and the differences between two inspections.
 *
 * ── What this component refuses to do ─────────────────────────────────────
 *
 * Draw a conclusion. A before/after pair is rendered as two references side by
 * side with their capture times, and the caption says what it is — two
 * photographs of the same thing at two moments. It does not say "damage", it
 * does not colour one of them red, and it does not put a number beside them.
 * Every one of those would be the interface asserting liability, which is the
 * thing `src/lib/incidents/liability.ts` exists to make impossible.
 *
 * ── And what it cannot do, structurally ───────────────────────────────────
 *
 * Show the picture. This product stores media references and no bytes — see
 * `evidence.ts`, `site_media` and `payment_proofs` — so what is on screen is
 * the reference, its provenance and its times. Rendering an `<img>` would
 * require a signed URL from a storage port that is not wired in this
 * deployment, and a broken image is worse than an honest reference.
 *
 * No `"use client"`: it renders text.
 */

import { Badge } from '@/components/ui/badge'
import { PanelNote } from '@/components/shell-screens/screen'
import {
  DIFFERENCE_KIND_LABEL,
  EVIDENCE_KIND_LABEL,
  EVIDENCE_SOURCE_LABEL,
  INSPECTION_CONDITION_LABEL,
  INSPECTION_STAGE_LABEL,
  byAttention,
  pairComparisons,
  type CaseEvidence,
  type EvidenceTally,
  type InspectionChainStep,
} from '@/lib/incidents'

function When({ at }: { at: Date | null }) {
  if (at === null) return <span className="text-muted-foreground">—</span>
  return (
    <time dateTime={at.toISOString()} dir="ltr" className="tabular-nums">
      {at.toLocaleString('he-IL', {
        dateStyle: 'short',
        timeStyle: 'short',
      })}
    </time>
  )
}

function Reference({ item }: { item: CaseEvidence }) {
  if (item.statement !== null) {
    return (
      <blockquote className="mt-1 border-s-2 border-border ps-3 text-sm text-foreground">
        {item.statement}
      </blockquote>
    )
  }

  if (item.mediaRef === null) {
    return <span className="text-muted-foreground">אין הפניה</span>
  }

  return (
    // LTR and monospaced: it is a storage key, not a sentence. The file itself
    // lives in the object store and this row has never held it.
    <span
      dir="ltr"
      className="mt-1 block break-all font-mono text-xs text-muted-foreground"
    >
      {item.mediaRef}
    </span>
  )
}

export function CaseEvidenceList({
  evidence,
  tally,
}: {
  evidence: readonly CaseEvidence[]
  tally: EvidenceTally
}) {
  if (evidence.length === 0) {
    return (
      <PanelNote>
        לא צורפה עדיין אף ראיה. תמונה לפני, תמונה אחרי, הצהרה או חשבונית — כל
        אחת מהן היא עובדה שמישהו יצטרך לשקול, וללא אף אחת מהן אין על מה להכריע.
      </PanelNote>
    )
  }

  const pairs = pairComparisons(evidence)

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {tally.total} ראיות, מתוכן {pairs.length} זוגות של לפני ואחרי
        {tally.fromGuest > 0 && ` ו־${tally.fromGuest} מהאורח`}. הראיה עצמה
        נשמרת באחסון; כאן נשמרת ההפניה אליה, מי צירף אותה ומתי.
      </p>

      {pairs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            זוגות להשוואה
          </h3>
          <ul className="flex flex-col gap-3">
            {pairs.map((pair) => (
              <li
                key={`${pair.before.id}-${pair.after.id}`}
                className="grid gap-3 rounded-lg border border-border bg-muted p-3 sm:grid-cols-2"
              >
                {[pair.before, pair.after].map((item) => (
                  <div key={item.id} className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-muted-foreground">
                      {EVIDENCE_KIND_LABEL[item.kind]} ·{' '}
                      <When at={item.capturedAt ?? item.recordedAt} />
                    </span>
                    <Reference item={item} />
                  </div>
                ))}
              </li>
            ))}
          </ul>
          {/*
            The caption is the rule. Two photographs of the same thing at two
            moments — the difference between them is evidence, and the person
            reading the screen is the one who decides what it means.
          */}
          <p className="text-xs text-muted-foreground">
            שתי תמונות של אותו דבר בשני מועדים. ההפרש ביניהן הוא ראיה, וההכרעה
            מי אחראי היא של אדם — המערכת אינה קובעת אותה ואינה מציעה אותה.
          </p>
        </section>
      )}

      <ul className="flex flex-col divide-y divide-border">
        {evidence.map((item) => (
          <li key={item.id} className="flex flex-col gap-1 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-medium text-foreground">
                {EVIDENCE_KIND_LABEL[item.kind]}
              </span>
              <Badge tone="neutral">{EVIDENCE_SOURCE_LABEL[item.source]}</Badge>
            </div>
            <Reference item={item} />
            <span className="text-xs text-muted-foreground">
              צולם: <When at={item.capturedAt} /> · נרשם:{' '}
              <When at={item.recordedAt} />
            </span>
            {item.note !== null && (
              <span className="text-xs text-muted-foreground">{item.note}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function InspectionComparison({
  steps,
}: {
  steps: readonly InspectionChainStep[]
}) {
  if (steps.length === 0) {
    return (
      <PanelNote>
        אין שתי בדיקות להשוות ביניהן. בלי בדיקה לפני הכניסה אין בסיס להשוואה,
        וזו עובדה על התיק ולא חוסר במסך — היא בדרך כלל מכריעה לטובת האורח.
      </PanelNote>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => {
        const differences = byAttention(step.differences)
        return (
          <section
            key={`${step.from}-${step.to}`}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <h3 className="text-sm font-semibold text-foreground">
              {INSPECTION_STAGE_LABEL[step.from]} →{' '}
              {INSPECTION_STAGE_LABEL[step.to]}
            </h3>

            {differences.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                לא נמצא הפרש בין שתי הבדיקות האלה.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border text-sm">
                {differences.map((difference) => (
                  <li
                    key={difference.key}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
                  >
                    <span className="font-medium text-foreground">
                      {difference.label}
                    </span>
                    <span className="text-muted-foreground">
                      {difference.before === null
                        ? '—'
                        : INSPECTION_CONDITION_LABEL[difference.before]}
                      {' → '}
                      {difference.after === null
                        ? '—'
                        : INSPECTION_CONDITION_LABEL[difference.after]}
                      {difference.quantityBefore !== null &&
                        difference.quantityAfter !== null &&
                        ` (${difference.quantityBefore} → ${difference.quantityAfter})`}
                    </span>
                    <Badge tone="neutral">
                      {DIFFERENCE_KIND_LABEL[difference.kind]}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      <p className="text-xs text-muted-foreground">
        ההשוואה מציגה הפרשים בלבד. היא אינה קובעת שמדובר בנזק, אינה קובעת מי גרם
        לו, ואינה מציעה סכום.
      </p>
    </div>
  )
}
