/**
 * The home screen, declared as data and resolved by the authorization engine.
 *
 * This file is to `/dashboard` what `src/components/nav/menu.ts` is to the
 * sidebar, deliberately and down to the shape of the resolver. Read that file
 * first; everything below is the same idea applied to figures instead of
 * links.
 *
 * ── There is no role name anywhere in here ────────────────────────────────
 *
 * An owner's home screen and a cleaner's home screen differ because their
 * grants differ. Every tile declares the grant it needs to *carry a figure*
 * and, separately, the grant the screen behind it is *gated on*, and the
 * engine decides both. Nothing branches on `role === 'cleaner'`, which is what
 * lets a customer compose a role next year and get a coherent home screen with
 * nobody editing this file.
 *
 * ── A tile is a door, and a door that refuses is worse than no door ───────
 *
 * The product has already shipped menu entries that led straight to a refusal
 * — see the notes on `reports` and `audit` in `menu.ts`, both removed after a
 * general manager clicked them and was redirected back to the page they came
 * from. The mistake is easy to repeat here, because the grant that lets
 * somebody *see a number* and the grant that lets them *open the rows behind
 * it* are genuinely different: `outstanding_balance` is gated on
 * `finance.view` and `/finance/payments` is gated on `payment.view`, and an
 * accountant can hold one without the other.
 *
 * So `destination.requires` is the route's own gate grant, copied from the
 * `requireGrant` call at the top of that route, and a tile whose reader does
 * not hold it renders as a figure with no link rather than as a link to a
 * refusal. `tiles.test.ts` asserts the correspondence for every destination.
 *
 * ── What a tile is not ────────────────────────────────────────────────────
 *
 * It is not a calculation. Every figure on this screen comes from
 * `src/lib/metrics` or from a query module that already exists under
 * `src/app/(app)/*​/_lib/queries.ts`. This file names the tiles; it does not
 * know how to add anything up.
 */

import { authorize, type Actor, type Decision } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { isMetricId, type MetricId } from '@/lib/metrics'
import type { Entitlement } from '@/lib/plans/entitlements'

// ── Declaring a tile ──────────────────────────────────────────────────────

/**
 * What a reader must hold before the tile carries a figure at all.
 *
 * `anyOf` holds *any of* the listed grants, as in the menu: today's board is
 * worth showing to somebody who can see bookings, and the outstanding total is
 * worth showing to somebody who holds either half of the finance pair.
 *
 * `allOf` is the second form and exists because one tile genuinely needs two
 * rights at once: what today's guests still owe is built from a booking total
 * and a payment ledger, and `listOpenBalances` returns `null` rather than an
 * empty list when either is missing — showing an outstanding figure computed
 * from a total the reader may not see would disclose the total by subtraction.
 */
export type TileRequirement =
  | { kind: 'anyOf'; grants: readonly [Grant, ...Grant[]] }
  | { kind: 'allOf'; grants: readonly [Grant, ...Grant[]] }

/**
 * Where the figure opens, and the grant that route refuses without.
 *
 * `requires` is not "the grant that seems related". It is the argument to the
 * `requireGrant` call at the top of the destination route — `/tasks` is
 * `task.view`, `/finance/payments` is `payment.view`, `/reports` is
 * `report.financial.view`. Writing anything else here reintroduces exactly the
 * defect this field exists to prevent.
 *
 * `href` carries the filter, so the screen opens on the rows the number
 * counted rather than on the whole list. A count that opens an unfiltered
 * table makes the reader do the filtering again, and they will do it
 * differently.
 */
export type TileDestination = {
  href: string
  requires: Grant
  /** Hebrew. What the reader is about to open. */
  label: string
}

/**
 * Which band of the screen a tile belongs to.
 *
 * The order is the order of the day, and it is the one principle taken
 * wholesale from the property-management systems worth taking from: today
 * first, then what is waiting for a person, then how the month is going, and
 * the account last. A home screen that opens with a revenue chart answers a
 * question nobody has at eight in the morning.
 */
export type TileBand = 'today' | 'personal' | 'attention' | 'period'

