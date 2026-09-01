import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { capabilitiesFor } from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { ModuleOff } from '../_components/module-state'
import { StockEntryForm } from '../_components/stock-entry-form'

export const metadata: Metadata = { title: 'הזנת מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Getting stock into the product.
 *
 * ONBOARDING A SINGLE VILLA OWNER CAN FINISH. That is the requirement this
 * screen is measured against, and it is why there are two doors on it and a
 * third on `/inventory/import`: one item at a time for the thing somebody just
 * bought, a spreadsheet-shaped paste for the initial load, and a file with a
 * downloadable template for the operator who exported from another system.
 *
 * THE PROPERTY LIST IS THE SCOPE'S. A membership narrowed to one property gets
 * one option, and the action re-checks it — `assertCan` with the property in
 * the resource — because a `<select>` is a thing a browser can edit.
 *
 * THE OPENING QUANTITY IS A MOVEMENT. 0011 derives `quantity` from the ledger
 * by trigger. So an item created with fifty towels gets a `receipt` row saying
 * "ספירת פתיחה", and the very first number in the ledger has a row explaining
 * where it came from.
 */
export default async function InventoryEntryPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.edit'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const { settings, provisioned } = await new SupabaseInventoryRepository(
    await createClient(),
  ).loadSettings(actor.organizationId)

  if (!capabilitiesFor(settings).enabled) {
    return (
      <ModuleOff
        provisioned={provisioned}
        mayConfigure={holdsGrant(actor, 'inventory.edit')}
      />
    )
  }

  const properties = context.properties.map((property) => ({
    id: property.id,
    name: property.name ?? property.id,
  }))

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הזנת מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          פריט אחד, או גיליון שלם. הכמות תמיד נרשמת כתנועה ביומן ולא כמספר שנכתב
          לעמודה, כך שכל ספירה במוצר היא סכום של שורות שאפשר לקרוא.
        </p>
      </header>

      {properties.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          אין נכס בטווח החברות שלך, ומלאי משויך תמיד לנכס. זו אמירה על ההיקף שלך
          ולא על העסק.
        </p>
      ) : (
        <StockEntryForm
          properties={properties}
          mayImport={holdsGrant(actor, 'inventory.import')}
        />
      )}

      <nav aria-label="מסכים נוספים" className="flex flex-wrap gap-3">
        <Button href="/inventory/import" variant="secondary">
          ייבוא מקובץ עם תבנית
        </Button>
        <Button href="/inventory/items" variant="ghost">
          כל הפריטים
        </Button>
      </nav>
    </div>
  )
}
