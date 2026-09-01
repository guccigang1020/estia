/**
 * The screens' building blocks, rendered to real markup.
 *
 * ── Why this exists, and what it is standing in for ───────────────────────
 *
 * The intended verification for this module is loading every screen over HTTP
 * in the demo and reading the cards, the rows and the numbers. That is blocked
 * on two files this worker does not own — `src/lib/demo/dataset.ts`, which does
 * not yet declare the five laundry tables, and `src/lib/plans/catalog.ts`,
 * where no package sells the `laundry` entitlement — so every laundry route
 * currently resolves to a plan lock or to a 404 for a mode that reads as `off`.
 * Both are reported rather than worked around.
 *
 * What is NOT blocked is whether the components turn real data into real
 * markup, and that is a different question from whether a route can be
 * reached. So this renders them with `react-dom/server` and asserts on the
 * output. No jsdom, no DOM environment, no change to `vitest.config.mts`: the
 * suite is deliberately node-only and this respects that, which is why the
 * markup is built with `createElement` rather than JSX in a `.ts` file.
 *
 * It is weaker than the HTTP check in one specific way and it is worth naming:
 * it does not exercise the route guard, the shell, or row level security. It
 * proves the numbers reach the page, not that the page is reachable.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Explanation } from '@/components/laundry/explanation'
import { LaundryOrderCard } from '@/components/laundry/order-card'
import { Quantity } from '@/components/laundry/quantity'
import { LaundrySectionNav } from '@/components/laundry/section-nav'

import { consolidate } from './consolidation'
import { buildOrder } from './orders'
import { applyAdjustment, calculatedOnly } from './override'
import { buildLaundryRequirements } from './requirements'
import {
  CARMEL,
  CARMEL_REQUIREMENTS,
  GALILEE,
  GALILEE_REQUIREMENTS,
  ORGANIZATION,
  PROFILES,
  REQUIRED_BY,
  SETTINGS,
} from './testing/example-configuration'

const PROPERTY_NAMES = new Map([
  [GALILEE, 'אחוזת רימונים'],
  [CARMEL, 'בית כחול ים'],
])

/** A real consolidated order, through the real engine. Nothing hand-built. */
function consolidatedOrder() {
  const requirements = [
    ...buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: 'booking-1',
    }).requirements,
    ...buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: CARMEL_REQUIREMENTS,
      propertyId: CARMEL,
      requiredBy: REQUIRED_BY,
      bookingId: 'booking-2',
    }).requirements,
  ]

  const run = consolidate(requirements)[0]
  if (!run) throw new Error('no run')

  return buildOrder({
    run,
    settings: SETTINGS,
    organizationId: ORGANIZATION,
    orderId: 'order-1',
    lineIds: [],
  })
}

describe('an order card', () => {
  const order = consolidatedOrder()

  const markup = (providerName: string | null) =>
    renderToStaticMarkup(
      createElement(LaundryOrderCard, {
        order,
        statusLabel: 'טיוטה',
        providerName,
        properties: PROPERTY_NAMES,
        overdue: false,
        requiredByLabel: '4 בספט׳ 16:00',
        relativeLabel: 'מחר',
      }),
    )

  it('renders the reference and the status, not an empty shell', () => {
    const html = markup(null)

    expect(html).toContain(order.reference)
    expect(html).toContain('טיוטה')
    expect(html).toContain('מחר')
  })

  it('SHOWS THE PER-PROPERTY BREAKDOWN, both houses by name', () => {
    const html = markup(null)

    // The specification's rule, checked where a reader would actually see it.
    expect(html).toContain('אחוזת רימונים')
    expect(html).toContain('בית כחול ים')
    expect(html).toContain('איסוף מאוחד')
  })

  it('renders each property`s own quantity, not one total', () => {
    const html = markup(null)

    const galileeUnits = order.lines
      .filter((line) => line.propertyId === GALILEE)
      .reduce((sum, line) => sum + line.quantity.final, 0)
    const carmelUnits = order.lines
      .filter((line) => line.propertyId === CARMEL)
      .reduce((sum, line) => sum + line.quantity.final, 0)

    // Two different figures, both on the card. If the component summed them
    // the second would be missing.
    expect(galileeUnits).not.toBe(carmelUnits)
    expect(html).toContain(`>${galileeUnits}<`)
    expect(html).toContain(`>${carmelUnits}<`)
  })

  it('omits the provider entirely for a reader who may not see one', () => {
    const withProvider = markup('מכבסת הצפון')
    const without = markup(null)

    expect(withProvider).toContain('מכבסת הצפון')
    // Not a placeholder, not "unknown provider" — the row is not rendered.
    expect(without).not.toContain('מכבסת הצפון')
    expect(without).not.toContain('לא ידוע')
  })
})

