/**
 * The permission catalogue.
 *
 * Every capability in ESTIA is named here exactly once. Authorization asks
 * `can(actor, permission, resource)` — never `if (role === "manager")` — so a
 * role is only ever a bundle of these strings, and a custom role built by a
 * customer is no different in kind from a built-in one.
 *
 * Adding a capability to the product means adding its permission here first.
 */

export const PERMISSIONS = [
  // ── Organization ────────────────────────────────────────────────────────
  'organization.view',
  'organization.settings.edit',
  'organization.billing.manage',
  'organization.transfer_ownership',
  'organization.close',

  // ── Property & Unit ─────────────────────────────────────────────────────
  'property.view',
  'property.create',
  'property.update',
  'property.delete',
  'unit.manage',

  // ── Booking ─────────────────────────────────────────────────────────────
  'booking.view',
  'booking.create',
  'booking.update',
  'booking.cancel',
  'booking.delete',
  'booking.change_status',
  'booking.override_price',
  'booking.override_availability',
  'booking.export',
  'booking.assign',
  'booking.note.internal',

  // ── Guest ───────────────────────────────────────────────────────────────
  'guest.view',
  'guest.create',
  'guest.update',
  'guest.delete',
  'guest.export',

  // ── Finance ─────────────────────────────────────────────────────────────
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

  // ── Team & access ───────────────────────────────────────────────────────
  'user.view',
  'user.invite',
  'user.edit',
  'user.suspend',
  'user.remove',
  'role.create',
  'role.assign',
  'permission.edit',
  'team.manage',

  // ── Operations ──────────────────────────────────────────────────────────
  'task.view',
  'task.create',
  'task.assign',
  'task.update',
  'task.complete',
  'task.verify',
  'checklist.manage',
  'inventory.view',
  'inventory.edit',
  'incident.view',
  'incident.create',
  'incident.update',
  'incident.resolve',

  // ── Communication ───────────────────────────────────────────────────────
  'message.view',
  'message.send',
  'message.assign',
  'template.manage',

  // ── Sales & marketing ───────────────────────────────────────────────────
  'product.view',
  'product.manage',
  'order.view',
  'order.fulfil',
  'review.view',
  'review.manage',
  // Website Studio. Split finely because the roles genuinely differ: a
  // marketing employee writes copy, a manager approves, and only a publisher
  // puts it in front of customers. Domain and SEO are separated again because
  // a mistake in either is expensive and slow to notice.
  'site.view',
  'site.edit_content',
  'site.edit_design',
  'site.manage_seo',
  'site.manage_domain',
  'site.publish',
  'site.rollback',
  'site.ai_generate',
  'pricing.manage',
  'channel.manage',

  // ── Owners ──────────────────────────────────────────────────────────────
  'owner.view',
  'owner.manage',
  'owner_statement.view',
  'owner_statement.issue',

  // ── Governance ──────────────────────────────────────────────────────────
  'audit.view',
  'approval.request',
  'approval.decide',
  'automation.view',
  'automation.manage',
  'integration.manage',

  // ── Platform (ESTIA staff only, never granted to a customer role) ───────
  'platform.organization.view',
  'platform.organization.manage',
  'platform.plan.manage',
  'platform.impersonate',
  'platform.feature_flag.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

/**
 * Field-level permissions.
 *
 * Access to a record is not access to every column of it. A cleaner needs the
 * booking to know which unit to prepare, and must not receive the guest's phone
 * number or what they paid. Enforced where data is shaped for the response —
 * never by hiding it in the UI.
 */
export const SENSITIVE_FIELDS = {
  'guest.contact': ['guest.view_contact'],
  'guest.document_id': ['guest.view_document_id'],
  'booking.price': ['booking.view_price'],
  'booking.source': ['booking.view_source'],
  'booking.deposit': ['booking.view_deposit'],
  'booking.profitability': ['booking.view_profitability'],
  'owner.commission': ['owner.view_commission'],
} as const

export const FIELD_PERMISSIONS = [
  'guest.view_contact',
  'guest.view_document_id',
  'booking.view_price',
  'booking.view_source',
  'booking.view_deposit',
  'booking.view_profitability',
  'owner.view_commission',
] as const

export type FieldPermission = (typeof FIELD_PERMISSIONS)[number]

/** Every string the authorization engine understands. */
export type Grant = Permission | FieldPermission

/**
 * Actions that must never be performed on the strength of a permission alone.
 * They additionally require a fresh authentication, a stated reason, or an
 * approval — decided by organization policy, enforced in the service layer.
 */
export const SENSITIVE_ACTIONS: ReadonlySet<Grant> = new Set<Grant>([
  'booking.delete',
  'payment.refund',
  'payment.void',
  'organization.transfer_ownership',
  'organization.close',
  'organization.billing.manage',
  'permission.edit',
  'guest.export',
  'integration.manage',
  'platform.impersonate',
])
