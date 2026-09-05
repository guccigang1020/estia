import { Button } from '@/components/ui/button'
import type { OrganizationStatus } from '@/lib/platform'

import { ORGANIZATION_STATUS_LABEL } from './labels'

/**
 * Suspend and restore.
 *
 * ══ SUSPENDING DELETES NOTHING, AND THE SCREEN SAYS SO ════════════════════
 *
 * `platform_set_organization_status` writes one column. There is no DELETE
 * policy on `organizations` at all, and `audit_events.organization_id` is
 * `on delete restrict` precisely so that losing an organization could never
 * take its history with it. The copy below states that rather than leaving it
 * to be inferred from the absence of a delete button — an absent button is a
 * missing feature, a stated refusal is a property of the record.
 *
 * ── The reason field is required, and it is required by the pipeline ──────
 *
 * `required` on the textarea is a courtesy to whoever is typing. The refusal
 * is `requiresReason: true` on the operation, which produces a field issue on
 * `reason` before a row is read. The customer reads that sentence in their own
 * audit trail afterwards, which is why it is not optional and why the
 * placeholder asks for a case number rather than for a mood.
 *
 * ── Rendered read-only for a colleague who may not use it ─────────────────
 *
 * A support-role staff member sees the panel, sees why they cannot use it, and
 * does not see a screen that pretends the capability is absent from the
 * product. The action re-checks the grant regardless, and so does the database
 * function under it.
 */
export function LifecycleControls({
  organizationId,
  status,
  editable,
  suspendAction,
  restoreAction,
}: {
  organizationId: string
  status: OrganizationStatus
  editable: boolean
  suspendAction: (form: FormData) => Promise<void>
  restoreAction: (form: FormData) => Promise<void>
}) {
  const suspended = status === 'suspended'
  const closed = status === 'closed'

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight">
          מצב החשבון
        </h2>
        <p className="text-sm text-muted-foreground">
          המצב הנוכחי: {ORGANIZATION_STATUS_LABEL[status]}. השהיה משנה עמודה אחת
          — <code dir="ltr">organizations.status</code> — ולא נוגעת בשום רשומה
          עסקית. אין בקונסולה מחיקה של ארגון, ואין מחיקה כזו במסד הנתונים: לטבלה
          אין מדיניות DELETE כלל.
        </p>
      </div>

      {closed ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          החשבון סגור. סגירה היא החלטה בלתי הפיכה של בעל הארגון, תחת הרשאה
          שמוגדרת כשל הבעלים בלבד — קונסולת הפלטפורמה אינה משנה אותה, והפונקציה
          במסד הנתונים מסרבת לכך גם אם מישהו ינסה.
        </p>
      ) : !editable ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          התפקיד שלך אינו כולל{' '}
          <code dir="ltr">platform.organization.manage</code>, ולכן אי אפשר
          להשהות או להחזיר לפעילות מכאן. המסך מוצג ולא מוסתר: היכולת קיימת
          במוצר, היא פשוט לא שלך.
        </p>
      ) : (
        <form
          action={suspended ? restoreAction : suspendAction}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="organizationId" value={organizationId} />

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">
              נימוק (חובה, ונרשם ביומן של הלקוח)
            </span>
            <textarea
              name="reason"
              required
              rows={2}
              placeholder={
                suspended
                  ? 'לדוגמה: התשלום הוסדר, קריאה #4182'
                  : 'לדוגמה: אי-תשלום מתמשך, לבקשת הנהלת החשבונות'
              }
              className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </label>

          <div>
            <Button type="submit" variant={suspended ? 'primary' : 'danger'}>
              {suspended ? 'החזרה לפעילות' : 'השהיית החשבון'}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            {suspended
              ? 'החזרה לפעילות מחזירה את הצוות לעבודה מיידית. שום נתון לא היה חסר בזמן ההשהיה — הוא רק לא היה נגיש.'
              : 'אחרי ההשהיה הצוות של הלקוח לא יוכל לעבוד. כל הנתונים נשמרים, וההחזרה לפעילות היא פעולה אחת.'}
          </p>
        </form>
      )}
    </section>
  )
}
