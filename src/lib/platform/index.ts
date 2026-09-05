/**
 * The ESTIA platform console, in one import.
 *
 * ── What this module is, in one sentence ──────────────────────────────────
 *
 * The back office ESTIA's own staff use to look at customers — and the
 * strictest boundary in the product, because it is the only code that crosses
 * a tenant line on purpose.
 *
 * ── What it may reach ─────────────────────────────────────────────────────
 *
 * Seven tables, and the list is the whole disclosure: `organizations`,
 * `organization_subscriptions`, `plans`, `memberships`, `membership_roles`,
 * `membership_scopes`, `user_profiles` — plus its own `platform_staff` and
 * `platform_support_sessions`, and the `platform_staff`-signed rows of
 * `audit_events`. Every one of those is opened by a policy in
 * `0041_platform_admin.sql` that names `has_platform_permission(...)` and
 * nothing else.
 *
 * A booking, a guest, a payment, an invoice, a task, a message: none of them
 * is readable here, by any code path, for any staff member. Usage counts come
 * from a definer function that returns three integers rather than from reading
 * `properties` and `units`.
 *
 * ── What it may change ────────────────────────────────────────────────────
 *
 * Suspend an account, restore it, and set the per-customer capability
 * overrides. Three writes, each through a database function that writes one
 * thing, each demanding a stated reason, each recorded in the customer's own
 * audit trail where they can read it.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * **Impersonation is not built.** The console can open a time-boxed,
 * reason-stated, recorded READ-ONLY view of an account. It cannot become a
 * customer's user, and it does not pretend to: the fourth condition on real
 * impersonation is that the impersonated session is visibly marked in the
 * customer's own interface at all times, that marking lives in the customer
 * application shell, and a session a customer cannot tell from their own is
 * the weak version of this feature. `support.ts` and
 * `platform_support_sessions` are named for what they are.
 */

export { platformAccess, mayUse, type PlatformAccess } from './access'
export { platformActorFor, platformAuditActor } from './actor'
export {
  listPlatformAuditEvents,
  PLATFORM_AUDIT_PAGE_SIZE,
  type PlatformAuditEvent,
} from './audit'
export {
  capabilityStates,
  isOverridden,
  limitStates,
  mergedLimits,
  type CapabilityOrigin,
  type CapabilityState,
  type LimitState,
} from './capabilities'
export {
  loadPlatformHealth,
  UNCONNECTED_PANELS,
  type HealthMetric,
  type HealthPanel,
  type HealthSource,
  type PlatformHealth,
} from './health'
export {
  definePlatformOperations,
  type CapabilityOverrides,
  type OrganizationSnapshot,
  type PlatformOperations,
  type PlatformStore,
  type SupportViewRecord,
} from './operations'
export {
  listPlatformOrganizations,
  loadDisplayNames,
  loadOrganizationUsage,
  loadPlatformOrganization,
  ORGANIZATION_STATUSES,
  type ConsoleSubscription,
  type OrganizationDetail,
  type OrganizationOwner,
  type OrganizationStatus,
  type OrganizationSummary,
  type OrganizationUsage,
} from './organizations'
export {
  listOrganizationMembers,
  MINIMUM_QUERY_LENGTH,
  PEOPLE_PAGE_SIZE,
  searchPeople,
  type PeopleSearch,
  type Person,
  type PersonMembership,
} from './people'
export { resolvePlatformSession } from './session'
export {
  holdsPlatformGrant,
  isPlatformGrant,
  isPlatformRole,
  platformActorLabel,
  platformGrants,
  PLATFORM_GRANTS,
  PLATFORM_STAFF_STATUSES,
  type PlatformGrant,
  type PlatformSession,
  type PlatformStaffStatus,
} from './staff'
export {
  listSupportViews,
  SupabasePlatformStore,
  type SupportViewSummary,
} from './store'
