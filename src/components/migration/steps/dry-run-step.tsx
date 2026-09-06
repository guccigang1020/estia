'use client'

/**
 * Step five: the screen that earns the migration.
 *
 * ══ WHY THIS IS THE MOST PROMINENT SCREEN IN THE FEATURE ══════════════════
 *
 * A person is about to move three years of their business into a product they
 * have used for twenty minutes. Nothing on the upload step or the mapping step
 * makes that reasonable; this does. It says, in their own numbers and before
 * anything is written, exactly what will happen — and every count on it opens
 * into the rows behind it, because a total nobody can check against their own
 * spreadsheet is a total nobody will press a button on.
 *
 * ── The claim that it writes nothing is checkable, not asserted ───────────
 *
 * `dryRun` takes no writer, no repository, no client and no callback; it is
 * synchronous, so it cannot await any of the asynchronous write paths in this
 * codebase; and the compiler asserts that its whole input is plain data. Those
 * three facts are stated on the screen in a form an operator can act on — "ask
 * anyone technical to read the first ten lines of dryrun.ts" — because a
 * promise that can be verified is a different kind of promise.
 *
 * ── The order of the sections is the argument ─────────────────────────────
 *
 *   1. What will happen, per entity, with every column shown.
 *   2. What will NOT be imported, and why — the part they can still fix.
 *   3. The decisions only they can settle.
 *   4. The guests who may already be here — offered, never merged.
 *   5. What will be written, listed.
 *
 * A report that opened with "1,847 ✓" would be read as a success message and
 * the forty problems under it would not be read at all.
 */

import Link from 'next/link'

import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { DryRunSummary } from '@/components/migration/dry-run-summary'
import { IssueList } from '@/components/migration/issue-list'
import { RecordTable } from '@/components/migration/record-table'
import { useMigration } from '@/components/migration/wizard-state'
import { Button } from '@/components/ui/button'
import { STEP_PATH, blockedReason } from '@/app/(app)/migration/_lib/steps'

