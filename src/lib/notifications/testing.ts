/**
 * Test support for the notifications module.
 *
 * Actors are built from the **real** role catalogue, through
 * `finance/testing.ts`'s `actorFor`, which is itself built from
 * `grantsForSystemRole`. That matters more here than almost anywhere else in
 * the product: the whole claim of this module is that "who is told" is decided
 * by `can()` and by nothing else, and a test that hand-picked a grant set would
 * prove the engine works for a permission set no customer has.
 *
 * Everything else here is a builder, so that a dozen test files do not each
 * grow a slightly different idea of what a domain event looks like. When those
 * drift, a test passes because its fixture is wrong rather than because the
 * code is right.
 */

import type { Actor } from '../authz/can'
import type { DomainEventName } from '../contracts/events'
import { actorFor, ORG, PROPERTY, type ActorOptions } from '../finance/testing'
import type { Entitlement } from '../plans/entitlements'
import { ENTITLEMENTS } from '../plans/entitlements'
import type { SystemRole } from '../authz/roles'

import type { NotifiableEvent } from './event'
import { DEFAULT_SETTINGS, type NotificationSettings } from './types'

export { ORG, PROPERTY }

/** A second and third property, for the scope proof. */
export const PROPERTY_B = '33333333-3333-4333-8333-3333333333b2'
export const PROPERTY_C = '33333333-3333-4333-8333-3333333333c3'

export const NOW = new Date('2026-03-11T10:00:00.000Z')
/** Inside the default quiet window (22:00–07:00 Asia/Jerusalem). */
export const MIDNIGHT = new Date('2026-03-10T22:40:00.000Z')

export interface NotificationActorOptions extends ActorOptions {
  /**
   * The organization's package. Defaults to everything, so a refusal in a
   * test is about the permission unless the test says otherwise — the plan
   * gate has its own cases and conflating the two makes both harder to read.
   */
  entitlements?: readonly Entitlement[]
}

export function actor(
  role: SystemRole,
  options: NotificationActorOptions = {},
): Actor {
  const base = actorFor(role, options)
  return {
    ...base,
    entitlements: new Set(options.entitlements ?? ENTITLEMENTS),
  }
}

/**
 * A property manager who holds exactly these properties.
 *
 * The fixture behind the module's most important test: a manager holding two
 * properties is not told about the third.
 */
export function propertyManager(propertyIds: readonly string[]): Actor {
  return actor('property_manager', {
    userId: `user-pm-${propertyIds.length}`,
    scope: { kind: 'properties', propertyIds },
  })
}

export function settings(
  overrides: Partial<NotificationSettings> = {},
): NotificationSettings {
  return {
    id: 'settings-1',
    organizationId: ORG,
    version: 1,
    ...DEFAULT_SETTINGS,
    ...overrides,
  }
}

export interface EventOptions {
  organizationId?: string
  propertyId?: string | null
  resourceType?: string
  resourceId?: string
  actorUserId?: string | null
  occurredAt?: Date
  correlationId?: string
  idempotencyKey?: string
  payload?: unknown
}

export function event(
  name: DomainEventName,
  options: EventOptions = {},
): NotifiableEvent {
  return {
    name,
    organizationId: options.organizationId ?? ORG,
    resourceType: options.resourceType ?? 'booking',
    resourceId: options.resourceId ?? 'booking-1',
    propertyId:
      options.propertyId === undefined ? PROPERTY : options.propertyId,
    actorUserId: options.actorUserId ?? null,
    occurredAt: (options.occurredAt ?? NOW).toISOString(),
    correlationId: options.correlationId ?? 'corr-1',
    // Stable by default, because almost every test in this module is about
    // what happens when the same logical event arrives twice.
    idempotencyKey: options.idempotencyKey ?? 'evt-1',
    payload: options.payload ?? {},
  }
}
