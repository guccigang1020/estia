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
  | {
      status: 'ready'
      href: string
      /**
       * True when the route renders the upgrade offer for a customer whose
       * plan does not include it, rather than redirecting them away.
       *
       * This is a claim about a specific page, so it is declared per item and
       * never inferred. The blanket rule — "link every locked item whose
       * route exists" — was written first and was wrong within a minute:
       * `/tasks` is gated by the `operations` entitlement and guarded by plain
       * `requireGrant`, which redirects a plan refusal to the dashboard. A
       * padlock that does nothing is a poor experience; a padlock that bounces
       * you to a page saying you lack a permission you actually hold is worse.
       *
       * Seven routes earn the flag today, each holding a `PlanLock` on exactly
       * the `plan_does_not_include` branch. A route that gains one gains the
       * flag here in the same change.
       */
      offersUpgrade?: true
    }
  | { status: 'planned' }

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
        destination: { status: 'ready', href: '/action-center' },
      },
      {
        id: 'activity',
        label: 'פעילות אחרונה',
        requires: { kind: 'grant', anyOf: ['audit.view'] },
        destination: { status: 'ready', href: '/activity' },
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
        destination: { status: 'ready', href: '/guests' },
      },
      // The register, which is a different question from the guest list: an
      // accountant needs the history without today's cards, and a receptionist
      // needs today's cards without five years of history. Hence its own
      // grant and its own entry.
      {
        id: 'guest-book',
        label: 'ספר אורחים',
        requires: { kind: 'grant', anyOf: ['guest_book.view'] },
        destination: { status: 'ready', href: '/guest-book' },
      },
      {
        id: 'leads',
        label: 'לידים',
        requires: { kind: 'grant', anyOf: ['lead.view'] },
        destination: { status: 'ready', href: '/leads' },
      },
      {
        id: 'inbox',
        label: 'תיבת הודעות',
        requires: { kind: 'grant', anyOf: ['message.view'] },
        destination: { status: 'ready', href: '/inbox' },
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
        destination: {
          status: 'ready',
          href: '/website/requests',
          offersUpgrade: true,
        },
      },
      {
        id: 'agents',
        label: 'סוכנים',
        requires: { kind: 'grant', anyOf: ['agent.view'] },
        destination: {
          status: 'ready',
          href: '/agents',
          offersUpgrade: true,
        },
      },
      {
        id: 'agencies',
        label: 'סוכנויות',
        requires: { kind: 'grant', anyOf: ['agency.manage'] },
        destination: {
          status: 'ready',
          href: '/agencies',
          offersUpgrade: true,
        },
      },
      {
        id: 'quotes',
        label: 'הצעות מחיר',
        requires: { kind: 'grant', anyOf: ['quote.view'] },
        destination: {
          status: 'ready',
          href: '/quotes',
          offersUpgrade: true,
        },
      },
      {
        id: 'promotions',
        label: 'מבצעים ותמחור',
        requires: {
          kind: 'grant',
          anyOf: ['pricing.manage', 'product.manage'],
        },
        destination: {
          status: 'ready',
          href: '/promotions',
          offersUpgrade: true,
        },
      },
      {
        id: 'channels',
        label: 'ערוצי הפצה',
        requires: { kind: 'grant', anyOf: ['channel.manage'] },
        destination: {
          status: 'ready',
          href: '/channels',
          offersUpgrade: true,
        },
      },
    ],
  },

  // ── The store ───────────────────────────────────────────────────────────
  // Ten screens that were reachable only by typing the URL. The module is
  // complete — products, services, packages, orders, promotions, the guest
  // store in the booking portal, price history, the lot — and it had no menu
  // entry, so a customer who had bought `commerce` could not find the thing
  // they bought. Found by comparing every page.tsx against every href here.
  {
    id: 'store',
    label: 'חנות ושירותים',
    icon: 'store',
    items: [
      {
        id: 'store-products',
        label: 'מוצרים',
        requires: { kind: 'grant', anyOf: ['product.view'] },
        destination: { status: 'ready', href: '/store', offersUpgrade: true },
      },
      {
        id: 'store-services',
        label: 'שירותים',
        requires: { kind: 'grant', anyOf: ['product.view'] },
        destination: {
          status: 'ready',
          href: '/store/services',
          offersUpgrade: true,
        },
      },
      {
        id: 'store-packages',
        label: 'חבילות',
        requires: { kind: 'grant', anyOf: ['product.view'] },
        destination: {
          status: 'ready',
          href: '/store/packages',
          offersUpgrade: true,
        },
      },
      {
        id: 'store-orders',
        label: 'הזמנות מהחנות',
        requires: { kind: 'grant', anyOf: ['order.view'] },
        destination: {
          status: 'ready',
          href: '/store/orders',
          offersUpgrade: true,
        },
      },
      {
        id: 'store-promotions',
        label: 'מבצעים בחנות',
        requires: { kind: 'grant', anyOf: ['product.manage'] },
        destination: {
          status: 'ready',
          href: '/store/promotions',
          offersUpgrade: true,
        },
      },
      {
        id: 'store-availability',
        label: 'זמינות שירותים',
        requires: { kind: 'grant', anyOf: ['product.manage'] },
        destination: {
          status: 'ready',
          href: '/store/availability',
          offersUpgrade: true,
        },
      },
      // What the guest actually sees. Its own entry because "what does my
      // store look like to a guest" is a question people ask before they
      // publish, and hunting for it inside settings is how they stop asking.
      {
        id: 'store-preview',
        label: 'תצוגת האורח',
        requires: { kind: 'grant', anyOf: ['product.view'] },
        destination: {
          status: 'ready',
          href: '/store/preview',
          offersUpgrade: true,
        },
      },
      {
        id: 'store-settings',
        label: 'הגדרות חנות',
        requires: { kind: 'grant', anyOf: ['product.manage'] },
        destination: {
          status: 'ready',
          href: '/store/settings',
          offersUpgrade: true,
        },
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
        destination: { status: 'ready', href: '/preparation' },
      },
      {
        id: 'laundry',
        label: 'מכבסה',
        requires: { kind: 'grant', anyOf: ['laundry.view'] },
        destination: {
          status: 'ready',
          href: '/laundry',
          offersUpgrade: true,
        },
      },
      {
        id: 'laundry-requirements',
        label: 'דרישות כביסה',
        requires: { kind: 'grant', anyOf: ['laundry.view'] },
        destination: { status: 'ready', href: '/laundry/requirements' },
      },
      {
        id: 'laundry-orders',
        label: 'הזמנות כביסה',
        requires: { kind: 'grant', anyOf: ['laundry.view'] },
        destination: { status: 'ready', href: '/laundry/orders' },
      },
      {
        id: 'laundry-tasks',
        label: 'כביסה פנימית',
        requires: { kind: 'grant', anyOf: ['laundry.view'] },
        destination: { status: 'ready', href: '/laundry/tasks' },
      },
      {
        id: 'laundry-providers',
        label: 'ספקי כביסה',
        requires: { kind: 'grant', anyOf: ['laundry.provider_manage'] },
        destination: { status: 'ready', href: '/laundry/providers' },
      },
      {
        id: 'laundry-forecast',
        label: 'תחזית כביסה',
        requires: { kind: 'grant', anyOf: ['laundry.view'] },
        destination: { status: 'ready', href: '/laundry/forecast' },
      },
      {
        // `inventory.view` and not `inventory.adjust`, matching the route:
        // reading a past stocktake is a reporting act, and the screen hides
        // every button a reader cannot press rather than showing a door that
        // then refuses.
        id: 'inventory-counts',
        label: 'ספירות מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'ready', href: '/inventory/counts' },
      },
      {
        id: 'inventory-forecast',
        label: 'תחזית מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'ready', href: '/inventory/forecast' },
      },
      {
        id: 'inventory-shortages',
        label: 'מחסורים',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'ready', href: '/inventory/shortages' },
      },
      {
        id: 'inventory-items',
        label: 'פריטי מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'ready', href: '/inventory/items' },
      },
      {
        id: 'inventory-settings',
        // Deliberately listed even though every other stock screen refuses
        // when the module is off, because this is the screen that turns it on.
        // A door that is only visible from inside the room is not a door.
        label: 'הגדרות מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.edit'] },
        destination: { status: 'ready', href: '/inventory/settings' },
      },
      {
        id: 'preparation-policy',
        label: 'מדיניות הכנה',
        // `checklist.manage` alone, and deliberately narrower than the board
        // above it. The route gates on that one grant, so listing `task.view`
        // here would put an entry in a cleaner's sidebar that redirects her
        // the moment she presses it.
        requires: { kind: 'grant', anyOf: ['checklist.manage'] },
        destination: { status: 'ready', href: '/preparation/policy' },
      },
      {
        id: 'operations-report',
        label: 'דוח תפעולי',
        // Deliberately a different grant from the financial report: this screen
        // refuses to carry a currency figure at all, so it reaches people the
        // revenue report does not.
        requires: { kind: 'grant', anyOf: ['availability.view'] },
        destination: { status: 'ready', href: '/reports/operations' },
      },
      {
        id: 'tasks',
        label: 'משימות',
        requires: { kind: 'grant', anyOf: ['task.view'] },
        destination: { status: 'ready', href: '/tasks' },
      },
      {
        id: 'maintenance',
        label: 'תחזוקה',
        // The catalogue has no maintenance-specific grant; maintenance work is
        // tasks and incidents. When the module lands and the grant is added,
        // this line changes and nothing else does.
        requires: { kind: 'grant', anyOf: ['task.view', 'incident.update'] },
        destination: { status: 'ready', href: '/maintenance' },
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
        destination: { status: 'ready', href: '/incidents' },
      },
      {
        id: 'incident-cases',
        label: 'תיקי נזק',
        // `incident.view` alone, deliberately narrower than the entry above.
        // A cleaner who may report a fault (`incident.create`) has no
        // business reading what the business decided a guest owes.
        requires: { kind: 'grant', anyOf: ['incident.view'] },
        destination: { status: 'ready', href: '/incidents/cases' },
      },
      {
        id: 'inventory',
        label: 'מלאי',
        requires: { kind: 'grant', anyOf: ['inventory.view'] },
        destination: { status: 'ready', href: '/inventory' },
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
        destination: { status: 'ready', href: '/finance/payments' },
      },
      {
        id: 'invoices',
        label: 'חשבוניות',
        requires: { kind: 'grant', anyOf: ['invoice.view'] },
        destination: { status: 'ready', href: '/finance/invoices' },
      },
      // Documents an external accounting vendor issued, and the queue of the
      // ones that did not go out. Separate from ESTIA's own invoices above,
      // because payment truth and fiscal truth are separate and the whole
      // module exists to keep them that way.
      {
        id: 'fiscal',
        label: 'מסמכים חשבונאיים',
        requires: { kind: 'grant', anyOf: ['invoice.view'] },
        destination: { status: 'ready', href: '/settings/fiscal' },
      },
      {
        id: 'expenses',
        label: 'הוצאות',
        requires: { kind: 'grant', anyOf: ['expense.view'] },
        destination: { status: 'ready', href: '/finance/expenses' },
      },
      {
        id: 'commissions',
        label: 'עמלות',
        requires: { kind: 'grant', anyOf: ['commission.view'] },
        destination: { status: 'ready', href: '/finance/commissions' },
      },
      {
        id: 'owners',
        label: 'בעלי נכסים',
        requires: {
          kind: 'grant',
          anyOf: ['owner.view', 'owner_statement.view'],
        },
        // Repointed from /finance/owners, which reads an owner as a
        // MEMBERSHIP holding the property_owner role. The new register reads
        // an owner as an outside party with a dated share of a property, who
        // may never sign in at all — and only that one can carry a statement.
        // Two owner screens backed by two different ideas of what an owner is
        // would disagree in the first week.
        destination: {
          status: 'ready',
          href: '/owners',
          offersUpgrade: true,
        },
      },
      {
        id: 'reconciliation',
        label: 'התאמות',
        requires: { kind: 'grant', anyOf: ['finance.view'] },
        destination: { status: 'ready', href: '/finance/reconciliation' },
      },
      {
        id: 'reports',
        label: 'דוחות',
        requires: {
          kind: 'grant',
          // Narrowed from `report.agent.view` as well: `/reports` gates on
          // `report.financial.view` alone, so a revenue_manager or
          // agency_manager saw the item, clicked it and was redirected. A menu
          // entry that leads to a refusal is worse than no entry.
          anyOf: ['report.financial.view'],
        },
        destination: { status: 'ready', href: '/reports' },
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
        destination: {
          status: 'ready',
          href: '/website',
          // Earned: every studio route holds a PlanLock on exactly the
          // plan_does_not_include branch via requireSiteGrant.
          offersUpgrade: true,
        },
      },
      {
        id: 'automations',
        label: 'אוטומציות',
        requires: { kind: 'grant', anyOf: ['automation.view'] },
        destination: {
          status: 'ready',
          href: '/automations',
          offersUpgrade: true,
        },
      },
      // ── Autopilot ────────────────────────────────────────────────────────
      // Five entries rather than one, because they are five different amounts
      // of authority and the menu is where that first becomes visible: the log
      // is gated on `activity_view` and not on `view`, since somebody who may
      // see today's exceptions is not thereby entitled to the whole history of
      // every message ESTIA has sent on the business's behalf.
      //
      // `offersUpgrade: true` on all five is earned rather than asserted:
      // every one of these routes renders the plan-lock on the
      // `plan_does_not_include` branch instead of redirecting, so a customer
      // without the entitlement meets an offer rather than a closed door.
      //
      // `/autopilot/settings/activate` is deliberately absent. It is gated on
      // `autopilot.configure` and reached from the settings screen, because a
      // wizard that switches a business to automatic is not something to put
      // one stray click away in a sidebar.
      {
        id: 'autopilot',
        label: 'טייס אוטומטי',
        requires: { kind: 'grant', anyOf: ['autopilot.view'] },
        destination: {
          status: 'ready',
          href: '/autopilot',
          offersUpgrade: true,
        },
      },
      {
        id: 'autopilot-exceptions',
        label: 'מרכז החריגות',
        requires: { kind: 'grant', anyOf: ['autopilot.view'] },
        destination: {
          status: 'ready',
          href: '/autopilot/exceptions',
          offersUpgrade: true,
        },
      },
      {
        id: 'autopilot-activity',
        label: 'יומן הטייס האוטומטי',
        requires: { kind: 'grant', anyOf: ['autopilot.activity_view'] },
        destination: {
          status: 'ready',
          href: '/autopilot/activity',
          offersUpgrade: true,
        },
      },
      {
        id: 'autopilot-value',
        label: 'מה ESTIA עשתה',
        requires: { kind: 'grant', anyOf: ['autopilot.view'] },
        destination: {
          status: 'ready',
          href: '/autopilot/value',
          offersUpgrade: true,
        },
      },
      {
        id: 'autopilot-settings',
        label: 'הגדרות טייס אוטומטי',
        requires: { kind: 'grant', anyOf: ['autopilot.view'] },
        destination: {
          status: 'ready',
          href: '/autopilot/settings',
          offersUpgrade: true,
        },
      },
      {
        id: 'templates',
        label: 'תבניות',
        requires: { kind: 'grant', anyOf: ['template.manage'] },
        destination: { status: 'ready', href: '/templates' },
      },
      {
        id: 'insights',
        label: 'תובנות',
        // OPEN PRODUCT DECISION, deliberately not taken here.
        //
        // Six of the twelve insights — occupancy direction, unsold nights,
        // closed inventory, cancellations, lead time, booking pace — touch
        // neither money nor automation, and today they sit behind the
        // `automation` entitlement, which only Management carries. So every
        // operational reader on Pro meets a plan lock on a screen that had
        // plenty to tell them.
        //
        // Adding `availability.view` here would open it, and that is why it is
        // not done: `availability.view` carries no entitlement and sits in the
        // booking bundles, so adding it would hand the whole insights module
        // to every package including Basic. That is a pricing decision about
        // what ESTIA sells, not a bug to be fixed in a menu file.
        requires: {
          kind: 'grant',
          anyOf: ['automation.view', 'report.financial.view'],
        },
        // Earned: the plan branch renders the upgrade offer rather than
        // redirecting, so a locked customer reaches the argument for buying.
        destination: {
          status: 'ready',
          href: '/insights',
          offersUpgrade: true,
        },
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
        // `property.view` sits beside `unit.manage` because the screen is a
        // read of inventory and the catalogue has no `unit.view`. Gating the
        // entry on the write grant alone hid the list from everyone entitled
        // to look at it without changing it.
        requires: { kind: 'grant', anyOf: ['unit.manage', 'property.view'] },
        destination: { status: 'ready', href: '/units' },
      },
      {
        id: 'team',
        label: 'צוות',
        requires: { kind: 'grant', anyOf: ['user.view'] },
        destination: { status: 'ready', href: '/team' },
      },
      {
        id: 'roles',
        label: 'תפקידים והרשאות',
        requires: {
          kind: 'grant',
          anyOf: ['role.assign', 'role.create', 'permission.edit'],
        },
        destination: { status: 'ready', href: '/roles' },
      },
      {
        id: 'integrations',
        label: 'חיבורים',
        requires: { kind: 'grant', anyOf: ['integration.manage'] },
        destination: { status: 'ready', href: '/integrations' },
      },
      {
        id: 'audit',
        label: 'יומן ביקורת',
        // Distinct from `activity` above: that is a feed of what happened
        // recently, this is the searchable record with before/after values.
        //
        // `agent.audit.view` was here and had to go: a general manager holds
        // it and does not hold `audit.view`, while `audit_events_select`
        // requires `audit.view` — so the entry offered them a screen that
        // redirected them straight back. It belongs here again the day an
        // agent-only trail exists to send them to.
        requires: { kind: 'grant', anyOf: ['audit.view'] },
        destination: { status: 'ready', href: '/audit' },
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
      // Bringing another system's history in. Gated on `migration.view`, which
      // reads the dry run; running the import needs `migration.apply`, and the
      // screen shows that difference rather than offering a button that fails.
      // No `offersUpgrade`, and no entitlement behind it. Moving your own
      // history into the product cannot be a paid feature: a customer who can
      // be blocked from importing is a customer who never becomes one.
      {
        id: 'migration',
        label: 'ייבוא ממערכת אחרת',
        requires: { kind: 'grant', anyOf: ['migration.view'] },
        destination: { status: 'ready', href: '/migration' },
      },
      {
        id: 'payment-collection',
        label: 'גבייה ותשלומים',
        // No plan entitlement, and that is the point of the screen rather than
        // an omission: a business that confirms by telephone and takes a bank
        // transfer must be able to say so on a package with no card
        // processing at all. `payment.policy_manage` is the one grant in the
        // finance family that `ENTITLEMENT_FOR_GRANT` deliberately does not
        // map.
        requires: { kind: 'grant', anyOf: ['payment.policy_manage'] },
        destination: { status: 'ready', href: '/settings/payments' },
      },
      {
        id: 'notifications',
        label: 'התראות',
        // A real grant rather than the membership escape hatch, and that
        // distinction is the whole reason `notification.preferences.manage`
        // exists. The inbox and the preference grid belong to whoever is
        // signed in — a cleaner must be able to mute their own SMS — so the
        // requirement had to be something everybody holds. `menu.test.ts`
        // pins the escape hatch to one item and says growing it 'is worth a
        // conversation rather than a passing test'; this was that
        // conversation, and the answer was to widen the catalogue by one
        // universal grant instead of widening the weakest requirement the
        // product can state.
        requires: {
          kind: 'grant',
          anyOf: ['notification.preferences.manage'],
        },
        destination: { status: 'ready', href: '/settings/notifications' },
      },
      {
        id: 'guest-journey',
        label: 'מסע האורח',
        // `organization.settings.edit` and no plan entitlement, deliberately.
        // Deciding whether a guest confirms, signs or pays before a booking is
        // confirmed — and when an address is released — is core hospitality,
        // not a paid feature.
        requires: {
          kind: 'grant',
          anyOf: ['organization.settings.edit'],
        },
        destination: { status: 'ready', href: '/settings/guest-journey' },
      },
      {
        id: 'guest-guide',
        label: 'מדריך האירוח',
        // `property.view`, matching the route's own `requireGrant` exactly.
        // A menu entry that admits somebody the page then refuses is a dead
        // click, and a narrower entry than the page hides a screen its
        // holder may use.
        requires: { kind: 'grant', anyOf: ['property.view'] },
        destination: { status: 'ready', href: '/settings/guest-guide' },
      },
      {
        id: 'billing',
        label: 'חבילה וחיוב',
        requires: { kind: 'grant', anyOf: ['organization.billing.manage'] },
        destination: { status: 'ready', href: '/settings/billing' },
      },
      {
        id: 'security',
        label: 'אבטחה',
        requires: {
          kind: 'grant',
          anyOf: ['organization.settings.edit', 'permission.edit'],
        },
        destination: { status: 'ready', href: '/settings/security' },
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
  /**
   * The route, when there is one to reach.
   *
   * Non-null for `available`, and — deliberately — for a `locked` item whose
   * route offers the upgrade. It used to be null for every locked item, and
   * the consequence was
   * that six screens which render an upgrade offer could not be reached by the
   * customer being offered the upgrade: the sidebar showed a padlock and
   * nothing happened when it was pressed. A locked route does not refuse. It
   * explains what the feature is, on the customer's own data, and says what it
   * would cost. Making it unreachable turned the only place the product asks
   * to be paid for into a dead end.
   *
   * Null for `planned`, always. There is nothing built to reach.
   */
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
      // Linked only where the route says it renders the offer. Anywhere else
      // the padlock stays inert, because the alternative is a link that
      // bounces the customer to "you lack a permission" for a permission they
      // hold. See `offersUpgrade` on `MenuDestination`.
      href:
        item.destination.status === 'ready' && item.destination.offersUpgrade
          ? item.destination.href
          : null,
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
    destination: { status: 'ready', href: '/bookings/new' },
  },
  {
    id: 'new-guest',
    label: 'אורח חדש',
    requires: { kind: 'grant', anyOf: ['guest.create'] },
    destination: { status: 'ready', href: '/guests/new' },
  },
  {
    id: 'new-quote',
    label: 'הצעת מחיר',
    requires: { kind: 'grant', anyOf: ['quote.create'] },
    destination: { status: 'ready', href: '/quotes/new' },
  },
  {
    id: 'new-task',
    label: 'משימה',
    requires: { kind: 'grant', anyOf: ['task.create'] },
    destination: { status: 'ready', href: '/tasks/new' },
  },
  {
    id: 'new-incident',
    label: 'דיווח על תקלה',
    requires: { kind: 'grant', anyOf: ['incident.create'] },
    destination: { status: 'ready', href: '/incidents/new' },
  },
  {
    id: 'new-expense',
    label: 'הוצאה',
    requires: { kind: 'grant', anyOf: ['expense.create'] },
    destination: { status: 'ready', href: '/finance/expenses/new' },
  },
  {
    id: 'new-property',
    label: 'נכס',
    requires: { kind: 'grant', anyOf: ['property.create'] },
    destination: { status: 'ready', href: '/properties/new' },
  },
  {
    id: 'invite-member',
    label: 'הזמנת חבר צוות',
    requires: { kind: 'grant', anyOf: ['user.invite', 'agent.invite'] },
    destination: { status: 'ready', href: '/team/invite' },
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
