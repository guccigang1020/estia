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
// From the LEAF module, not from the `@/lib/laundry` barrel.
//
// The barrel re-exports `operations.ts`, which imports `@/lib/persistence`,
// which imports the `postgres` driver, which imports `fs`. A Server Component
// swallows that happily. The moment anybody adds `"use client"` to this file —
// and a nav with an active-state hook is exactly the file somebody eventually
// does that to — the bundler follows the same chain into the browser graph and
// every page in the application 500s with `Can't resolve 'fs'`.
//
// That is not hypothetical. It happened to another module while this one was
// being verified and took the whole dev server down for every worker.
// `mode.ts` imports only types and the frozen contracts, so this import cannot
// reach a driver however this component is later rendered.
// `client-safety.test.ts` enforces it for the whole directory.
import {
  sectionsFor,
  vocabularyFor,
  type LaundrySection,
} from '@/lib/laundry/mode'
import type { LaundryMode } from '@/lib/laundry/types'

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
