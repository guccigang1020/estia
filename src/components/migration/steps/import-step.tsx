'use client'

/**
 * Step seven: the one act in this feature that writes.
 *
 * ── The button is behind everything else, on purpose ──────────────────────
 *
 * It cannot be reached without a dry run, and it cannot be reached while a
 * single conflict is unsettled — see `blockedReason('import')`, which is tested.
 * A wizard that let somebody click through to "import" without reading what
 * would happen would make the dry run decorative, and the dry run is the only
 * reason anybody would trust this with three years of their business.
 *
 * ── Permission is shown, never simulated ──────────────────────────────────
 *
 * Somebody with `migration.view` and not `migration.apply` gets the whole
 * preview and, here, a sentence saying who has to press it — not a button that
 * fails. The dry run is exactly the document to send that person, so this
 * screen says so.
 *
 * ── What is promised, one last time ───────────────────────────────────────
 *
 * No guest is messaged. The commands the import writes through are built with
 * an event quarantine and the builder's options type has no `events` field, so
 * a live bus cannot be passed in. Eighteen hundred confirmation messages about
 * stays from 2023, sent from the operator's own business on the first day they
 * trusted us, is the one failure this feature could not recover from — and the
 * list of what was blocked appears in the completion report.
 */

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { RecordTable } from '@/components/migration/record-table'
import { useMigration } from '@/components/migration/wizard-state'
import { Button } from '@/components/ui/button'
import { STEP_PATH, blockedReason } from '@/app/(app)/migration/_lib/steps'
import { entityRows } from '@/lib/migration/report'

export function ImportStep() {
  const router = useRouter()
  const { report, completion, runImport, pending, mayApply, progress } =
    useMigration()
  const blocked = blockedReason('import', progress)

  // The import produced a report; the report has its own route, and that is
  // where a finished run belongs. Pushed rather than rendered here so the URL
  // is one somebody can send to whoever asked how the migration went.
  useEffect(() => {
    if (completion !== null) router.push(STEP_PATH.report)
  }, [completion, router])

  if (blocked !== null || report === null) {
    return (
      <StepBlocked
        step="import"
        reason={blocked ?? 'אין הרצה יבשה לייבא לפיה.'}
      />
    )
  }

  const willWrite = entityRows(report).filter((row) => row.valid > 0)

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="import" />

      <section className="flex flex-col gap-3 rounded-xl border border-primary bg-surface-raised p-5 shadow-lift">
        <h3 className="font-display text-base font-bold text-foreground">
          זה מה שייכתב עכשיו
        </h3>
        <ul className="flex flex-col gap-1 text-sm text-foreground">
          {willWrite.map((row) => (
            <li key={row.entity}>
              {row.label}: {row.valid}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          בדיוק מה שההרצה היבשה הראתה, ולא שורה אחת יותר. שורות שכבר יובאו לא
          ייכתבו שנית — הרצה חוזרת של אותו קובץ אינה מכפילה כלום.
        </p>
      </section>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-5 text-sm text-foreground">
        <p>
          <strong>אף אורח לא יקבל הודעה.</strong> ייבוא שהות שהסתיימה ב-2023
          אינו שולח הודעה, אינו פותח משימת ניקיון ואינו מייצר הכנה. כל אירוע
          אוטומטי שהייבוא הפיק נחסם, ורשימתו המלאה תופיע בדוח הסיום.
        </p>
        <p>
          <strong>אפשר לעצור באמצע.</strong> ריצה שנקטעה נרשמת ככזו, ואפשר להריץ
          את אותו קובץ שוב: מה שכבר נכתב יזוהה ולא ייכתב פעמיים.
        </p>
      </div>

      {mayApply ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runImport} disabled={pending}>
            {pending
              ? 'מייבא…'
              : `ייבא ${report.writable.length} רשומות ל-ESTIA`}
          </Button>
          <span className="text-sm text-muted-foreground">
            זו הפעולה היחידה בתהליך שכותבת.
          </span>
        </div>
      ) : (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
        >
          <p className="font-display text-base font-bold">
            הייבוא עצמו דורש הרשאה שאין לכם
          </p>
          <p>
            אתם יכולים להגיע עד לכאן, לקרוא את הכול ולהכריע בהתנגשויות. הכתיבה
            שמורה למי שמחזיק בהרשאת ביצוע הייבוא. ההרצה היבשה היא בדיוק המסמך
            שכדאי להעביר לאדם הזה — היא מתארת את מה שיקרה, במספרים שלכם.
          </p>
        </div>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          הרשומות, שוב
        </h3>
        <RecordTable
          records={report.writable}
          mixedEntities
          caption="הרשימה האחרונה לפני הכתיבה. אותן שורות בדיוק שההרצה היבשה תיארה."
        />
      </section>

      <StepNav back="conflicts" />
    </section>
  )
}
