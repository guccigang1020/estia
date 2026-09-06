/**
 * The two empty states this feature actually has, and they are not the same.
 *
 * ── "Nothing imported yet" is not an error ────────────────────────────────
 *
 * The import tables are live and empty on every new deployment, and every
 * organization's first visit to this screen is an empty one. An empty history
 * is the normal, expected, correct state of a migration screen, and rendering
 * it as a warning would greet a new customer with a red panel on the first
 * screen of the relationship.
 *
 * ── "This deployment cannot store an import" is somebody's mistake ────────
 *
 * A different sentence, on purpose. The reads in `_lib/queries.ts` answer
 * `provisioned: false` rather than throwing when the four import tables are
 * absent, precisely so the screen can tell the two situations apart. Collapsing
 * them into one message would send an operator looking for their missing data
 * when nothing is missing, or reassure them when the ledger that stops a second
 * run duplicating everything is not there.
 */

import { EmptyState } from '@/components/states/empty-state'

export function NoImportsYet({ action }: { action?: React.ReactNode }) {
  return (
    <EmptyState
      illustration="calendar"
      title="עוד לא הרצתם ייבוא"
      body="זה המצב הרגיל בהתחלה, לא תקלה. ההיסטוריה שלכם עדיין במערכת הקודמת, ומכאן מעבירים אותה — קובץ אחד בכל פעם, עם הרצה יבשה לפני כל כתיבה."
      action={action}
    />
  )
}

/**
 * The import schema is not applied here.
 *
 * Stated as its own panel rather than as a disabled button, because the dry run
 * genuinely still works: the file can be read, mapped, validated and previewed
 * against everything already in ESTIA. What is missing is the ledger that makes
 * a second run of the same file harmless, and that is exactly the thing an
 * operator must be told before they press the button twice.
 */
export function NotProvisioned() {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
    >
      <p className="font-display text-base font-bold">
        טבלאות הייבוא לא הוחלו על ההתקנה הזו
      </p>
      <p>
        אפשר לקרוא את הקובץ, למפות אותו ולהריץ הרצה יבשה — כל אלה אינם נוגעים
        בטבלאות האלה. מה שחסר הוא הרישום של מה שכבר יובא, וזה בדיוק מה שמונע
        מהרצה שנייה של אותו קובץ להכפיל הכול. עד שיוחל, אל תריצו ייבוא פעמיים.
      </p>
    </div>
  )
}
