import type { Metadata } from 'next'
import Link from 'next/link'

import { NoImportsYet } from '@/components/migration/migration-empty'

import { MIGRATION_STEPS, STEP_LEAD, STEP_PATH, STEP_TITLE } from './_lib/steps'

export const metadata: Metadata = { title: 'ייבוא נתונים ממערכת קודמת' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Moving a business into ESTIA.
 *
 * WHY THIS SCREEN IS A SALES CAPABILITY AND NOT AN ADMIN TOOL. An operator with
 * three years of stays in another PMS does not evaluate this product on its
 * calendar. They ask one question — "does my history come with me" — and every
 * answer except "yes" ends the conversation before any other screen is opened.
 * So this is the first screen of the relationship, and it is written for
 * somebody who has not yet decided to trust us.
 *
 * WHAT IS DELIBERATELY NOT HERE. A progress bar with a percentage and nothing
 * under it. A single "1,847 imported" number. A confirmation dialog that
 * summarises in one line. Every one of those asks for trust rather than
 * earning it, and this is the screen where trust is either earned or the
 * migration is abandoned.
 *
 * AN EMPTY HISTORY IS NOT AN ERROR. Every organization's first visit here is an
 * empty one, and the four import tables are empty on a new deployment by
 * definition. The empty state says "you have not run one yet" and offers the
 * first step; it does not apologise, and it is not a warning.
 *
 * THE DRY RUN IS THE POINT. The four steps before it exist to reach it. It
 * reads the whole file against everything already in ESTIA and writes nothing —
 * provably nothing: `dryRun` is synchronous, takes no writer, and the compiler
 * asserts its whole input is plain data. The step that writes is behind it and
 * stays closed while a single conflict is unsettled.
 *
 * THE ROUTE GATE IS NOT THE WRITE GATE. `migration.view` decides who may open
 * this flow and read a dry run; `migration.apply` decides who may execute it;
 * and what each *record* may do is decided by the domain operation that writes
 * it. The grants a person is missing are named on screen before they upload
 * anything rather than discovered forty minutes later — see `_lib/access.ts`.
 */
export default function MigrationPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-5 text-sm text-muted-foreground">
        <h2 className="font-display text-base font-bold text-foreground">
          שתי הבטחות, לפני שמתחילים
        </h2>
        <p>
          <strong className="text-foreground">אף אורח לא יקבל הודעה.</strong>{' '}
          ייבוא שהות שהסתיימה ב-2023 אינו שולח הודעה, אינו פותח משימת ניקיון
          ואינו מייצר הכנה. כל אירוע אוטומטי שהייבוא הפיק נחסם, ורשימתו המלאה
          מופיעה בדוח הסיום — הבטחה עם רשימה מתחתיה היא היחידה שאפשר לבדוק.
        </p>
        <p>
          <strong className="text-foreground">שום שורה לא נמחקת בשקט.</strong>{' '}
          התנגשות בין שתי הזמנות היא עובדה על העסק שלכם, לא תקלה בקובץ. היא
          מוצגת עם שני הצדדים וממתינה להחלטה שלכם, ושורה שלא הוכרעה פשוט לא
          תיובא.
        </p>
      </section>

      <NoImportsYet
        action={
          <Link
            href={STEP_PATH.upload}
            className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-[0.9375rem] font-medium text-primary-foreground shadow-soft hover:bg-primary/90"
          >
            להתחיל: בחירת קובץ
          </Link>
        }
      />

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-display text-base font-bold text-foreground">
          מה יקרה, בשמונה שלבים
        </h2>
        <p className="text-sm text-muted-foreground">
          חמשת הראשונים אינם כותבים דבר, וארבעת הראשונים אפילו לא שולחים את
          הקובץ לשום מקום. אפשר לעצור בכל אחד מהם.
        </p>
        <ol className="flex flex-col gap-2">
          {MIGRATION_STEPS.map((step, index) => (
            <li key={step} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground"
              >
                {index + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">
                  {STEP_TITLE[step]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {STEP_LEAD[step]}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
