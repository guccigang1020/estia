/**
 * How much of the product to show somebody who has not asked for all of it.
 *
 * ══ SPEC 6.0 §89, WHICH IS MARKED MANDATORY ═════════════════════════════════
 *
 * "בעל נכס קטן **לעולם לא רואה**: דוחות בעלים · מחסנים · עמלות סוכנים ·
 * פיננסים מתקדמים — אלא אם הופעלו." And §2: ESTIA must not feel complicated
 * because it is powerful. A first-time villa owner has to understand five
 * things on sight — יומן · הזמנות · אורחים · היום · כסף.
 *
 * The menu is already derived from grants and entitlements, which answers a
 * different question: *may* this person open it. A sole owner holds every
 * grant in their own business, so permission narrows their menu by nothing at
 * all, and they are handed ninety-six items on their first morning.
 *
 * ══ WHY THIS IS A TIER AND NOT A ROLE ═══════════════════════════════════════
 *
 * A role says who somebody is. This says how much of the product they have
 * asked for, which is a different axis and moves independently — the same
 * owner wants the simple surface in March and the whole thing in August when
 * they take on a second property.
 *
 * ══ NOTHING IS REMOVED, AND THAT IS THE WHOLE CONSTRAINT ════════════════════
 *
 * An advanced item is one press away, never gone: the section that holds it
 * says how many it is hiding, and the control that reveals them is on the same
 * screen. Hiding a capability a customer is paying for, with no way to find it,
 * would be worse than the density this exists to fix — and it would violate
 * the non-destruction rule at the top of the specification.
 *
 * So: `core` is the daily surface, `advanced` is everything else, and the
 * difference is *presentation only*. Permission, entitlement and the route
 * guard are untouched by anything in this file.
 */

import type { ResolvedMenuItem, ResolvedMenuSection } from './menu'

export type MenuDepth = 'simple' | 'full'

/**
 * The items a villa owner uses on a Tuesday.
 *
 * Chosen by one test: would somebody managing one property open this in an
 * ordinary week? Everything else is real, supported and one press away.
 *
 * Section ids are included whole where every item in them is daily — and
 * item ids override the section for the mixed ones, because `finance` holds
 * both "what am I owed" (daily) and owner statements (not).
 */
/** Exported so a test can prove every id here is a real menu section. */
export const CORE_SECTION_IDS: ReadonlySet<string> = new Set([
  'main',
  'bookings',
])

/** Exported so a test can prove every id here is a real menu item. */
export const CORE_ITEM_IDS: ReadonlySet<string> = new Set([
  // Money, at the level a small business asks about it: what came in and what
  // was billed. Revenue reports and reconciliation are the same subject one
  // question deeper, and they wait.
  'payments',
  'invoices',
  'expenses',
  // The two operational screens a one-property owner genuinely opens, plus
  // faults — a broken boiler is a Tuesday, not an advanced feature.
  'housekeeping',
  'tasks',
  'maintenance',
  // Guests are one of §2's five words.
  'guests',
  // And the properties themselves, or there is nothing to manage.
  'properties',
  'units',
])

/** Is this item part of the daily surface? */
export function isCore(sectionId: string, item: ResolvedMenuItem): boolean {
  return CORE_SECTION_IDS.has(sectionId) || CORE_ITEM_IDS.has(item.id)
}

export interface DepthSection extends ResolvedMenuSection {
  /** What to render now. */
  readonly visible: readonly ResolvedMenuItem[]
  /** Held back at this depth. Counted so the section can say so. */
  readonly hidden: readonly ResolvedMenuItem[]
}

export interface DepthMenu {
  readonly sections: readonly DepthSection[]
  /** Everything held back, across every section. */
  readonly hiddenCount: number
}

/**
 * Split a resolved menu by depth.
 *
 * `full` returns exactly what it was given — no filtering, no reordering — so
 * the depth control cannot become a way to lose an item permanently.
 *
 * A section whose every item is hidden is kept in the list with an empty
 * `visible`, rather than dropped: the caller decides whether to render it, and
 * a function that silently removed sections would make the count above
 * disagree with what is on screen.
 */
export function applyDepth(
  sections: readonly ResolvedMenuSection[],
  depth: MenuDepth,
): DepthMenu {
  if (depth === 'full') {
    return {
      sections: sections.map((section) => ({
        ...section,
        visible: section.items,
        hidden: [],
      })),
      hiddenCount: 0,
    }
  }

  let hiddenCount = 0
  const result = sections.map((section) => {
    const visible: ResolvedMenuItem[] = []
    const hidden: ResolvedMenuItem[] = []

    for (const item of section.items) {
      if (isCore(section.id, item)) visible.push(item)
      else hidden.push(item)
    }

    hiddenCount += hidden.length
    return { ...section, visible, hidden }
  })

  return { sections: result, hiddenCount }
}

/**
 * What depth to start a business at, from its own shape rather than a
 * preference nobody set.
 *
 * §87 asks the product to configure itself from what the customer says they
 * manage. This is the same idea from the other end: a business with one
 * property, no owners and no agents is a business that has not asked for owner
 * statements, and starting it on the full surface makes the first morning a
 * search rather than a start.
 *
 * Two properties is the threshold and not five, because the second property is
 * where the reasons for the advanced surface actually begin — a cleaner shared
 * between buildings, a report that compares them.
 */
export function suggestedDepth(shape: {
  propertyCount: number
  hasOwners: boolean
  hasAgents: boolean
}): MenuDepth {
  if (shape.propertyCount > 1) return 'full'
  if (shape.hasOwners || shape.hasAgents) return 'full'
  return 'simple'
}
