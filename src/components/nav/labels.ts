/**
 * Hebrew names for the things the shell has to show but the domain stores as
 * codes: plan entitlements and membership scope kinds.
 *
 * One map, imported by both the menu and the dashboard, because the same
 * feature appearing as "תפעול" in one place and "operations" in another is the
 * kind of small inconsistency that makes a product feel unfinished.
 *
 * A code with no entry falls back to the code itself. That is deliberate: a
 * new entitlement added by another engineer should show up looking untranslated
 * rather than disappear from the screen.
 */

import type { Entitlement } from '@/lib/plans/entitlements'
import type { Scope } from '@/lib/authz/can'

export const ENTITLEMENT_LABELS: Partial<Record<Entitlement, string>> = {
  core: 'ליבה',
  payments: 'סליקה',
  invoicing: 'חשבוניות',
  website: 'אתר',
  ai_content: 'תוכן AI',
  custom_domain: 'דומיין אישי',
  team: 'צוות',
  operations: 'תפעול',
  channels: 'ערוצי הפצה',
  dynamic_pricing: 'תמחור דינמי',
  owner_portal: 'פורטל בעלים',
  approvals: 'אישורים',
  automation: 'אוטומציה',
  custom_roles: 'תפקידים מותאמים',
  multi_brand: 'ריבוי מותגים',
  api_access: 'API',
}

export function entitlementLabel(entitlement: string): string {
  return ENTITLEMENT_LABELS[entitlement as Entitlement] ?? entitlement
}

/**
 * A scope is "what a role may touch", and it is worth saying in words on the
 * dashboard: someone who believes they can see the whole business while their
 * membership is limited to two properties will misread every empty list they
 * meet.
 */
export function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case 'all_organization':
      return 'כל הארגון'
    case 'properties':
      return `${scope.propertyIds.length} נכסים שהוקצו לך`
    case 'units':
      return `${scope.unitIds.length} יחידות שהוקצו לך`
    case 'team':
      return 'הצוות שלך'
    case 'own_records':
      return 'רשומות שהוקצו לך בלבד'
  }
}