export const TILE_BANDS: readonly TileBand[] = [
  'today',
  'personal',
  'attention',
  'period',
]

export type TileDefinition = {
  id: string
  /** Hebrew. The one thing this tile counts. */
  title: string
  /**
   * Hebrew, one line, written for somebody who has never used the product.
   * It says what the number means, never how it was computed.
   */
  meaning: string
  band: TileBand
  requires: TileRequirement
  /** `null` for a figure with nowhere honest to send the reader. */
  destination: TileDestination | null
}

// ── The catalogue ─────────────────────────────────────────────────────────

/**
 * `TODAY` is the query string that narrows a list to the stays in the building
 * today. It is filled in per request, because "today" is a property-local day
 * and this module has no clock.
 */
export const TODAY_TOKEN = '{today}'

/**
 * The tiles, in reading order within each band.
 *
 * Every destination below is a route that exists today and whose gate grant is
 * stated beside it. `planned` destinations are deliberately absent: the menu
 * shows an unbuilt item so the shape of the product stays visible, and a home
 * screen tile has no such excuse — a figure nobody can open is the dead end
 * the brief for this screen was written to remove.
 */
export const TILES: readonly TileDefinition[] = [
  // ── Today ───────────────────────────────────────────────────────────────
  {
    id: 'departures',
    title: 'עוזבים היום',
    meaning: 'שהיות שמסתיימות היום. הן חוסמות את הניקיון של אחר הצהריים.',
    band: 'today',
    requires: { kind: 'anyOf', grants: ['booking.view'] },
    destination: {
      href: '/action-center',
      requires: 'booking.view',
      label: 'למי בבניין היום',
    },
  },
  {
    id: 'arrivals',
    title: 'מגיעים היום',
    meaning: 'שהיות שמתחילות היום וצריכות מפתח ויחידה נקייה.',
    band: 'today',
    requires: { kind: 'anyOf', grants: ['booking.view'] },
    destination: {
      href: '/action-center',
      requires: 'booking.view',
      label: 'למי בבניין היום',
    },
  },
  {
    id: 'in-house',
    title: 'נמצאים בבית',
    meaning: 'אורחים שכבר בשטח והשהייה שלהם נמשכת גם מחר.',
    band: 'today',
    requires: { kind: 'anyOf', grants: ['booking.view'] },
    destination: {
      href: `/bookings?from=${TODAY_TOKEN}&to=${TODAY_TOKEN}`,
      requires: 'booking.view',
      label: 'לרשימת ההזמנות של היום',
    },
  },
  // Its own band because it is the one entry on this screen that is a list
  // rather than a figure. "Which room next" cannot be answered by a count, and
  // the person who most needs this screen is the person for whom it is the
  // whole screen. See `my-jobs.tsx`.
  {
    id: 'my-jobs',
    title: 'יחידות להכנה היום',
    meaning: 'יחידות שצריך להכין, לנקות או לבדוק היום — לפי שעת היעד.',
    band: 'personal',
    // The doer's grant, not the viewer's. A cleaner, a housekeeping supervisor
    // and a handyman all hold `task.complete`; an accountant holds neither it
    // nor `task.view`, and a general manager who can only *watch* the board
    // gets the operational tile below instead of a personal one.
    requires: { kind: 'anyOf', grants: ['task.complete'] },
    destination: {
      href: '/preparation',
      requires: 'task.view',
      label: 'ללוח ההכנה',
    },
  },

  // ── Waiting for a person ────────────────────────────────────────────────
  {
    id: 'stuck-work',
    title: 'עבודה תקועה או באיחור',
    meaning: 'משימות שנעצרו על משהו חיצוני, או שעבר זמנן ולא נסגרו.',
    band: 'attention',
    requires: { kind: 'anyOf', grants: ['task.view'] },
    // `/action-center` and not `/tasks?status=blocked`, which was the first
    // answer and was wrong. The figure counts blocked work *and* work whose
    // day has passed — `listStuckTasks` merges them deliberately, because both
    // need the same response from the same person this morning — and the task
    // list has a status filter but no "overdue" one. A tile that counts eleven
    // and opens a screen showing four is worse than a tile with no link: the
    // reader trusts the filter and stops looking for the other seven. The
    // action centre lists exactly the rows this number counted.
    destination: {
      href: '/action-center',
      requires: 'task.view',
      label: 'לרשימת העבודה התקועה',
    },
  },
  {
    id: 'unpaid-stays',
    title: 'שהיות שלא שולמו במלואן',
    meaning: 'אורחים שנמצאים כאן היום ועדיין חייבים כסף על השהייה.',
    band: 'attention',
    // Both, and for the reason `listOpenBalances` gives: the balance is a
    // booking total less a payment ledger, and half the pair is not half an
    // answer.
    requires: { kind: 'allOf', grants: ['payment.view', 'booking.view_price'] },
    destination: {
      href: '/finance/payments',
      requires: 'payment.view',
      label: 'לתשלומים',
    },
  },
  {
    id: 'payments-stalled',
    title: 'תשלומים שנעצרו',
    meaning: 'הסולק לא השיב או שהשורה סומנה לבירור. אסור לחייב שוב עד שייסגרו.',
    band: 'attention',
    requires: { kind: 'anyOf', grants: ['payment.view'] },
    destination: {
      href: '/finance/payments?status=unknown',
      requires: 'payment.view',
      label: 'לתשלומים שממתינים לבירור',
    },
  },
  {
    id: 'approvals',
    title: 'החלטות שממתינות לך',
    meaning: 'בקשות שחורגות מתקרה ומחזיקות מכירה או הוצאה פתוחה.',
    band: 'attention',
    requires: { kind: 'anyOf', grants: ['approval.decide'] },
    destination: {
      href: '/action-center',
      requires: 'approval.decide',
      label: 'לתור ההחלטות',
    },
  },

  // ── How the month is going ──────────────────────────────────────────────
  //
  // The ids match `MetricId` for the four metrics this screen shows, so the
  // page pairs a tile with its figure by id and never by position. The grant
  // in `requires` is `METRICS[id].requires`, and `tiles.test.ts` asserts the
  // two have not drifted apart.
  {
    id: 'occupancy',
    title: 'תפוסה החודש',
    meaning: 'אחוז הלילות שנמכרו מתוך הלילות שהיו זמינים למכירה.',
    band: 'period',
    requires: { kind: 'anyOf', grants: ['availability.view'] },
    destination: {
      href: '/reports/operations',
      requires: 'availability.view',
      label: 'לדוח התפעולי',
    },
  },
  {
    id: 'revenue',
    title: 'הכנסות החודש',
    meaning: 'לינה ותוספות על השהיות של החודש, ללא מע״מ.',
    band: 'period',
    requires: { kind: 'anyOf', grants: ['report.financial.view'] },
    destination: {
      href: '/reports',
      requires: 'report.financial.view',
      label: 'לדוח הכספי',
    },
  },
  {
    id: 'outstanding_balance',
    title: 'יתרה לגבייה',
    meaning: 'כסף שטרם שולם על הזמנות שמועד ההגעה שלהן חל החודש.',
    band: 'period',
    // Seeing the total and opening the ledger behind it are different rights —
    // `METRICS.outstanding_balance` says so with `detailRequires` — so the
    // figure is gated on `finance.view` and the link on `payment.view`.
    requires: { kind: 'anyOf', grants: ['finance.view'] },
    destination: {
      href: '/finance/payments',
      requires: 'payment.view',
      label: 'לתשלומים',
    },
  },
  {
    id: 'booking_pace',
    title: 'הזמנות שנסגרו החודש',
    meaning: 'כמה הזמנות נסגרו במהלך החודש, בלי קשר למועד השהייה עצמה.',
    band: 'period',
    requires: { kind: 'anyOf', grants: ['booking.view'] },
    destination: {
      href: '/bookings',
      requires: 'booking.view',
      label: 'לרשימת ההזמנות',
    },
  },
]

