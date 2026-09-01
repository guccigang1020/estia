/**
 * The owner's view of what they sell.
 *
 * One component behind `/store/products` and `/store/services`, because the
 * two differ by which `STORE_ITEM_TYPES` they show and by nothing else. Two
 * components would be two places to fix the day a column is added.
 *
 * ── What is shown depends on the MODE, not on the reader's taste ─────────
 *
 * `showsVocabulary` decides whether a cost, a supplier or a recipe column
 * exists at all. Not disabled — ABSENT. A disabled field still teaches a
 * vocabulary, and §5 is that a business on `simple` never learns it.
 */

import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import type { StoreMode } from '@/lib/contracts/states'
import {
  STORE_FULFILMENT_KIND_LABEL,
  STORE_ITEM_TYPE_LABEL,
  STORE_VISIBILITY_RULE_LABEL,
  showsVocabulary,
  type CatalogueItem,
  type StoreCategory,
} from '@/lib/store'

import { ItemStatusBadge, PriceCaption } from './store-chrome'

export function CatalogueList({
  items,
  categories,
  mode,
  mayPrice,
  emptyTitle,
  emptyBody,
  action,
}: {
  items: readonly CatalogueItem[]
  categories: readonly StoreCategory[]
  mode: StoreMode
  /** `product.price_manage`. A person without it reads no price at all. */
  mayPrice: boolean
  emptyTitle: string
  emptyBody: string
  action?: React.ReactNode
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        illustration="invoice"
        as="h2"
        title={emptyTitle}
        body={emptyBody}
        action={action}
      />
    )
  }

  const categoryName = (id: string | null): string | null =>
    id === null
      ? null
      : (categories.find((category) => category.id === id)?.name ?? null)

  const showsCost = showsVocabulary(mode, 'cost')
  const showsRecipe = showsVocabulary(mode, 'recipe')

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {items.length === 1 ? 'פריט אחד' : `${items.length} פריטים`}
        </CardTitle>
      </CardHeader>

      <ul className="mt-4 flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-base font-bold text-foreground">
                {item.name}
              </span>
              <ItemStatusBadge status={item.status} />
              <Badge>{STORE_ITEM_TYPE_LABEL[item.itemType]}</Badge>
              {item.isFeatured && <Badge tone="accent">מודגש</Badge>}
              {categoryName(item.categoryId) && (
                <span className="text-xs text-muted-foreground">
                  {categoryName(item.categoryId)}
                </span>
              )}
            </div>

            {item.shortDescription && (
              <p className="text-sm text-muted-foreground">
                {item.shortDescription}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
              {/* A price is `product.price_manage`. Somebody without it does
                  not see a redacted number — they see the model, and no
                  figure at all, which is what `Money` means by `undefined`. */}
              {mayPrice ? (
                <PriceCaption
                  agorot={item.basePriceAgorot}
                  model={item.pricingModel}
                  className="text-sm font-semibold text-foreground"
                />
              ) : (
                <span>המחיר אינו גלוי לך</span>
              )}

              {item.leadTimeHours > 0 && (
                <span>
                  {item.leadTimeHours >= 24
                    ? `${Math.round(item.leadTimeHours / 24)} ימי התראה`
                    : `${item.leadTimeHours} שעות התראה`}
                </span>
              )}

              {item.capacityPerDay !== null && (
                <span>עד {item.capacityPerDay} ביום</span>
              )}

              {item.maxPerBooking !== null && (
                <span>עד {item.maxPerBooking} להזמנה</span>
              )}

              {item.requiresCapability && (
                <span>דורש: {item.requiresCapability}</span>
              )}

              {(item.minGuests !== null || item.maxGuests !== null) && (
                <span>
                  {item.minGuests ?? 1}–{item.maxGuests ?? '∞'} אורחים
                </span>
              )}

              {item.visibilityRule !== 'always' && (
                <span>
                  נראה: {STORE_VISIBILITY_RULE_LABEL[item.visibilityRule]}
                  {item.visibilityRule === 'days_before_arrival' &&
                    ` (${item.visibilityDaysBefore})`}
                </span>
              )}

              {/* `advanced` only. On `simple` these two words do not appear
                  anywhere on this screen. */}
              {showsRecipe && item.fulfilmentKind !== 'none' && (
                <span>{STORE_FULFILMENT_KIND_LABEL[item.fulfilmentKind]}</span>
              )}
              {showsCost && item.costAgorot !== null && <span>עלות רשומה</span>}
            </div>

            {item.options.length > 0 && (
              <p className="text-xs text-muted-foreground">
                אפשרויות:{' '}
                {item.options
                  .map(
                    (option) =>
                      `${option.name} (${option.values.length} ערכים)`,
                  )
                  .join(' · ')}
              </p>
            )}

            {item.addons.length > 0 && (
              <p className="text-xs text-muted-foreground">
                תוספות: {item.addons.map((addon) => addon.name).join(' · ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
