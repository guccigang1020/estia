import type { Metadata } from 'next'

import { MigrationWizard } from '@/components/migration/wizard'
import { holdsGrant } from '@/lib/authz/can'

import {
  MIGRATION_APPLY,
  WRITE_GRANT_LABEL,
  missingWriteGrants,
  requireMigrationAccess,
} from './_lib/access'
import { applyMigrationAction, dryRunMigrationAction } from './_lib/actions'

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
 * summarises in one line. Every one of those asks for trust rather than earning
 * it, and this is the screen where trust is either earned or the migration is
 * abandoned.
 *
 * THE DRY RUN IS THE POINT. Steps one and two exist to reach it. It reads the
 * whole file against everything already in ESTIA and writes nothing — provably
 * nothing: `dryRun` is synchronous, takes no writer, and the compiler asserts
 * its whole input is plain data. The button that writes is behind it and stays
 * disabled while a single conflict is unsettled.
 *
 * NO IMPORTED STAY EVER REACHES A SUBSCRIBER. The commands the import writes
 * through are built with an event quarantine, and the builder's options type has
 * no `events` field — a live bus cannot be passed in. Eighteen hundred
 * confirmation messages about stays from 2023, sent from the operator's own
 * business on the first day they trusted us, is the one failure this feature
 * cannot recover from.
 *
 * THE ROUTE GATE IS NOT THE WRITE GATE. `integration.manage` decides who may
 * *start* a migration — a stand-in until `migration.view` / `migration.run` /
 * `migration.apply` exist; see `_lib/access.ts`. What each record may do is
 * decided by the domain operation that writes it, and the grants a person is
 * missing are named on screen before they upload anything rather than
 * discovered forty minutes later.
 */
export default async function MigrationPage() {
  const actor = await requireMigrationAccess()
  const missing = missingWriteGrants(actor)

  return (
    <div
      dir="rtl"
      className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          ייבוא נתונים ממערכת קודמת
        </h1>
        <p className="max-w-prose text-muted-foreground">
          ההיסטוריה שלך עוברת איתך. מעלים קובץ, מסבירים איזו עמודה היא מה,
          וקוראים בדיוק מה יקרה — לפני שנכתב שום דבר. הרצה חוזרת של אותו קובץ
          אינה מכפילה כלום.
        </p>
      </header>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground">
          שתי הבטחות, לפני שמתחילים
        </h2>
        <p>
          <strong className="text-foreground">אף אורח לא יקבל הודעה.</strong>{' '}
          ייבוא שהות שהסתיימה ב-2023 אינו שולח הודעה, אינו פותח משימת ניקיון
          ואינו מייצר הכנה. כל אירוע אוטומטי שהייבוא הפיק נחסם, ורשימתו מופיעה
          בדוח הסיום.
        </p>
        <p>
          <strong className="text-foreground">שום שורה לא נמחקת בשקט.</strong>{' '}
          התנגשות בין שתי הזמנות היא עובדה על העסק שלך, לא תקלה בקובץ. היא
          מוצגת עם שני הצדדים ומחכה להחלטה שלך.
        </p>
      </section>

      <MigrationWizard
        actions={{ dryRun: dryRunMigrationAction, apply: applyMigrationAction }}
        mayApply={holdsGrant(actor, MIGRATION_APPLY)}
        missingGrants={missing.map(
          (grant) => WRITE_GRANT_LABEL[grant] ?? grant,
        )}
      />
    </div>
  )
}
