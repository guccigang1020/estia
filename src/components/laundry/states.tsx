/**
 * The three things a laundry screen may have to say instead of showing work.
 *
 * They are together in one file because the mistake they exist to prevent is
 * the same one: rendering an empty version of a screen when the honest answer
 * is "there is nothing here, and here is why". An empty orders list under a
 * business that has no laundry operation is a promise that orders exist; an
 * empty provider list shown to a cleaner is a claim about their employer; an
 * empty dashboard caused by a wiring gap looks like a quiet week.
 *
 * Each of these says the true thing, and each says what to do about it.
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { entitlementLabel } from '@/components/nav/labels'
import type { Entitlement } from '@/lib/plans/entitlements'

/* ------------------------------------------------------- the mode is off -- */

export type ModeOffProps = {
  /** Whether this reader could actually change it. Checked by the page. */
  mayConfigure: boolean
}

/**
 * "This section does not pretend to exist."
 *
 * `off` is a first-class answer and the default. Preparation, the cleaner's
 * plan and every arrival work completely without any of this, so the page says
 * that plainly rather than apologising — and it does NOT show an empty
 * dashboard, an empty order list or a forecast of zero, all three of which
 * would imply an operation that has nothing in it rather than one that does not
 * exist.
 *
 * The menu entry is hidden separately, by the coordinator, from the same mode.
 * This page exists for somebody who arrived by a bookmark or a link.
 */
export function LaundryModeOff({ mayConfigure }: ModeOffProps) {
  return (
    <section
      role="status"
      aria-labelledby="laundry-off-title"
      className="flex w-full flex-col gap-4 rounded-xl border border-border bg-surface px-5 py-7 shadow-soft sm:px-8"
    >
      <Badge>לא בשימוש</Badge>

      <h2
        id="laundry-off-title"
        className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
      >
        ניהול הכביסה כבוי בעסק הזה
      </h2>

      <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
        זו אינה תקלה ואינה חוסר הרשאה. ההכנה לאירוח, רשימת המשימות של הצוות
        ובדיקת המוכנות לפני כניסת אורח עובדות במלואן בלי המודול הזה — הוא נועד
        לעסקים שמנהלים מלאי מצעים או עובדים מול מכבסה, ומי שלא צריך אותו לא
        מפסיד דבר.
      </p>

      <ul className="flex flex-col gap-2 text-sm text-foreground">
        {[
          'רשימה של מה צריך להיות נקי ועד מתי — בלי מלאי ובלי הזמנות.',
          'מעקב אחרי כביסה שנעשית בבית, עם מי שאחראי ומה מצבה.',
          'הזמנות מסודרות למכבסה חיצונית, כולל בדיקה שזמן הטיפול מספיק.',
          'צפי לימים הקרובים, מחושב מהזמנות מאושרות בלבד.',
        ].map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full bg-border-strong"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {mayConfigure ? (
        <p className="text-sm text-muted-foreground">
          כדי להפעיל, בחר את אופן העבודה בהגדרות הכביסה. אפשר להתחיל ברשימה בלבד
          ולהרחיב אחר כך.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          הפעלת המודול נעשית על ידי מנהל הארגון.
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------ plan lock -- */

export type PlanLockProps = {
  entitlement: Entitlement | null
  mayReachBilling: boolean
}

/**
 * "Your package does not include this", said as an offer.
 *
 * The third of its kind in the codebase and it inherits the whole argument
 * from `automations/_components/plan-lock.tsx`: `authorize()` returns two
 * different noes, and rendering "you may not" for "your package does not
 * include it" sends somebody to an administrator who cannot help them.
 *
 * It quotes no price, for the reason that lock states: an organization's real
 * price can differ from the catalogue's, and quoting the list price at
 * somebody holding a negotiated one is a number they will hold the business to.
 */
export function LaundryPlanLock({
  entitlement,
  mayReachBilling,
}: PlanLockProps) {
  const feature = entitlement === null ? null : entitlementLabel(entitlement)

  return (
    <section
      role="status"
      aria-labelledby="laundry-lock-title"
      className="flex w-full flex-col gap-5 rounded-xl border border-border-strong bg-surface-raised px-5 py-7 shadow-soft sm:px-8 sm:py-9"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="accent">לא כלול בחבילה</Badge>
        {feature !== null && (
          <span className="text-sm text-muted-foreground">
            היכולת נקראת{' '}
            <span className="font-semibold text-foreground">{feature}</span>
          </span>
        )}
      </div>

      <h2
        id="laundry-lock-title"
        className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl"
      >
        ניהול הכביסה אינו כלול בחבילה הנוכחית
      </h2>

      <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
        ההרשאות שלך תקינות והמסך פתוח בפניך — מה שחסר הוא היכולת בחבילה של העסק.
        אפשר להוסיף אותה בלי להחליף חבילה.
      </p>

      {mayReachBilling ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button href="/settings/billing" variant="primary">
            לצפייה בחבילה ובחיוב
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          שינוי חבילה נעשה על ידי בעלי הארגון. אין צורך לבקש הרשאה — ההרשאה
          קיימת.
        </p>
      )}
    </section>
  )
}

/* --------------------------------------------------------- a wiring gap -- */

export type DatasetGapProps = {
  table: string
  detail: string
}

/**
 * The demo dataset has never heard of one of these tables.
 *
 * `DemoDatabase.rows` throws rather than answering `[]`, deliberately: an
 * empty array would render a clean empty state, and that state is the demo
 * asserting this business has no laundry when in truth nobody wired the table
 * up. This panel is that distinction, on screen.
 *
 * It names the table and the file, because the person most likely to see it is
 * the person who can fix it in one line.
 */
export function LaundryDatasetGap({ table, detail }: DatasetGapProps) {
  return (
    <section
      role="alert"
      aria-labelledby="laundry-gap-title"
      className="flex w-full flex-col gap-3 rounded-xl border border-danger/40 bg-surface px-5 py-6 shadow-soft"
    >
      <Badge tone="accent">חסר במאגר ההדגמה</Badge>

      <h2
        id="laundry-gap-title"
        className="font-display text-lg font-bold tracking-tight text-foreground"
      >
        המסך הזה אינו יכול להציג נתונים כרגע
      </h2>

      <p className="text-sm leading-relaxed text-muted-foreground">
        מאגר ההדגמה אינו מכיר את הטבלה{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {table}
        </code>
        . זו תקלת חיווט ולא מצב אמיתי של העסק — ולכן המסך אומר זאת במפורש במקום
        להציג רשימה ריקה, שנקראת כאילו אין לעסק כביסה כלל.
      </p>

      <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </section>
  )
}
