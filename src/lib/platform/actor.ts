/**
 * Minting the `Actor` the service pipeline demands, from a platform session.
 *
 * ══ READ THIS BEFORE USING IT ═════════════════════════════════════════════
 *
 * `defineOperation` takes an `Actor`, and an `Actor` names an organization and
 * a membership status. A platform staff member has neither: they are not a
 * member of the customer they are about to suspend, and that is the entire
 * point of the model.
 *
 * So this function fills those two fields, and it is worth being exact about
 * what it is claiming and what it is not:
 *
 *   · `organizationId` is the organization being ACTED ON, not one the person
 *     belongs to. It is set so that `authorize()`'s tenant check — the second
 *     rung of its ladder, and the one it calls the most serious failure
 *     possible — compares the target against the target and passes. A platform
 *     actor is therefore minted per action, against one named organization,
 *     and cannot be carried to a second one.
 *
 *   · `membershipStatus: 'active'` is not a claim that a membership exists. It
 *     is the value that makes the first rung mean "this session is live",
 *     which for platform staff is decided by `platform_staff.status` and was
 *     already decided before this function was reached: `resolvePlatformSession`
 *     returns `null` for a revoked colleague, and `null` never gets here.
 *
 * ── Why this is safe, and it is not because of the comment above ──────────
 *
 * The grant set. It contains `platform.*` codes and can contain nothing else —
 * `platformGrants()` filters, `has_platform_permission()` reads only platform
 * roles, and `tg_role_permission_grantable()` refuses a customer permission on
 * a platform role. So the actor this produces is refused by `authorize()` for
 * every customer grant in the catalogue. It cannot delete a booking, refund a
 * payment or read a guest's email, and not because anybody remembered to check
 * — because the grant is not in the set and no code path can put it there.
 *
 * The database agrees independently. Even if this file were wrong, every
 * policy 0041 writes is expressed in terms of `has_platform_permission`, which
 * does not consult this object at all.
 */

import type { Actor } from '@/lib/authz/can'
import type { Entitlement } from '@/lib/plans/entitlements'
import type { AuditActor } from '@/lib/audit/events'

import { platformActorLabel, type PlatformSession } from './staff'

/**
 * A plan gates a customer's features. It does not gate ESTIA's own console.
 *
 * Empty rather than "everything": `ENTITLEMENT_FOR_GRANT` maps no `platform.*`
 * code to an entitlement, so `missingEntitlementFor()` returns null for every
 * grant this actor holds and the set is never consulted. Handing it every
 * entitlement would be a claim that happens to be unread today and would
 * quietly start meaning something the moment somebody mapped a platform grant.
 */
const NO_ENTITLEMENTS: ReadonlySet<Entitlement> = new Set()

/**
 * The actor for one platform action against one organization.
 *
 * `isPlatformStaff` is set, which in `isWithinScope()` means scope is not
 * asked about — correct, because ESTIA staff have no scope: a scope narrows a
 * member to some of their organization's properties, and there is no
 * membership here to narrow.
 */
export function platformActorFor(
  session: PlatformSession,
  targetOrganizationId: string,
): Actor {
  return {
    userId: session.userId,
    organizationId: targetOrganizationId,
    membershipStatus: 'active',
    grants: session.grants,
    scope: { kind: 'all_organization' },
    entitlements: NO_ENTITLEMENTS,
    isPlatformStaff: true,
  }
}

/**
 * How the action is signed in the customer's own audit trail.
 *
 * `type: 'platform_staff'` is the enum member 0005 created for exactly this,
 * and it is what makes the row distinguishable from one of the customer's own
 * employees in their own audit screen. `onBehalfOfUserId` is null and must
 * stay null: a platform action is ESTIA's, no customer asked for it, and the
 * insert policy in 0041 refuses the row if it is set.
 */
export function platformAuditActor(session: PlatformSession): AuditActor {
  return {
    type: 'platform_staff',
    userId: session.userId,
    label: platformActorLabel(session),
    onBehalfOfUserId: null,
  }
}
