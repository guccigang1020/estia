/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The shared shape every laundry screen resolves before it renders anything.
 *
 * Seven routes each needed the same four steps in the same order — gate, shell
 * context, the mode, the item profiles — and four of them needed the property
 * names as well. Writing that out seven times is how the fifth screen ends up
 * checking the mode after reading the orders, which renders a list to somebody
 * whose business has no laundry operation.
 *
 * So it is one function, and the order is fixed inside it:
 *
 *   1. the gate     — permission, then the plan, and the plan renders an offer
 *   2. the context  — which workspace, which property is selected
 *   3. the mode     — because `off` means the section does not exist
 *   4. the section  — because `simple` has no orders and no providers
 *
 * A page that reaches step four has an answer to "should this screen exist at
 * all" before it has read a single order.
 */

import { notFound } from 'next/navigation'

import { holdsGrant, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'
import {
  hasSection,
  vocabularyFor,
  type LaundryRepository,
  type LaundrySection,
  type LaundryVocabulary,
} from '@/lib/laundry'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireLaundryGrant } from './gate'
import { laundryContext, propertyNames, type LaundryContext } from './queries'
import { laundryRepository } from './wiring'

export type LaundryView = {
  actor: Actor
  /**
   * The tenant-scoped adapter, resolved once for the request.
   *
   * It lives on the view rather than being rebuilt per page so the seven
   * routes share one client — and, more to the point, so that a screen cannot
   * perform a laundry read without going through the thing that applies the
   * `organization_id` filter. Reaching for `createClient()` inside a page is
   * how the eight unscoped queries this replaced came to exist.
   */
  repo: LaundryRepository
  /** True when the grant held but the package does not carry the module. */
  locked: boolean
  entitlement: Entitlement | null
  mayReachBilling: boolean
  mayManage: boolean
  mayCreateOrders: boolean
  maySend: boolean
  mayManageProviders: boolean
  /** `null` when the person is looking at every property in their scope. */
  propertyId: string | null
  propertyName: string | null
  properties: ReadonlyMap<string, string>
  context: LaundryContext
  vocabulary: LaundryVocabulary
}

/**
 * Everything a laundry route needs, resolved once.
 *
 * `section` is what makes this more than a helper. A route that names the
 * section it belongs to gets a 404 when the current mode does not have it —
 * not a redirect, and not an empty page. `/laundry/orders` under a `simple`
 * operation is a URL that genuinely does not exist for that business, and
 * `notFound()` is the honest HTTP answer; rendering an empty orders list would
 * be a promise that orders are coming.
 *
 * `off` is handled by the caller rather than here, because the dashboard has
 * something to say about it — see `LaundryModeOff` — and the other screens
 * simply do not exist.
 */
export async function laundryView(
  grant: Grant,
  section: LaundrySection | null,
): Promise<LaundryView | null> {
  const [access, context] = await Promise.all([
    requireLaundryGrant(grant),
    shellContext(),
  ])

  // `requireLaundryGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  const repo = await laundryRepository()
  const laundry = await laundryContext(repo, access.actor, propertyId)
  const mode = laundry.settings.settings.mode

  // A section this mode does not have is not a screen with nothing on it.
  // `off` reaches here with `section` of `null` from the dashboard only.
  //
  // THE PLAN LOCK WINS OVER THE MODE, and the order is load-bearing. An
  // organization whose package does not include the module has necessarily
  // configured no mode, so it resolves to `off` — and 404ing them would hide
  // the upgrade offer behind a page that claims not to exist. That is the
  // worst of both refusals: the customer most likely to buy is told the URL is
  // wrong. So a locked reader always gets the offer, and the mode gate applies
  // only to somebody whose package already includes the module and who has
  // genuinely switched that section off.
  if (
    access.kind !== 'locked' &&
    section !== null &&
    !hasSection(mode, section)
  ) {
    notFound()
  }

  const properties = await propertyNames(repo, access.actor)

  return {
    actor: access.actor,
    repo,
    locked: access.kind === 'locked',
    entitlement: access.kind === 'locked' ? access.entitlement : null,
    mayReachBilling: holdsGrant(access.actor, 'organization.billing.manage'),
    mayManage: holdsGrant(access.actor, 'laundry.manage'),
    mayCreateOrders: holdsGrant(access.actor, 'laundry.order_create'),
    maySend: holdsGrant(access.actor, 'laundry.order_send'),
    mayManageProviders: holdsGrant(access.actor, 'laundry.provider_manage'),
    propertyId,
    propertyName:
      propertyId === null ? null : (properties.get(propertyId) ?? null),
    properties,
    context: laundry,
    vocabulary: vocabularyFor(mode),
  }
}

/** A property's name, or its id — never an invented one. */
export function nameOf(
  properties: ReadonlyMap<string, string>,
  propertyId: string,
): string {
  return properties.get(propertyId) ?? propertyId
}
