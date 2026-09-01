import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { capabilitiesFor } from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { InventorySettingsForm } from '../_components/settings-form'

export const metadata: Metadata = { title: 'הגדרות מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Whether the module exists, and how
 * much of it.
 *
 * `inventory.edit` AND NOT `inventory.adjust`. 0012 keeps them apart and the
 * reason applies exactly here: adjust moves a quantity, edit changes what the
 * product *is* for this organization. Turning the forecast off is not a
 * housekeeping decision.
 *
 * NO MODULE GATE ON THIS SCREEN. It is the one page that must render when the
 * module is off, because it is where it gets turned on. Every other stock
 * route refuses first; this one is the door.
 *
 * A MISSING ROW IS `off`. The adapter answers the absence with the default
 * rather than raising, so a business that has never opened this screen sees a
 * form filled with the defaults and not an error.
 */
export default async function InventorySettingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.edit'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const { settings, provisioned } = await new SupabaseInventoryRepository(
    await createClient(),
  ).loadSettings(actor.organizationId)

  const capabilities = capabilitiesFor(settings)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הגדרות מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          כמה חשבון מלאי העסק הזה ביקש. ״כבוי״ הוא ברירת המחדל ותשובה לגיטימית —
          הזמנות, הכנה, תוכנית ניקיון, חישוב כביסה וכספים עובדים במלואם בלי
          שנספר ולו מגבת אחת.
        </p>
      </header>

      {!provisioned && (
        <p
          role="alert"
          className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-foreground"
        >
          לא ניתן לקרוא את טבלת ההגדרות בהתקנה הזו, ולכן המסך מציג את ברירות
          המחדל. שמירה תיכשל עד שהמיגרציה תרוץ. זו תקלת פריסה ולא בחירה של העסק,
          וההבדל חשוב.
        </p>
      )}

      <InventorySettingsForm settings={settings} />

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground">מה פעיל כרגע</h2>
        <ul className="grid gap-1 sm:grid-cols-2">
          <li>ספירה: {capabilities.counting ? 'כן' : 'לא'}</li>
          <li>שריון: {capabilities.reservations ? 'כן' : 'לא'}</li>
          <li>תחזית: {capabilities.forecast ? 'כן' : 'לא'}</li>
          <li>מחזור כביסה: {capabilities.circulation ? 'כן' : 'לא'}</li>
          <li>העברות: {capabilities.transfers ? 'כן' : 'לא'}</li>
          <li>פערי ספירה: {capabilities.discrepancies ? 'כן' : 'לא'}</li>
        </ul>
        <p>
          ״מחזור כביסה״ תלוי גם בזמן מחזור שהוגדר: בלי מספר, ״זה חוזר״ הוא משפט
          בלי תאריך והתחזית לא תמציא אחד.
        </p>
      </section>

      <nav aria-label="מסכים נוספים" className="flex flex-wrap gap-3">
        <Button href="/inventory" variant="secondary">
          חזרה ללוח המלאי
        </Button>
      </nav>
    </div>
  )
}