/**
 * The metrics the home screen asks the domain for, read off the catalogue.
 *
 * Derived rather than listed a second time. A tile in the `period` band whose
 * id is a `MetricId` *is* the request, so adding a figure to the screen is one
 * edit above and the loader follows. The grant is not restated either: the
 * loader asks `METRICS[id].requires`, which is the dictionary's own answer and
 * the same one `computeDashboard` will apply — a local copy would be a second
 * rule to drift.
 */
export const HOME_METRIC_IDS: readonly MetricId[] = TILES.filter(
  (tile) => tile.band === 'period' && isMetricId(tile.id),
).map((tile) => tile.id as MetricId)

// ── Resolving one for one person ──────────────────────────────────────────

/**
 * What the reader gets.
 *
 *   `shown`  — they hold the rights and the tile carries a figure.
 *   `locked` — they hold the rights and their organization has not bought the
 *              feature. Kept on screen, exactly as the menu keeps a locked
 *              item, because "you may not" and "your package does not include
 *              this" are answered by two different people.
 *
 * Anything else is a real refusal and the tile is absent — not greyed, not
 * zeroed. A cleaner is not shown an empty box where the revenue would be.
 */
export type TileState = 'shown' | 'locked'

export type ResolvedTile = {
  id: string
  title: string
  meaning: string
  band: TileBand
  state: TileState
  /**
   * Non-null only when the reader would actually be admitted to the route.
   * A tile with a null href renders as a figure and nothing more.
   */
  destination: TileDestination | null
  /** The package feature that would unlock it. Set only for `locked`. */
  entitlement: Entitlement | null
}

