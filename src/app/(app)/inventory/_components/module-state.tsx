/**
 * What a stock screen shows when there is no stock module.
 *
 * `off` is the default and a legitimate answer, so this is a real page rather
 * than an error or a redirect: somebody clicked "מלאי" and is owed a sentence
 * about why there is nothing there and what switching it on would give them.
 *
 * The first paragraph is the load-bearing one. A person reading "המלאי כבוי"
 * on a product that also runs their bookings needs to be told, immediately,
 * that nothing else is affected — otherwise the reasonable conclusion is that
 * half the product is broken.
 *
 * No `"use client"`: it renders text.
 */

import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import {
  INVENTORY_MODE_LABEL,
  INVENTORY_MODE_SUMMARY,
  type InventoryMode,
} from '@/lib/inventory'

export function ModuleOff({
  provisioned,
  mayConfigure,
}: {
  provisioned: boolean
  mayConfigure: boolean
}) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מודול המלאי כבוי, וזו תשובה לגיטימית ולא הגדרה חסרה. ההזמנות, ההכנה,
          תוכנית הניקיון, חישוב הכביסה והכספים עובדים במלואם. מה שכבוי הוא בדיקת
          המלאי והתחזית בלבד.
        </p>
      </header>

      {!provisioned && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          לא ניתן לקרוא את הגדרות המלאי בהתקנה הזו. המסך מתנהג כאילו המודול
          כבוי, שזו התשובה הבטוחה — אבל ייתכן שחסרה מיגרציה. זה הבדל שכדאי לדעת
          עליו לפני שמדליקים.
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        {(['basic', 'tracked', 'advanced'] as InventoryMode[]).map((mode) => (
          <article
            key={mode}
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <h2 className="font-display text-base font-bold text-foreground">
              {INVENTORY_MODE_LABEL[mode]}
            </h2>
            <p className="text-sm text-muted-foreground">
              {INVENTORY_MODE_SUMMARY[mode]}
            </p>
          </article>
        ))}
      </section>

      {mayConfigure ? (
        <div className="flex flex-wrap gap-3">
          <Button href="/inventory/settings">הגדרות מלאי</Button>
          <Button href="/inventory/import" variant="secondary">
            ייבוא מקובץ
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          הפעלת המודול היא החלטה ארגונית, ולכן היא דורשת הרשאת עריכת מלאי.
        </p>
      )}
    </div>
  )
}

/**
 * The module is on, but this particular screen has nothing to compute from.
 *
 * Separate from `ModuleOff` because "we do not do this" and "nothing to report"
 * are different sentences and a person must not have to guess which an empty
 * list meant.
 */
export function ForecastUnavailable({
  reason,
}: {
  reason: 'no_forecast_capability' | 'no_items' | 'module_off'
}) {
  if (reason === 'no_items') {
    return (
      <EmptyState
        illustration="unit"
        title="אין פריטי מלאי בטווח שלך"
        body="תחזית נבנית מעל פריטים שנספרו. אפשר להוסיף פריט אחד ידנית, להזין כמה בטבלה, או לייבא קובץ."
        action={<Button href="/inventory/entry">הוסף פריטים</Button>}
      />
    )
  }

  if (reason === 'no_forecast_capability') {
    return (
      <EmptyState
        illustration="search"
        title="התחזית אינה פעילה"
        body='תחזית רצה על שריון מלאי להזמנות עתידיות. במצב "ספירה בלבד" אין למה לרוץ — הספירה, נקודת ההזמנה וההתראה על מלאי נמוך ממשיכות לעבוד.'
        action={
          <Button href="/inventory/settings" variant="secondary">
            הגדרות מלאי
          </Button>
        }
      />
    )
  }

  return (
    <EmptyState
      illustration="search"
      title="מודול המלאי כבוי"
      body="ההזמנות, ההכנה והכספים אינם מושפעים."
    />
  )
}
