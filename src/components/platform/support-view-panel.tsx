import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { SupportViewSummary } from '@/lib/platform'

import { hebrewMoment } from './labels'

/**
 * Support views — and a plain statement about what is not built.
 *
 * ══ FULL IMPERSONATION IS NOT BUILT. THIS IS NOT A WEAKER VERSION OF IT ═══
 *
 * The four conditions on real support impersonation are: time-boxed, recorded
 * in `audit_events` as `platform_staff` with the target named, visibly marked
 * inside the impersonated session at all times, and never granting a write the
 * staff member could not otherwise justify.
 *
 * Three of those are met here. The third is not, and cannot be met from the
 * platform console: marking an impersonated session requires the CUSTOMER'S
 * OWN application shell to render the marking, and a session a customer cannot
 * distinguish from their own is precisely the weak version worth refusing to
 * ship. So there is no impersonation, no session switch, and no button that
 * looks like one.
 *
 * What there is: a record that a named staff member opened a READ-ONLY view of
 * one account, why, and until when. It confers nothing — every read on the
 * account screen is authorised by the platform role whether a view is open or
 * not, and deleting every row in `platform_support_sessions` would not close a
 * single door. The panel says that out loud, because a reader who assumes
 * otherwise would think the console can do something it cannot, and would tell
 * a customer so.
 */
export function SupportViewPanel({
  organizationId,
  views,
  failure,
  editable,
  openAction,
  closeAction,
  currentStaffUserId,
}: {
  organizationId: string
  views: readonly SupportViewSummary[]
  /** A correlation id when the list could not be read. Never an empty list. */
  failure: string | null
  editable: boolean
  openAction: (form: FormData) => Promise<void>
  closeAction: (form: FormData) => Promise<void>
  currentStaffUserId: string
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div>
        <h2 className="font-display text-lg font-bold tracking-tight">
          צפיית תמיכה
        </h2>
        <p className="text-sm text-muted-foreground">
          רישום תחום בזמן, עם נימוק, של פתיחת צפייה בקריאה בלבד בחשבון הזה.
        </p>
      </div>

      <div className="rounded-lg border border-primary bg-primary-soft px-4 py-3 text-sm text-primary">
        <p className="font-semibold">התחזות מלאה אינה קיימת במוצר.</p>
        <p className="mt-1 leading-relaxed">
          התנאי הרביעי להתחזות אמיתית הוא שהחיבור המתחזה יסומן כל הזמן בתוך
          הממשק של הלקוח עצמו. הסימון הזה חי במעטפת האפליקציה של הלקוח, וחיבור
          שהלקוח אינו יכול להבחין בינו לבין שלו הוא בדיוק הגרסה החלשה שלא ראוי
          לשלוח. לכן אין כאן החלפת זהות, אין הרשאת כתיבה בשם אף אחד, ואין כפתור
          שנראה כאילו יש.
        </p>
        <p className="mt-1 leading-relaxed">
          מה שיש: רישום שנפתחה צפייה, בידי מי, מדוע ועד מתי. הוא אינו מעניק שום
          הרשאה — הקריאות במסך הזה מותרות מתוקף התפקיד בפלטפורמה בין אם הצפייה
          פתוחה ובין אם לא.
        </p>
      </div>

      {failure !== null ? (
        <p className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm">
          רשימת הצפיות לא נטענה. אין להסיק מכך שאיש לא צפה בחשבון הזה. מזהה
          מעקב: <code dir="ltr">{failure}</code>
        </p>
      ) : views.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          איש מ-ESTIA לא פתח צפייה בחשבון הזה. השורות כאן נכתבות בפועל בזמן
          עבודה, ולכן ריקן משמעו שלא נפתחה צפייה — ולא שהרשימה לא נטענה.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {views.map((view) => (
            <li
              key={view.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">{view.reason}</p>
                <p className="text-xs text-muted-foreground">
                  נפתחה {hebrewMoment(view.startedAt)} · בתוקף עד{' '}
                  {hebrewMoment(view.expiresAt)}
                  {view.endedAt && ` · נסגרה ${hebrewMoment(view.endedAt)}`}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Badge tone={view.open ? 'accent' : 'neutral'}>
                  {view.open ? 'פתוחה' : view.endedAt ? 'נסגרה' : 'פג תוקף'}
                </Badge>

                {/*
                  Only your own, and only while it is open. The policy says the
                  same thing — `staff_user_id = auth.uid()` — and the adapter
                  filters on it too, so a mistyped id closes nothing rather
                  than closing a colleague's session.
                */}
                {editable &&
                  view.open &&
                  view.staffUserId === currentStaffUserId && (
                    <form action={closeAction}>
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organizationId}
                      />
                      <input type="hidden" name="sessionId" value={view.id} />
                      <Button type="submit" variant="secondary" size="sm">
                        סגירה
                      </Button>
                    </form>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form action={openAction} className="flex flex-col gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">
              נימוק (חובה, ונרשם ביומן של הלקוח)
            </span>
            <textarea
              name="reason"
              required
              rows={2}
              placeholder="לדוגמה: בדיקת תקלה בדוח הכנסות, קריאה #4182"
              className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </label>

          <label className="flex max-w-xs flex-col gap-1.5 text-sm">
            <span className="font-medium">משך (דקות)</span>
            <select
              name="minutes"
              defaultValue="60"
              className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <option value="15">15</option>
              <option value="30">30</option>
              <option value="60">60</option>
              <option value="120">120</option>
              <option value="240">240 (המקסימום)</option>
            </select>
            <span className="text-xs text-muted-foreground">
              ארבע שעות הן התקרה, והיא נאכפת גם ב-CHECK על הטבלה. מגבלה שנאכפת
              רק במסך שמבקש אותה נאכפת בידי מי שמבקש.
            </span>
          </label>

          <div>
            <Button type="submit">פתיחת צפייה בקריאה בלבד</Button>
          </div>
        </form>
      ) : (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
          התפקיד שלך אינו כולל <code dir="ltr">platform.impersonate</code>, ולכן
          אי אפשר לפתוח צפייה מכאן. הרישומים הקיימים מוצגים, כי מי שרשאי לראות
          חשבון רשאי לראות מי מ-ESTIA צפה בו.
        </p>
      )}
    </section>
  )
}
