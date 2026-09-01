import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { capabilitiesFor, type ExistingItem } from '@/lib/inventory'
import { SupabaseInventoryRepository } from '@/lib/persistence/inventory'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { ImportForm } from '../_components/import-form'
import { ModuleOff } from '../_components/module-state'
import { totalOwned } from '../_lib/module'

export const metadata: Metadata = { title: 'ייבוא מלאי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. A spreadsheet, into the cupboard.
 *
 * WHAT IS READ HERE AND WHY. The items already stored, so the plan can say
 * which rows are new, which change something, and which are byte-identical to
 * what is there. That last count is the whole idempotency story made visible:
 * a person who runs the same file twice sees "41 identical" rather than
 * discovering eighty-two towels.
 *
 * `inventory.import` AND NOT `inventory.edit`. 0012 keeps them apart, and this
 * is the reason: a bulk load can restate the entire cupboard in one act, and
 * that is a different amount of trust from renaming an item.
 *
 * THE TEMPLATE IS GENERATED IN THE BROWSER from the same tuple the parser
 * matches on. A file checked into `public/` would drift from the parser the
 * first time a column was added, and "I used your own template and it refused
 * my column" is the failure that ends an onboarding.
 */
export default async function InventoryImportPage() {
  const [actor, context] = await Promise.all([
    requireGrant('inventory.import'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const repository = new SupabaseInventoryRepository(await createClient())
  const { settings, provisioned } = await repository.loadSettings(
    actor.organizationId,
  )

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

  const items = await repository.loadForecastItems({
    organizationId: actor.organizationId,
  })

  // The comparison set. Quantities are the *total owned* rather than the clean
  // count, because a spreadsheet says "we have sixty towels" and does not know
  // that thirty of them are in a van.
  const existing: readonly ExistingItem[] = items.map((item) => ({
    id: item.itemId,
    name: item.label,
    sku: null,
    quantity: totalOwned(item),
    minQuantity: item.minQuantity,
    parLevel: item.parLevel,
    unitCostAgorot: null,
    location: item.location,
    category: null,
    unitOfMeasure: item.unitOfMeasure,
  }))

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          ייבוא מלאי
        </h1>
        <p className="max-w-prose text-muted-foreground">
          קובץ CSV או גיליון שיוצא ממערכת אחרת. הקובץ נקרא בדפדפן ומוצג לפני
          שנכתב משהו: מה ייווצר, מה ישתנה, מה כבר זהה, ואיזו שורה נדחתה ולמה.
          הרצה חוזרת של אותו קובץ אינה מכפילה דבר.
        </p>
      </header>

      {properties.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          אין נכס בטווח החברות שלך, ומלאי משויך תמיד לנכס.
        </p>
      ) : (
        <ImportForm properties={properties} existing={existing} />
      )}

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground">איך הקובץ נקרא</h2>
        <p>
          העמודה היחידה שחייבת להיות היא ״שם״. ״כמות״ ריקה נספרת כאפס. מספרים עם
          פסיק מפריד אלפים או עם סימן שקל מתקבלים. מק״ט כפול בתוך אותו קובץ נדחה
          פעם אחת, והשורה הראשונה נשמרת.
        </p>
        <p>
          פריט מזוהה לפי מק״ט אם יש, ולפי שם אם אין — כי לגיליון של בעל וילה אחת
          אין עמודת מק״ט ולא תהיה.
        </p>
      </section>

      <nav aria-label="מסכים נוספים" className="flex flex-wrap gap-3">
        <Button href="/inventory/entry" variant="secondary">
          הזנה ידנית
        </Button>
        <Button href="/inventory/items" variant="ghost">
          כל הפריטים
        </Button>
      </nav>
    </div>
  )
}
