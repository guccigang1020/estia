/**
 * The navigation menu, derived from what the signed-in person may actually do.
 *
 * Two things this file is, and one thing it is emphatically not.
 *
 * IT IS DATA. Every entry declares the capability it needs, and the menu that
 * reaches the screen is the result of asking the authorization engine about
 * each one. There is no `if (role === 'cleaner')` anywhere in the navigation,
 * which is what lets a customer compose a role next year and get a coherent
 * menu without anybody editing this file.
 *
 * IT IS DENY BY DEFAULT. `requires` is mandatory and its type has no empty
 * case: `{ kind: 'grant' }` carries a non-empty tuple, and the only way to say
 * "any active member" is to write `{ kind: 'membership' }` deliberately. An
 * item cannot be added without stating who it is for, so the shortcut that
 * would otherwise be taken at 2am does not exist.
 *
 * IT IS NOT SECURITY. Hiding an item is a convenience for the person reading
 * the screen and nothing more. The route itself must refuse independently —
 * see `src/app/(app)/_lib/guard.ts`, which no component in this directory
 * imports and which no menu decision can satisfy. If this file were deleted,
 * every route would still be exactly as protected as it is now.
 */

import { authorize, type Actor, type Decision } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'

import type { NavIconName } from './icons'

// ── Declaring an item ─────────────────────────────────────────────────────

/**
 * What an item needs before it is worth showing.
 *
 * `grant` is the normal case and holds *any of* the listed grants, not all of
 * them: the calendar is worth showing to someone who can see bookings and also
 * to an external seller who can only see free/busy, and those are different
 * grants over the same screen.
 *
 * `membership` is the deliberate exception, and there is one item using it.
 * It means "the route is gated on being an active member and nothing else", so
 * hiding it would hide a page the person can genuinely open — which is the
 * other way a permission-derived menu lies to people.
 */
export type MenuRequirement =
  | { kind: 'grant'; anyOf: readonly [Grant, ...Grant[]] }
  | { kind: 'membership' }

/**
 * Whether the route behind an item exists yet.
 *
 * A union rather than a boolean plus an optional href, so that a not-yet-built
 * item cannot carry a link and a built one cannot omit it. The product is
 * mostly unbuilt; this is the type that keeps the menu honest about it instead
 * of pointing at 404s.
 */
export type MenuDestination =
  { status: 'ready'; href: string } | { status: 'planned' }

export type MenuItemDefinition = {
  id: string
  /** Hebrew. The product is Hebrew-first. */
  label: string
  requires: MenuRequirement
  destination: MenuDestination
}

export type MenuSectionDefinition = {
  id: string
  label: string
  icon: NavIconName
  items: readonly MenuItemDefinition[]
}

// ── The structure ─────────────────────────────────────────────────────────

/**
 * Grants are chosen from the catalogue as it stands today. Where the
 * catalogue has no grant that matches a module exactly — maintenance is the
 * clearest case, being tasks of a particular kind — the nearest true grant is
 * used and noted, rather than inventing a permission string that the engine
 * would silently never match.
 */
