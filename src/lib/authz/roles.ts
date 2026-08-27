/**
 * System roles — the bundles of permissions ESTIA ships with.
 *
 * These are seeds, not a closed set. A customer can compose custom roles from
 * the same catalogue, and the engine cannot tell the difference: a role is only
 * ever a name attached to a set of grants.
 *
 * Two rules hold for every role defined here:
 *   1. Deny by default — a role grants exactly what it lists and nothing more.
 *   2. Privacy by minimum necessity — an operational role does not receive
 *      guest contact details or money, because its work does not need them.
 */

import { FIELD_PERMISSIONS, PERMISSIONS, type Grant } from './permissions'

export const SYSTEM_ROLES = [
  'organization_owner',
  'administrator',
  'general_manager',
  'property_manager',
  'reservation_manager',
  'reception',
  'revenue_manager',
  'finance_manager',
  'accountant',
  'operations_manager',
  'housekeeping_supervisor',
  'cleaner',
  'maintenance',
  'property_owner',
  'external_vendor',
  'marketing_editor',
] as const

export type SystemRole = (typeof SYSTEM_ROLES)[number]

/** Roles held by ESTIA's own staff. Never assignable inside a customer org. */
export const PLATFORM_ROLES = ['platform_super_admin', 'platform_support'] as const

export type PlatformRole = (typeof PLATFORM_ROLES)[number]

// ── Reusable bundles ──────────────────────────────────────────────────────

const BOOKING_READ: Grant[] = ['booking.view', 'guest.view', 'property.view']

const BOOKING_DESK: Grant[] = [
  ...BOOKING_READ,
  'booking.create',
  'booking.update',
  'booking.cancel',
  'booking.change_status',
  'booking.assign',
  'booking.note.internal',
  'guest.create',
  'guest.update',
  'guest.view_contact',
  'booking.view_price',
  'message.view',
  'message.send',
]

const OPERATIONS_CORE: Grant[] = [
  'task.view',
  'task.create',
  'task.assign',
  'task.update',
  'task.complete',
  'task.verify',
  'checklist.manage',
  'incident.view',
  'incident.create',
  'incident.update',
  'incident.resolve',
  'inventory.view',
  'inventory.edit',
]

const FINANCE_CORE: Grant[] = [
  'finance.view',
  'payment.view',
  'payment.create',
  'payment.capture',
  'payment.refund',
  'payment.void',
  'deposit.hold',
  'deposit.release',
  'expense.view',
  'expense.create',
  'expense.approve',
  'invoice.view',
  'invoice.issue',
  'report.financial.view',
  'report.financial.export',
  'booking.view_price',
  'booking.view_deposit',
  'booking.view_profitability',
]

const MARKETING_CORE: Grant[] = [
  // Writes and designs, but does not publish. Publishing is a manager's
  // decision, and separating the two is what makes the approval flow real
  // rather than a convention people are asked to follow.
  'site.view',
  'site.edit_content',
  'site.edit_design',
  'site.manage_seo',
  'site.ai_generate',
  'review.view',
  'review.manage',
  'product.view',
  'property.view',
]

// ── Role definitions ──────────────────────────────────────────────────────

/**
 * Roles composed explicitly. `organization_owner` and `administrator` are
 * absent by design — they are derived from the catalogue below, so that a
 * permission added next year is covered by them automatically instead of
 * being silently missing until someone notices.
 */
type ComposedRole = Exclude<SystemRole, 'organization_owner' | 'administrator'>