export function DryRunStep() {
  const { report, runDryRun, pending, progress, validation } = useMigration()
  const blocked = blockedReason('dry_run', progress)

  if (blocked !== null) {
    return <StepBlocked step="dry_run" reason={blocked} />
  }

  if (report === null) {
    return (
      <section className="flex flex-col gap-5">
        <StepHeader step="dry_run" />

        <div className="flex flex-col gap-4 rounded-xl border border-primary bg-surface-raised p-5 shadow-lift">
          <p className="text-sm text-foreground">
            עד כאן הכול קרה בדפדפן שלכם. ההרצה היבשה היא הפעם הראשונה שהקובץ
            נשלח, והיא נחוצה מסיבה אחת: אי אפשר לדעת אם שהות מתנגשת עם משהו
            אצלכם בלי להשוות אותה למה שכבר קיים ב-ESTIA — ואת היומן שלכם לא נשלח
            לדפדפן.
          </p>
          <p className="text-sm text-muted-foreground">
            {validation === null
              ? ''
              : `${validation.records.length} שורות ייבדקו מול היומן, מול האורחים הקיימים ומול הרישום של מה שכבר יובא.`}{' '}
            ההשוואה עצמה אינה כותבת דבר.
          </p>
          <div>
            <Button onClick={runDryRun} disabled={pending}>
              {pending ? 'בודק…' : 'הרץ הרצה יבשה'}
            </Button>
          </div>
        </div>

        <StepNav back="validate" />
      </section>
    )
  }

  const errors = report.issues.filter((issue) => issue.severity === 'error')
  const warnings = report.issues.filter((issue) => issue.severity === 'warning')
  const undecided = report.conflicts.filter(
    (conflict) => conflict.decision === 'undecided',
  )

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="dry_run" />

      <DryRunSummary report={report} />

      {report.empty && (
        <p
          role="status"
          className="rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
        >
          ההרצה היבשה לא מצאה שורה אחת לכתיבה. זה אינו כישלון של הקובץ בהכרח —
          ייתכן שכל השורות כבר יובאו בעבר, וייתכן שהמיפוי החמיץ שדה חובה.
          הרשימות למטה אומרות איזה מהשניים.
        </p>
      )}

      {undecided.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-danger bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            {undecided.length} החלטות ממתינות לכם
          </h3>
          <p className="text-sm text-muted-foreground">
            שום שורה לא נמחקה בגלל התנגשות ושום החלטה לא נבחרה עבורכם. עד
            שיוכרעו, השורות האלה לא ייובאו והייבוא נשאר סגור.
          </p>
          <div>
            <Link
              href={STEP_PATH.conflicts}
              className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-[0.9375rem] font-medium text-primary-foreground shadow-soft hover:bg-primary/90"
            >
              לעבור על ההתנגשויות
            </Link>
          </div>
        </section>
      )}

      <IssueList
        title="שורות שלא ייובאו"
        description="כל שורה כאן נדחתה לבדה, והשאר ייובא. מספרי השורות הם אלה שבגיליון שלכם."
        issues={errors}
        emptyNote="אף שורה לא נדחתה."
      />

      {report.duplicates.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            אורחים שייתכן שכבר קיימים ({report.duplicates.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            ההתאמה נעשתה לפי מספר טלפון מנורמל או אימייל מאומת בלבד — לעולם לא
            לפי שם. איחוד שגוי מדביק שתי היסטוריות של שתי משפחות זו לזו, וכמעט
            בלתי אפשרי לפרק אותו אחר כך. לכן שום דבר כאן לא אוחד.
          </p>
          <ul className="flex flex-col gap-2">
            {report.duplicates.map((duplicate) => (
              <li
                key={`${duplicate.rowNumber}-${duplicate.existingId}`}
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
              >
                <span className="text-muted-foreground">
                  שורה {duplicate.rowNumber}:
                </span>{' '}
                <span className="font-medium text-foreground">
                  {duplicate.incomingLabel}
                </span>{' '}
                <span className="text-muted-foreground">
                  נראה כמו {duplicate.existingLabel}, לפי{' '}
                  {duplicate.matchedOn === 'phone' ? 'טלפון' : 'אימייל'}{' '}
                </span>
                <span dir="ltr" className="text-muted-foreground">
                  {duplicate.matchedValue}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <IssueList
        title="אזהרות"
        description="השורות האלה ייובאו. שדה אחד בכל אחת מהן לא נקרא, וכתוב מה הונח במקומו."
        issues={warnings}
        emptyNote="אין אזהרות."
      />

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h3 className="font-display text-base font-bold text-foreground">
          מה ייכתב, שורה אחר שורה ({report.writable.length})
        </h3>
        <RecordTable
          records={report.writable}
          mixedEntities
          caption="בסדר שבו ייכתב: נכס לפני יחידה, יחידה לפני הזמנה. פתחו שורה כדי לראות בדיוק מה יישמר."
        />
      </section>

      {report.unsupported.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-bold text-foreground">
            שורות תקינות שהמוצר עדיין לא יודע לכתוב ({report.unsupported.length}
            )
          </h3>
          <RecordTable
            records={report.unsupported}
            mixedEntities
            caption="הקובץ שלכם תקין. לגוף הזה עדיין אין פעולת יצירה, ולכן הוא נקרא, נבדק, ולא נכתב. אפשר יהיה להריץ את אותו קובץ שוב כשהיא תתווסף, בלי ליצור כפילות."
          />
        </section>
      )}

      <StepNav
        back="validate"
        forward="conflicts"
        forwardBlocked={blockedReason('conflicts', progress)}
      >
        <Button variant="secondary" onClick={runDryRun} disabled={pending}>
          {pending ? 'בודק…' : 'הרץ שוב'}
        </Button>
      </StepNav>
    </section>
  )
}
