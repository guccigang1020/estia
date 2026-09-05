import type { OrganizationStatus } from '@/lib/platform'
import type { Entitlement } from '@/lib/plans/entitlements'
import type { SubscriptionStatus } from '@/lib/plans/plan'
import type { QuotaKey } from '@/lib/plans/quota'

/**
 * Hebrew for the console's enums.
 *
 * Display only. Nothing in the console decides anything from a label — the
 * codes are what the guard, the policies and the operations compare — and the
 * two are kept apart here so that renaming a word on screen can never change
 * what a screen is allowed to do.
 *
 * Every map is total over its union. A `Record<T, string>` rather than a
 * lookup with a fallback, so adding a status to the database and to the type
 * fails the build here instead of rendering an English enum member in the
 * middle of a Hebrew screen.
 */

export const ORGANIZATION_STATUS_LABEL: Record<OrganizationStatus, string> = {
  onboarding: 'בהקמה',
  active: 'פעיל',
  suspended: 'מושהה',
  closed: 'סגור',
}

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: 'בהתנסות',
  active: 'פעיל',
  past_due: 'בפיגור תשלום',
  paused: 'מוקפא',
  cancelled: 'מבוטל',
}

export const ENTITLEMENT_LABEL: Record<Entitlement, string> = {
  core: 'ליבה',
  payments: 'תשלומים',
  invoicing: 'חשבוניות',
  website: 'אתר עסקי',
  ai_content: 'תוכן AI',
  custom_domain: 'דומיין מותאם',
  team: 'צוות ותפקידים',
  operations: 'תפעול',
  laundry: 'כביסה',
  commerce: 'מכירות ומוצרים',
  channels: 'ערוצי הפצה',
  dynamic_pricing: 'תמחור דינמי',
  owner_portal: 'פורטל בעלים',
  agent_network: 'רשת סוכנים',
  approvals: 'אישורים',
  automation: 'אוטומציות',
  custom_roles: 'תפקידים מותאמים',
  multi_brand: 'ריבוי מותגים',
  api_access: 'גישת API',
  autopilot: 'טייס אוטומטי',
}

export const QUOTA_LABEL: Record<QuotaKey, string> = {
  properties: 'נכסים',
  units: 'יחידות',
  members: 'משתמשים',
  storageGb: 'אחסון (GB)',
}

/**
 * A stored timestamp, for a human.
 *
 * `null` renders as an em dash and never as "היום" or a guessed date. A
 * console reader is often reconstructing a sequence of events, and a date that
 * was filled in rather than read is the one that ruins the reconstruction.
 */
export function hebrewMoment(value: string | null): string {
  if (!value) return '—'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleString('he-IL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function hebrewDate(value: string | null): string {
  if (!value) return '—'
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('he-IL', { dateStyle: 'medium' })
}

/** Days from now until `value`. Negative means it has already passed. */
export function daysUntil(
  value: string | null,
  now = new Date(),
): number | null {
  if (!value) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return Math.ceil((at.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
}