export const MENU: readonly MenuSectionDefinition[] = [
  {
    id: 'main',
    label: 'ראשי',
    icon: 'home',
    items: [
      {
        id: 'dashboard',
        label: 'מסך הבית',
        // The one membership-gated item. A cleaner reaches this page, so a
        // menu that hid it from them would be wrong, not merely cautious.
        requires: { kind: 'membership' },
        destination: { status: 'ready', href: '/dashboard' },
      },
      {
        id: 'action-center',
        label: 'מרכז הפעולות',
        requires: {
          kind: 'grant',
          anyOf: [
            'task.view',
            'approval.decide',
            'approval.request',
            'message.view',
            'incident.view',
          ],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'activity',
        label: 'פעילות אחרונה',
        requires: { kind: 'grant', anyOf: ['audit.view'] },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'bookings',
    label: 'הזמנות',
    icon: 'calendar',
    items: [
      {
        id: 'calendar',
        label: 'יומן',
        // Two different people, one screen: the desk sees the booking, an
        // external seller sees only that the date is taken.
        requires: {
          kind: 'grant',
          anyOf: ['booking.view', 'availability.view'],
        },
        destination: { status: 'ready', href: '/calendar' },
      },
      {
        id: 'bookings',
        label: 'רשימת הזמנות',
        requires: { kind: 'grant', anyOf: ['booking.view'] },
        destination: { status: 'ready', href: '/bookings' },
      },
      {
        id: 'availability',
        label: 'זמינות וחסימות',
        requires: { kind: 'grant', anyOf: ['availability.view', 'hold.view'] },
        destination: { status: 'ready', href: '/calendar/check' },
      },
      {
        id: 'guests',
        label: 'אורחים',
        requires: { kind: 'grant', anyOf: ['guest.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'leads',
        label: 'לידים',
        requires: { kind: 'grant', anyOf: ['lead.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'inbox',
        label: 'תיבת הודעות',
        requires: { kind: 'grant', anyOf: ['message.view'] },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'distribution',
    label: 'הפצה ומכירות',
    icon: 'globe',
    items: [
      {
        id: 'direct-website',
        label: 'האתר הישיר',
        requires: { kind: 'grant', anyOf: ['site.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'agents',
        label: 'סוכנים',
        requires: { kind: 'grant', anyOf: ['agent.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'agencies',
        label: 'סוכנויות',
        requires: { kind: 'grant', anyOf: ['agency.manage'] },
        destination: { status: 'planned' },
      },
      {
        id: 'quotes',
        label: 'הצעות מחיר',
        requires: { kind: 'grant', anyOf: ['quote.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'promotions',
        label: 'מבצעים ותמחור',
        requires: {
          kind: 'grant',
          anyOf: ['pricing.manage', 'product.manage'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'channels',
        label: 'ערוצי הפצה',
        requires: { kind: 'grant', anyOf: ['channel.manage'] },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'operations',
    label: 'תפעול',
    icon: 'operations',
    items: [
      {
        id: 'housekeeping',
        label: 'ניקיון',
        requires: {
          kind: 'grant',
          anyOf: ['checklist.manage', 'task.complete', 'task.view'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'tasks',
        label: 'משימות',
        requires: { kind: 'grant', anyOf: ['task.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'maintenance',
        label: 'תחזוקה',
        // The catalogue has no maintenance-specific grant; maintenance work is
        // tasks and incidents. When the module lands and the grant is added,
        // this line changes and nothing else does.
        requires: { kind: 'grant', anyOf: ['task.view', 'incident.update'] },
        destination: { status: 'planned' },
      },
      {
        id: 'incidents',
        label: 'תקלות',
        // `incident.create` is included on purpose: a cleaner may report a
        // fault without being allowed to browse the organization's faults, and
        // the entry is how they reach the form.
        requires: {
          kind: 'grant',
          anyOf: ['incident.view', 'incident.create'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'inventory',
        label: 'מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'finance',
    label: 'כספים',
    icon: 'finance',
    items: [
      {
        id: 'payments',
        label: 'תשלומים',
        requires: { kind: 'grant', anyOf: ['payment.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'invoices',
        label: 'חשבוניות',
        requires: { kind: 'grant', anyOf: ['invoice.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'expenses',
        label: 'הוצאות',
        requires: { kind: 'grant', anyOf: ['expense.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'commissions',
        label: 'עמלות',
        requires: { kind: 'grant', anyOf: ['commission.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'owners',
        label: 'בעלי נכסים',
        requires: {
          kind: 'grant',
          anyOf: ['owner.view', 'owner_statement.view'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'reconciliation',
        label: 'התאמות',
        requires: { kind: 'grant', anyOf: ['finance.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'reports',
        label: 'דוחות',
        requires: {
          kind: 'grant',
          anyOf: ['report.financial.view', 'report.agent.view'],
        },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'ai',
    label: 'AI ואוטומציה',
    icon: 'spark',
    items: [
      {
        id: 'website-studio',
        label: 'סטודיו האתר',
        requires: {
          kind: 'grant',
          anyOf: ['site.edit_content', 'site.edit_design', 'site.publish'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'automations',
        label: 'אוטומציות',
        requires: { kind: 'grant', anyOf: ['automation.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'templates',
        label: 'תבניות',
        requires: { kind: 'grant', anyOf: ['template.manage'] },
        destination: { status: 'planned' },
      },
      {
        id: 'insights',
        label: 'תובנות',
        requires: {
          kind: 'grant',
          anyOf: ['automation.view', 'report.financial.view'],
        },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'management',
    label: 'ניהול',
    icon: 'building',
    items: [
      {
        id: 'properties',
        label: 'נכסים',
        requires: { kind: 'grant', anyOf: ['property.view'] },
        destination: { status: 'ready', href: '/properties' },
      },
      {
        id: 'units',
        label: 'יחידות',
        requires: { kind: 'grant', anyOf: ['unit.manage'] },
        destination: { status: 'planned' },
      },
      {
        id: 'team',
        label: 'צוות',
        requires: { kind: 'grant', anyOf: ['user.view'] },
        destination: { status: 'planned' },
      },
      {
        id: 'roles',
        label: 'תפקידים והרשאות',
        requires: {
          kind: 'grant',
          anyOf: ['role.assign', 'role.create', 'permission.edit'],
        },
        destination: { status: 'planned' },
      },
      {
        id: 'integrations',
        label: 'חיבורים',
        requires: { kind: 'grant', anyOf: ['integration.manage'] },
        destination: { status: 'planned' },
      },
      {
        id: 'audit',
        label: 'יומן ביקורת',
        // Distinct from `activity` above: that is a feed of what happened
        // recently, this is the searchable record with before/after values.
        requires: { kind: 'grant', anyOf: ['audit.view', 'agent.audit.view'] },
        destination: { status: 'planned' },
      },
    ],
  },

  {
    id: 'settings',
    label: 'הגדרות',
    icon: 'settings',
    items: [
      {
        id: 'organization',
        label: 'פרטי הארגון',
        requires: { kind: 'grant', anyOf: ['organization.settings.edit'] },
        destination: { status: 'ready', href: '/settings/organization' },
      },
      {
        id: 'billing',
        label: 'חבילה וחיוב',
        requires: { kind: 'grant', anyOf: ['organization.billing.manage'] },
        destination: { status: 'planned' },
      },
      {
        id: 'security',
        label: 'אבטחה',
        requires: {
          kind: 'grant',
          anyOf: ['organization.settings.edit', 'permission.edit'],
        },
        destination: { status: 'planned' },
      },
    ],
  },
]

// ── Resolving it for one person ───────────────────────────────────────────

/**
 * What the person sees for an item they are entitled to reach.
 *
 *   `available` — they hold the right and the route exists. A real link.
 *   `planned`   — they hold the right and the route does not exist yet. Shown
 *                 disabled and labelled, never linked. See the note on
 *                 `buildMenu` for why it is shown at all.
 *   `locked`    — they hold the right, and their organization has not bought
 *                 the feature. `authorize()` distinguishes this from a refusal
 *                 precisely so the interface can offer the upgrade instead of
 *                 pretending the capability does not exist.
 */
export type MenuItemState = 'available' | 'planned' | 'locked'

export type ResolvedMenuItem = {
  id: string
  label: string
  state: MenuItemState
  /** Non-null only for `available`. Nothing else is ever a link. */
  href: string | null
  /** The plan feature that would unlock it. Set only for `locked`. */
  entitlement: Entitlement | null
}

export type ResolvedMenuSection = {
  id: string
  label: string
  icon: NavIconName
  items: readonly ResolvedMenuItem[]
}

/**
 * Decide one item, or `null` to leave it out entirely.
 *
 * The order matters. An allowed grant wins outright. Failing that, a refusal
 * that was about the plan rather than the permission produces `locked` — the
 * person may do this, their organization simply has not paid for it. Anything
 * else is a real "no" and the item disappears.
 */
function resolveItem(
  actor: Actor,
  item: MenuItemDefinition,
): ResolvedMenuItem | null {
  const base = { id: item.id, label: item.label }

  const held = (): ResolvedMenuItem =>
    item.destination.status === 'ready'
      ? {
          ...base,
          state: 'available',
          href: item.destination.href,
          entitlement: null,
        }
      : { ...base, state: 'planned', href: null, entitlement: null }

  if (item.requires.kind === 'membership') {
    // Still checked rather than assumed. `buildMenu` is only ever called with
    // a resolved actor, and a resolved actor is always active — but "it cannot
    // happen" is not a reason for a menu to open itself.
    return actor.membershipStatus === 'active' ? held() : null
  }

  const decisions: Decision[] = item.requires.anyOf.map((grant) =>
    authorize(actor, grant),
  )

  if (decisions.some((decision) => decision.allowed)) return held()

  const planRefusal = decisions.find(
    (decision) =>
      !decision.allowed && decision.reason === 'plan_does_not_include',
  )

  if (planRefusal && !planRefusal.allowed) {
    return {
      ...base,
      state: 'locked',
      href: null,
      entitlement: planRefusal.entitlement ?? null,
    }
  }

  return null
}

/**
 * The menu for one actor.
 *
 * Sections with nothing visible in them are dropped, so a cleaner is not shown
 * an empty "כספים" heading — an empty section tells someone there is money
 * data they are being kept from, which is both true and unhelpful.
 *
 * On showing `planned` items at all: the alternative was to render only the
 * sections whose routes exist, which today is one item. That would hide the
 * shape of the product from the person using it and make the permission model
 * unobservable. A disabled, clearly-labelled entry is honest — it is not a
 * link, it navigates nowhere, and no route exists behind it to be reached by
 * guessing. Fabricated data would be dishonest; an accurate "not built yet" is
 * not.
 */
export function buildMenu(actor: Actor): ResolvedMenuSection[] {
  const sections: ResolvedMenuSection[] = []

  for (const section of MENU) {
    const items = section.items
      .map((item) => resolveItem(actor, item))
      .filter((item): item is ResolvedMenuItem => item !== null)

    if (items.length > 0) {
      sections.push({
        id: section.id,
        label: section.label,
        icon: section.icon,
        items,
      })
    }
  }

  return sections
}

// ── Quick create ──────────────────────────────────────────────────────────

/**
 * The "+" in the top bar, derived the same way the menu is.
 *
 * Same definitions, same resolver, same deny-by-default: somebody who cannot
 * create a booking is not offered one. Written as a separate list rather than
 * filtered out of `MENU` because creating is a different question from
 * viewing — a reception clerk sees expenses they may not create, and an
 * external seller creates quotes for inventory they may not otherwise open.
 */
export const QUICK_CREATE: readonly MenuItemDefinition[] = [
  {
    id: 'new-booking',
    label: 'הזמנה חדשה',
    requires: { kind: 'grant', anyOf: ['booking.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-guest',
    label: 'אורח חדש',
    requires: { kind: 'grant', anyOf: ['guest.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-quote',
    label: 'הצעת מחיר',
    requires: { kind: 'grant', anyOf: ['quote.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-task',
    label: 'משימה',
    requires: { kind: 'grant', anyOf: ['task.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-incident',
    label: 'דיווח על תקלה',
    requires: { kind: 'grant', anyOf: ['incident.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-expense',
    label: 'הוצאה',
    requires: { kind: 'grant', anyOf: ['expense.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'new-property',
    label: 'נכס',
    requires: { kind: 'grant', anyOf: ['property.create'] },
    destination: { status: 'planned' },
  },
  {
    id: 'invite-member',
    label: 'הזמנת חבר צוות',
    requires: { kind: 'grant', anyOf: ['user.invite', 'agent.invite'] },
    destination: { status: 'planned' },
  },
]

export function buildQuickCreate(actor: Actor): ResolvedMenuItem[] {
  return QUICK_CREATE.map((item) => resolveItem(actor, item)).filter(
    (item): item is ResolvedMenuItem => item !== null,
  )
}

/**
 * The first genuinely navigable item in each section.
 *
 * The mobile bar has room for a handful of destinations and must not offer a
 * tab that leads nowhere, so it is built from this rather than from the menu
 * as a whole.
 */
export function primaryDestinations(
  sections: readonly ResolvedMenuSection[],
): { id: string; label: string; icon: NavIconName; href: string }[] {
  const result: {
    id: string
    label: string
    icon: NavIconName
    href: string
  }[] = []

  for (const section of sections) {
    const item = section.items.find(
      (candidate) => candidate.state === 'available' && candidate.href !== null,
    )
    if (item?.href) {
      result.push({
        id: item.id,
        label: item.label,
        icon: section.icon,
        href: item.href,
      })
    }
  }

  return result
}
