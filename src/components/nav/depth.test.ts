import { describe, expect, it } from 'vitest'

import {
  applyDepth,
  CORE_ITEM_IDS,
  CORE_SECTION_IDS,
  isCore,
  suggestedDepth,
} from './depth'
import { MENU as MENU_DEFINITION } from './menu'
import type { ResolvedMenuItem, ResolvedMenuSection } from './menu'

const item = (id: string): ResolvedMenuItem => ({
  id,
  label: id,
  state: 'available',
  href: `/${id}`,
  entitlement: null,
})

const section = (
  id: string,
  itemIds: readonly string[],
): ResolvedMenuSection => ({
  id,
  label: id,
  icon: 'home',
  items: itemIds.map(item),
})

const MENU = [
  section('main', ['dashboard', 'action-center', 'activity']),
  section('bookings', ['calendar', 'bookings-list']),
  // Real ids, so the fixture cannot drift from the menu it stands for.
  section('finance', ['payments', 'owner-statements', 'commissions']),
  section('management', ['owners', 'agents', 'inventory-items']),
]

describe('applyDepth — full', () => {
  it('returns exactly what it was given', () => {
    // The depth control must never be a way to lose an item permanently, so
    // `full` filters nothing and reorders nothing.
    const result = applyDepth(MENU, 'full')

    expect(result.hiddenCount).toBe(0)
    expect(result.sections.map((s) => s.visible.length)).toEqual([3, 2, 3, 3])
  })
})

describe('applyDepth — simple', () => {
  it('keeps the daily surface', () => {
    const result = applyDepth(MENU, 'simple')
    const visible = result.sections.flatMap((s) => s.visible.map((i) => i.id))

    expect(visible).toContain('dashboard')
    expect(visible).toContain('calendar')
    expect(visible).toContain('payments')
  })

  it('holds back exactly what §89 names', () => {
    // "בעל נכס קטן לעולם לא רואה: דוחות בעלים · מחסנים · עמלות סוכנים"
    const result = applyDepth(MENU, 'simple')
    const hidden = result.sections.flatMap((s) => s.hidden.map((i) => i.id))

    expect(hidden).toContain('owner-statements')
    expect(hidden).toContain('commissions')
    expect(hidden).toContain('inventory-items')
    expect(hidden).toContain('owners')
  })

  it('counts what it held back, so a section can say so', () => {
    // Hidden and gone are different, and the count is what lets the interface
    // say which one this is.
    const result = applyDepth(MENU, 'simple')

    expect(result.hiddenCount).toBe(
      result.sections.reduce((n, s) => n + s.hidden.length, 0),
    )
    expect(result.hiddenCount).toBeGreaterThan(0)
  })

  it('never drops a section, even when all of it is hidden', () => {
    // A function that removed sections would make the count disagree with the
    // screen. The caller decides what to render; this only sorts.
    const result = applyDepth([section('management', ['owners'])], 'simple')

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]?.visible).toEqual([])
    expect(result.sections[0]?.hidden).toHaveLength(1)
  })

  it('loses nothing: visible plus hidden is always the original', () => {
    const result = applyDepth(MENU, 'simple')

    for (const [index, resolved] of result.sections.entries()) {
      const original = MENU[index]?.items.map((i) => i.id) ?? []
      const round = [
        ...resolved.visible.map((i) => i.id),
        ...resolved.hidden.map((i) => i.id),
      ]
      expect(round.sort()).toEqual([...original].sort())
    }
  })
})

describe('isCore', () => {
  it('takes a whole section when every item in it is daily', () => {
    expect(isCore('bookings', item('anything-at-all'))).toBe(true)
  })

  it('takes named items out of a mixed section', () => {
    // `finance` holds both "what came in" and owner statements.
    expect(isCore('finance', item('payments'))).toBe(true)
    expect(isCore('finance', item('owner-statements'))).toBe(false)
  })
})

describe('suggestedDepth', () => {
  it('starts one villa simple', () => {
    expect(
      suggestedDepth({ propertyCount: 1, hasOwners: false, hasAgents: false }),
    ).toBe('simple')
  })

  it('opens up at the second property', () => {
    // The second property is where the reasons for the advanced surface
    // actually begin — a cleaner shared between buildings, a comparison.
    expect(
      suggestedDepth({ propertyCount: 2, hasOwners: false, hasAgents: false }),
    ).toBe('full')
  })

  it('opens up for a business that has owners or agents at all', () => {
    expect(
      suggestedDepth({ propertyCount: 1, hasOwners: true, hasAgents: false }),
    ).toBe('full')
    expect(
      suggestedDepth({ propertyCount: 1, hasOwners: false, hasAgents: true }),
    ).toBe('full')
  })

  it('treats an empty business as simple rather than as unknown', () => {
    // A brand-new organization has no properties yet. Starting it on the full
    // surface would make its first morning a search.
    expect(
      suggestedDepth({ propertyCount: 0, hasOwners: false, hasAgents: false }),
    ).toBe('simple')
  })
})

describe('the core set names items that actually exist', () => {
  it('matches every core id to a real menu item', () => {
    // The bug this catches, and it caught it: `finance` and `preparation` were
    // in the core set and are not item ids — the real ones are `payments`,
    // `invoices` and `housekeeping`. A core id that matches nothing does not
    // fail loudly; it silently drops that screen out of the simple surface,
    // which is the one failure this whole module exists to prevent.
    const real = new Set(
      MENU_DEFINITION.flatMap((section) => section.items.map((i) => i.id)),
    )

    for (const id of CORE_ITEM_IDS) {
      expect(real.has(id), `core item "${id}" is not in the menu`).toBe(true)
    }
  })

  it('matches every core section to a real section', () => {
    const real = new Set(MENU_DEFINITION.map((section) => section.id))

    for (const id of CORE_SECTION_IDS) {
      expect(real.has(id), `core section "${id}" is not in the menu`).toBe(true)
    }
  })
})