const COMPOSED_ROLE_GRANTS: Record<ComposedRole, readonly Grant[]> = {
  general_manager: [
    ...BOOKING_DESK,
    ...OPERATIONS_CORE,
    'booking.override_price',
    'booking.override_availability',
    'booking.export',
    'booking.view_source',
    'guest.export',
    'property.create',
    'property.update',
    'unit.manage',
    'pricing.manage',
    'product.view',
    'product.manage',
    'order.view',
    'order.fulfil',
    'review.view',
    'review.manage',
    'user.view',
    'user.invite',
    'team.manage',
    'message.assign',
    'template.manage',
    'automation.view',
    'expense.view',
    'expense.create',
    'approval.request',
  ],

  /** Same operational reach as a GM, but confined to assigned properties. */
  property_manager: [
    ...BOOKING_DESK,
    ...OPERATIONS_CORE,
    'booking.export',
    'booking.view_source',
    'unit.manage',
    'property.update',
    'product.view',
    'order.view',
    'order.fulfil',
    'review.view',
    'user.view',
    'message.assign',
    'expense.view',
    'expense.create',
    'approval.request',
  ],

  reservation_manager: [
    ...BOOKING_DESK,
    'booking.override_price',
    'booking.override_availability',
    'booking.export',
    'booking.view_source',
    'booking.view_deposit',
    'payment.view',
    'payment.create',
    'invoice.view',
    'template.manage',
    'approval.request',
  ],

  /**
   * The front desk. Handles people in the building, and is deliberately not
   * given business profitability or export.
   */
  reception: [
    ...BOOKING_READ,
    'booking.update',
    'booking.change_status',
    'booking.note.internal',
    'guest.create',
    'guest.update',
    'guest.view_contact',
    'booking.view_price',
    'booking.view_deposit',
    'message.view',
    'message.send',
    'task.view',
    'task.create',
    'incident.create',
    'payment.view',
    'payment.create',
    'order.view',
    'order.fulfil',
  ],

  revenue_manager: [
    ...BOOKING_READ,
    'booking.view_price',
    'booking.view_source',
    'pricing.manage',
    'booking.override_price',
    'channel.manage',
    'report.financial.view',
    'unit.manage',
  ],

  finance_manager: [
    ...BOOKING_READ,
    ...FINANCE_CORE,
    'guest.view_contact',
    'owner.view',
    'owner_statement.view',
    'owner_statement.issue',
    'owner.view_commission',
    'approval.decide',
    'booking.export',
  ],

  /** Read and export. Never alters an operational record. */
  accountant: [
    'finance.view',
    'payment.view',
    'expense.view',
    'invoice.view',
    'report.financial.view',
    'report.financial.export',
    'booking.view',
    'booking.view_price',
    'property.view',
    'owner_statement.view',
  ],

  operations_manager: [
    ...OPERATIONS_CORE,
    ...BOOKING_READ,
    'task.assign',
    'user.view',
    'team.manage',
    'expense.view',
    'expense.create',
    'approval.request',
  ],

  housekeeping_supervisor: [
    'task.view',
    'task.create',
    'task.assign',
    'task.update',
    'task.complete',
    'task.verify',
    'checklist.manage',
    'incident.view',
    'incident.create',
    'incident.update',
    'inventory.view',
    'inventory.edit',
    'user.view',
    'property.view',
    'booking.view',
  ],

  /**
   * Mobile, task-first, and the sharpest test of the privacy model: a cleaner
   * sees which unit and when, and never a phone number or a price.
   */
  cleaner: ['task.view', 'task.update', 'task.complete', 'incident.create'],

  maintenance: [
    'task.view',
    'task.update',
    'task.complete',
    'incident.view',
    'incident.create',
    'incident.update',
    'inventory.view',
  ],

  /** External owner of a managed property. Sees their asset, nothing else. */
  property_owner: [
    'property.view',
    'booking.view',
    'owner_statement.view',
    'report.financial.view',
  ],

  /** A contractor holding a single job. Not a member of the business. */
  external_vendor: ['task.view', 'task.update', 'task.complete'],

  marketing_editor: MARKETING_CORE,
}

// ── Derived roles ─────────────────────────────────────────────────────────

/**
 * Actions reserved to the owner. An administrator is defined as "everything
 * except these", so the exclusion cannot drift out of step with the catalogue
 * as new permissions are added.
 */
export const OWNER_ONLY: readonly Grant[] = [
  'organization.transfer_ownership',
  'organization.close',
  'organization.billing.manage',
  'permission.edit',
]

/** Platform permissions never belong to a role inside a customer organization. */
function isPlatformGrant(grant: Grant): boolean {
  return grant.startsWith('platform.')
}

/** Everything a customer organization can ever be granted. */
const ALL_ORGANIZATION_GRANTS: readonly Grant[] = [
  ...PERMISSIONS.filter((p) => !isPlatformGrant(p)),
  ...FIELD_PERMISSIONS,
]

/**
 * Resolve a system role to its grants.
 *
 * Owner and administrator are computed from the catalogue rather than listed,
 * so adding a permission does not quietly leave the two most senior roles
 * unable to use it.
 */
export function grantsForSystemRole(role: SystemRole): readonly Grant[] {
  if (role === 'organization_owner') return ALL_ORGANIZATION_GRANTS
  if (role === 'administrator') {
    return ALL_ORGANIZATION_GRANTS.filter((g) => !OWNER_ONLY.includes(g))
  }
  return COMPOSED_ROLE_GRANTS[role]
}

/** Union of the grants held across every role on a membership. */
export function grantsForRoles(roles: readonly SystemRole[]): Set<Grant> {
  const grants = new Set<Grant>()
  for (const role of roles) {
    for (const grant of grantsForSystemRole(role)) grants.add(grant)
  }
  return grants
}