function decide(actor: Actor, requirement: TileRequirement): Decision[] {
  return requirement.grants.map((grant) => authorize(actor, grant))
}

/**
 * Decide one tile, or `null` to leave it off the screen entirely.
 *
 * The ladder is the menu's, with one addition. An allowed requirement wins. A
 * refusal that was about the package rather than the permission produces
 * `locked`. Anything else is a real "no".
 *
 * The addition is the destination check, and it is the point of the file: the
 * link is attached only when `authorize` admits the reader to the route's own
 * gate grant. A tile can therefore be `shown` with no link, which is the
 * honest rendering for an accountant who may read what is owed and may not
 * open the payment ledger.
 */
export function resolveTile(
  actor: Actor,
  tile: TileDefinition,
): ResolvedTile | null {
  const decisions = decide(actor, tile.requires)

  const held =
    tile.requires.kind === 'anyOf'
      ? decisions.some((decision) => decision.allowed)
      : decisions.every((decision) => decision.allowed)

  const base = {
    id: tile.id,
    title: tile.title,
    meaning: tile.meaning,
    band: tile.band,
  }

  if (!held) {
    const planRefusal = decisions.find(
      (decision) =>
        !decision.allowed && decision.reason === 'plan_does_not_include',
    )

    if (planRefusal && !planRefusal.allowed) {
      return {
        ...base,
        state: 'locked',
        destination: null,
        entitlement: planRefusal.entitlement ?? null,
      }
    }

    return null
  }

  const destination =
    tile.destination !== null &&
    authorize(actor, tile.destination.requires).allowed
      ? tile.destination
      : null

  return { ...base, state: 'shown', destination, entitlement: null }
}

/** Every tile this actor gets, in catalogue order. */
export function buildTiles(actor: Actor): ResolvedTile[] {
  return TILES.map((tile) => resolveTile(actor, tile)).filter(
    (tile): tile is ResolvedTile => tile !== null,
  )
}

/** The tiles of one band, so the page can drop an empty band whole. */
export function tilesInBand(
  tiles: readonly ResolvedTile[],
  band: TileBand,
): ResolvedTile[] {
  return tiles.filter((tile) => tile.band === band)
}

/**
 * The destination with today's date substituted in.
 *
 * The token is replaced rather than the date being written into the catalogue,
 * because the catalogue is a static module and "today" is a property-local day
 * resolved per request. A module-level date would be the day the server
 * started, which is a bug that only appears after midnight.
 */
export function tileHref(destination: TileDestination, today: string): string {
  return destination.href.replaceAll(TODAY_TOKEN, today)
}
