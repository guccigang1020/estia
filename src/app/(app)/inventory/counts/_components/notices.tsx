/**
 * EXECUTION CONTEXT — SERVER COMPONENTS. The four sentences that are not a
 * stocktake.
 *
 * Each of these is a *different* fact and gets a different sentence, because
 * they call for different actions:
 *
 *   the tables are not installed — the deployment is behind, and nobody at
 *   this business can do anything about it, so the screen says so plainly
 *   instead of showing an empty list that reads as "you have never counted";
 *
 *   the session is not there — a stale link or a deleted row;
 *
 *   the session belongs to a property this membership does not reach — which
 *   is not the same as "does not exist", and saying "not found" to somebody
 *   who is simply out of scope sends them looking for a bug;
 *
 *   nothing has been counted yet — the ordinary starting state, and the only
 *   one of the four that is good news.
 */

import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'

export function NotProvisioned() {
  return (
    <EmptyState
      illustration="unit"
      title="ספירות מלאי אינן מותקנות בסביבה הזו"
      body="הטבלאות שספירת מלאי נשענת עליהן טרם הותקנו בבסיס הנתונים. אין כאן תקלה בנתונים שלך ואין מה לתקן מהמסך — שאר מסכי המלאי ממשיכים לעבוד כרגיל. ברגע שהמיגרציה תרוץ, המסך הזה יעבוד בלי שינוי נוסף."
      action={
        <Button href="/inventory" variant="secondary">
          חזרה למלאי
        </Button>
      }
    />
  )
}

export function SessionNotFound() {
  return (
    <EmptyState
      illustration="unit"
      title="הספירה לא נמצאה"
      body="ייתכן שהקישור ישן או שהספירה נמחקה. רשימת הספירות מציגה את מה שקיים."
      action={
        <Button href="/inventory/counts" variant="secondary">
          לרשימת הספירות
        </Button>
      }
    />
  )
}

export function SessionNotReadable() {
  return (
    <EmptyState
      illustration="unit"
      title="הספירה שייכת לנכס שאינו בהיקף שלך"
      body="הספירה קיימת, אבל היא נערכה בנכס שההרשאה שלך אינה מגיעה אליו. זו אינה תקלה — אם צריך גישה, מנהל המרחב יכול להרחיב את ההיקף."
      action={
        <Button href="/inventory/counts" variant="secondary">
          לרשימת הספירות
        </Button>
      }
    />
  )
}

export function NoSessionsYet({ mayCount }: { mayCount: boolean }) {
  return (
    <EmptyState
      illustration="unit"
      title="עדיין לא נערכה ספירה"
      body={
        mayCount
          ? 'ספירה פיזית היא הדרך היחידה לדעת אם הרישום נכון. פתח ספירה בטופס שלמעלה — היא לא משנה שום כמות עד שההפרשים מסווגים.'
          : 'עדיין לא נערכה ספירה בנכסים שההרשאה שלך מגיעה אליהם. פתיחת ספירה דורשת הרשאת עדכון מלאי.'
      }
    />
  )
}
