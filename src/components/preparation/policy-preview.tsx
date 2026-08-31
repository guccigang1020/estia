'use client'

/**
 * The plan the policy actually produces.
 *
 * ── This is not a settings form's confirmation ────────────────────────────
 *
 * Every figure below was computed by `previewPlan` on the server: the same
 * `captureSnapshot` that freezes a real booking's ruleset, and the same
 * `assemblePlan` that `buildPlan` runs. Nothing in this file multiplies,
 * divides or rounds anything. That is the whole difference between a screen
 * somebody trusts and a screen that agrees with the engine right up until it
 * matters.
 *
 * ── The allocation is shown before the list ───────────────────────────────
 *
 * Because it is the part that surprises people. A house with beds for ten and
 * a party of twenty-five needs fifteen mattresses found, and every quantity
 * below — pillows per sleeping place, linen per bed — follows from that
 * sentence rather than from the guest count. Showing the totals without
 * showing where the beds came from would leave the reader unable to check the
 * one step they can actually check.
 *
 * ── Money is absent, and its absence is structural ────────────────────────
 *
 * `labourCost` is optional on `PolicyPreview` because `redact()` deletes the
 * key for a reader without `report.financial.view`. This component renders the
 * line only when the field is present — it does not decide the policy, it
 * observes it. A housekeeping supervisor holds `checklist.manage` and never
 * sees a shekel here.
 */

import {
  describeMinutes,
  UNIT_LABEL,
} from '@/app/(app)/preparation/_lib/labels'
import { cn } from '@/components/ui/cn'
import { formatAgorot } from '@/lib/plans/plan'

import type { PolicyPreview } from '@/app/(app)/preparation/_lib/actions'

const SOURCE_LABEL: Readonly<
  Record<PolicyPreview['beds'][number]['source'], string>
> = {
  permanent: 'מוצבת ומוכנה',
  storage: 'מהמחסן',
  added: 'הובאה במיוחד',
}

export function PolicyPreviewPanel({ preview }: { preview: PolicyPreview }) {
  return (
    <div className="flex flex-col gap-5 rounded-xl border border-primary bg-surface-raised p-4 sm:p-5">
      {preview.problems.length > 0 && (
        <div
          role="status"
          className="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm"
        >
          <p className="font-medium text-foreground">
            המדיניות הזו לא תעבוד כמו שהיא
          </p>
          <ul className="list-inside list-disc text-muted-foreground">
            {preview.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Where the party sleeps ──────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="font-display text-lg font-bold tracking-tight text-foreground">
          איפה החבורה ישנה
        </h3>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="אורחים" value={preview.guests} />
          <Figure
            label="מקומות שינה קבועים"
            value={preview.permanentCapacity}
            note="בלי להזיז כלום"
          />
          <Figure
            label="מקומות שינה בפועל"
            value={preview.sleepingPlaces}
            note="אחרי שהובא מה שצריך"
          />
          <Figure
            label="מיטות נוספות"
            value={preview.extraBeds}
            note="נפתחות או מובאות"
          />
        </div>

        {preview.unplacedGuests > 0 && (
          <p className="rounded-lg border border-danger/40 bg-surface px-4 py-3 text-sm text-foreground">
            {preview.unplacedGuests} אורחים נשארים בלי מקום שינה. הבית או התקרה
            שהוגדרה לו באמת לא מחזיקים את החבורה הזו — זו תשובה, לא תקלה, והצעד
            הבא הוא לשנות את ההזמנה או את הנכס.
          </p>
        )}

        {preview.beds.length > 0 && (
          <ul className="flex flex-col gap-2">
            {preview.beds.map((line) => (
              <li
                key={`${line.bedTypeId}-${line.source}`}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-foreground">
                  {line.label}
                </span>
                <span className="text-muted-foreground">
                  {SOURCE_LABEL[line.source]} · {line.count} יחידות ·{' '}
                  {line.capacity} מקומות שינה
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── The crew and the clock ──────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="צוות מומלץ" value={preview.recommendedStaff} />
        <Figure
          label="מסלול קריטי"
          value={describeMinutes(preview.criticalPathMinutes)}
          note="מה שלא ניתן לעשות במקביל"
        />
        <Figure
          label="משך משוער"
          value={describeMinutes(preview.estimatedMinutes)}
          note={`ציון קושי ${preview.complexityScore}`}
        />
        {preview.labourCost !== undefined && (
          <Figure
            label="עלות עבודה"
            value={formatAgorot(preview.labourCost)}
            note="לפי תעריף השעה השמור"
          />
        )}
      </section>

      {/* ── The plan itself ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="font-display text-lg font-bold tracking-tight text-foreground">
          התוכנית שמנקה מקבלת
        </h3>

        {preview.sections.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
            שום מקטע לא התמלא. זו תשובה אמיתית: אין מיטות לשבץ ואין כלל שנדלק,
            ולכן אין מה למסור למנקה.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {preview.sections.map((section) => (
              <div
                key={section.key}
                className="rounded-lg border border-border bg-surface"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
                  <h4 className="font-medium text-foreground">
                    {section.label}
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {describeMinutes(section.minutes)}
                  </span>
                </div>

                {section.items.length === 0 ? (
                  <p className="px-4 py-2.5 text-sm text-muted-foreground">
                    מוצג כי התבנית ביקשה אותו, ועוד לא נכנס אליו כלום.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {section.items.map((item) => (
                      <li
                        key={`${item.category}-${item.itemId}`}
                        className="flex flex-col gap-1 px-4 py-2.5"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm text-foreground">
                            {item.label}
                            {item.requiresPhoto && (
                              <span className="ms-2 text-xs text-muted-foreground">
                                דורש צילום
                              </span>
                            )}
                          </span>
                          {/* The count a worker ticks off, in the form they
                              see it. Not "מצעים ✓" — the item that gets
                              skipped is always the one nobody counted. */}
                          <span
                            className={cn(
                              'font-display text-sm font-bold text-foreground',
                            )}
                          >
                            0 / {item.requiredCount} {UNIT_LABEL[item.unit]}
                          </span>
                        </div>
                        {item.instructions && (
                          <p className="text-xs text-muted-foreground">
                            {item.instructions}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        חושב מול צילום קפוא של המדיניות שכתובה עכשיו במסך (חתימה{' '}
        <code className="font-mono">{preview.snapshotHash.slice(0, 12)}</code>).
        שתי מדיניות זהות מקבלות אותה חתימה — כך אפשר לדעת בוודאות אם החוקים
        השתנו בין שתי הזמנות. שום דבר לא נשמר בחישוב הזה.
      </p>
    </div>
  )
}

function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string | number
  note?: string
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-display text-xl font-bold tracking-tight text-foreground">
        {value}
      </span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  )
}