describe('a quantity a person changed', () => {
  it('shows the engine`s figure, the change and the reason together', () => {
    const adjusted = applyAdjustment(calculatedOnly(28), {
      adjustment: 4,
      reason: 'אירוע גדול בסוף השבוע',
      adjustedByUserId: 'user-1',
      at: REQUIRED_BY,
    })

    const html = renderToStaticMarkup(
      createElement(Quantity, { quantity: adjusted, unit: 'piece' }),
    )

    // All three numbers, on screen at once. A reader who has to click to see
    // the calculated figure is a reader who will not.
    expect(html).toContain('32')
    expect(html).toContain('28')
    expect(html).toContain('+4')
    expect(html).toContain('אירוע גדול בסוף השבוע')
    expect(html).toContain('שונה ידנית')
  })

  it('shows one number and no clutter when nobody changed it', () => {
    const html = renderToStaticMarkup(
      createElement(Quantity, { quantity: calculatedOnly(28), unit: 'set' }),
    )

    expect(html).toContain('28')
    expect(html).not.toContain('שונה ידנית')
    expect(html).not.toContain('חישוב המערכת')
  })
})

describe('the arithmetic under a number', () => {
  it('renders every step of the chain the engine produced', () => {
    const order = consolidatedOrder()
    const line = order.lines.find((entry) => entry.itemId === 'linen_set')
    if (!line) throw new Error('no linen line')

    const html = renderToStaticMarkup(
      createElement(Explanation, {
        steps: line.explanation,
        expected: line.quantity.calculated,
      }),
    )

    for (const step of line.explanation) {
      expect(html).toContain(String(step.value))
    }

    expect(html).toContain('כללי ההכנה')
    expect(html).toContain('מרווח הכביסה')
    expect(html).toContain('עיגול לחבילות')
    // The chain agrees with the figure, so no discrepancy warning.
    expect(html).not.toContain('שים לב')
  })

  it('reports a chain that disagrees with the figure beside it', () => {
    const html = renderToStaticMarkup(
      createElement(Explanation, {
        steps: [{ kind: 'preparation', text: 'עשרים וחמש', value: 25 }],
        expected: 30,
      }),
    )

    // Worse than no chain, so it is reported rather than quietly rendered.
    expect(html).toContain('שים לב')
  })

  it('says so when a number arrived with no derivation at all', () => {
    const html = renderToStaticMarkup(createElement(Explanation, { steps: [] }))

    expect(html).toContain('לא נשמר הסבר')
  })
})

describe('the section navigation', () => {
  it('offers a `simple` business no orders and no providers', () => {
    const html = renderToStaticMarkup(
      createElement(LaundrySectionNav, {
        mode: 'simple',
        current: 'dashboard',
      }),
    )

    expect(html).toContain('/laundry/requirements')
    expect(html).toContain('/laundry/forecast')
    expect(html).not.toContain('/laundry/orders')
    expect(html).not.toContain('/laundry/providers')
    expect(html).not.toContain('/laundry/tasks')
  })

  it('offers a `hybrid` business everything', () => {
    const html = renderToStaticMarkup(
      createElement(LaundrySectionNav, { mode: 'hybrid', current: 'orders' }),
    )

    expect(html).toContain('/laundry/orders')
    expect(html).toContain('/laundry/providers')
    expect(html).toContain('/laundry/tasks')
    expect(html).toContain('aria-current="page"')
  })

  it('renders nothing at all when the module is off', () => {
    const html = renderToStaticMarkup(
      createElement(LaundrySectionNav, { mode: 'off', current: 'dashboard' }),
    )

    // Not an empty nav element — no nav. The section does not pretend to exist.
    expect(html).toBe('')
  })
})
