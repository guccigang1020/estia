'use client'

/**
 * The three things a person must be told on every step, not only on the last one.
 *
 * ── Missing write grants are named before anything is uploaded ────────────
 *
 * Discovering after a forty-minute mapping session that you were never allowed
 * to write bookings is the worst possible moment to find out. The route gate
 * decides who may *start* a migration; the domain operations decide what each
 * record may do, and refuse per row. This banner is the difference between
 * finding that out now and finding it out in the completion report.
 *
 * ── A failure is a sentence, never a blank screen ─────────────────────────
 *
 * Neither Server Action throws: a throw inside one reaches the browser as a
 * digest and an empty page, which on this screen would also lose the twenty
 * minutes somebody spent on the mapping. What comes back instead is a safe
 * error body, and this is where it is read.
 *
 * Client, because all three facts live in the wizard's in-tab state.
 */

import { NotProvisioned } from './migration-empty'
import { useMigration } from './wizard-state'

export function MigrationNotices() {
  const { missingGrants, provisioned, failure, mayApply } = useMigration()

  return (
    <div className="flex flex-col gap-3 empty:hidden">
      {!mayApply && (
        <p
          role="status"
          className="rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
        >
          יש לכם הרשאת צפייה בייבוא ולא הרשאת ביצוע. אפשר להעלות קובץ, למפות
          אותו ולקרוא את ההרצה היבשה במלואה — הכתיבה עצמה תמתין למי שמחזיק
          בהרשאה. זה מכוון: הרצה יבשה היא בדיוק המסמך שכדאי להעביר לאדם הזה.
        </p>
      )}

      {missingGrants.length > 0 && (
        <p
          role="status"
          className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-foreground"
        >
          חסרות לכם הרשאות כתיבה: {missingGrants.join(', ')}. אפשר לקרוא את
          הקובץ ולהריץ הרצה יבשה, אבל שורות שדורשות את ההרשאות האלה יידחו בייבוא
          עצמו — שורה־שורה, עם ציון ההרשאה החסרה.
        </p>
      )}

      {!provisioned && <NotProvisioned />}

      {failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          {failure}
        </p>
      )}
    </div>
  )
}
