/**
 * The links to the parts of the section that exist under this mode.
 *
 * Derived from `SECTIONS_BY_MODE`, never written out. A `simple` operation
 * gets three links and an `external` one gets five, and neither is a subset
 * chosen by a designer — it is the same record the route guard in `view.ts`
 * uses to decide whether the URL exists at all. A nav that listed a route the
 * guard 404s is the classic version of this bug.
 *
 * The labels come from the mode's own vocabulary where the word differs.
 * A `simple` business is offered "מה צפוי", an `external` one "צפי כביסה", and
 * neither is offered a word for machinery it does not have.
 */

import { cn } from '@/components/ui/cn'
import {
  sectionsFor,
  vocabularyFor,
  type LaundryMode,
  type LaundrySection,
} from '@/lib/laundry'

const HREF: Readonly<Record<LaundrySection, string>> = {
  dashboard: '/laundry',
  requirements: '/laundry/requirements',
  orders: '/laundry/orders',
  tasks: '/laundry/tasks',
  providers: '/laundry/providers',
  forecast: '/laundry/forecast',
}

export type SectionNavProps = {
  mode: LaundryMode
  current: LaundrySection
}

export function LaundrySectionNav({ mode, current }: SectionNavProps) {
  const sections = sectionsFor(mode)
  const words = vocabularyFor(mode)

  const label: Readonly<Record<LaundrySection, string>> = {
    dashboard: 'סקירה',
    requirements: 'מה צריך להיות נקי',
    orders: words.batches,
    tasks: 'עבודה בבית',
    providers: 'ספקים',
    forecast: words.forecast,
  }

  if (sections.length === 0) return null

  return (
    <nav aria-label="ניווט בתוך הכביסה">
      <ul className="flex flex-wrap gap-2">
        {sections.map((section) => (
          <li key={section}>
            <a
              href={HREF[section]}
              aria-current={section === current ? 'page' : undefined}
              className={cn(
                'inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors',
                section === current
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border bg-surface text-muted-foreground hover:text-foreground',
              )}
            >
              {label[section]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
