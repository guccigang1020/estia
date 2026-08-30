/**
 * Plan entitlements — what a package includes.
 *
 * An entitlement is a feature switch, not a quantity. "Does this organization
 * have the website module?" is an entitlement; "how many units may it have?"
 * is a quota, and the two behave very differently on refusal. See `quota.ts`.
 *
 * Entitlements are checked inside the authorization engine rather than beside
 * it, so a call site cannot satisfy the permission check and forget the plan
 * check. One gate, two possible reasons for a no.
 */

import type { Grant } from '../authz/permissions'

export const ENTITLEMENTS = [
  'core', // bookings, calendar, guests, contracts — always on
  'payments', // card and Bit collection, deposits, refunds
  'invoicing', // automatic green invoices
  'website', // the customer's public site, SEO, direct booking
  'ai_content', // AI-drafted marketing copy and SEO
  'custom_domain',
  'team', // roles, invitations, assignments
  'operations', // tasks, housekeeping, maintenance, inventory
  'channels', // Airbnb / Booking.com synchronisation
  'dynamic_pricing',
  'owner_portal', // external property owners and their statements
  'agent_network', // external sales agents, agencies, commissions and payouts
  'approvals',
  'automation',
  'custom_roles',
  'multi_brand',
  'api_access',
] as const

export type Entitlement = (typeof ENTITLEMENTS)[number]

/**
 * Which grants are gated by which plan feature.
 *
 * A grant absent from this map is part of the core product and is available on
 * every package — deliberately, including payments and invoicing. A customer
 * who cannot take money in ESTIA is not really using ESTIA, and will leave.
 */
export const ENTITLEMENT_FOR_GRANT: Partial<Record<Grant, Entitlement>> = {
  // Website
  'site.view': 'website',
  'site.edit_content': 'website',
  'site.edit_design': 'website',
  'site.manage_seo': 'website',
  'site.publish': 'website',
  'site.rollback': 'website',
  'site.manage_domain': 'custom_domain',
  // AI drafting of copy, SEO and imagery is metered separately from the site
  // itself, so a customer can hold a website without paying for generation.
  'site.ai_generate': 'ai_content',

  // Team & access
  'user.invite': 'team',
  'user.edit': 'team',
  'user.suspend': 'team',
  'user.remove': 'team',
  'role.assign': 'team',
  'team.manage': 'team',
  'role.create': 'custom_roles',
  'permission.edit': 'custom_roles',

  // Operations
  'task.view': 'operations',
  'task.create': 'operations',
  'task.assign': 'operations',
  'task.update': 'operations',
  'task.complete': 'operations',
  'task.verify': 'operations',
  'checklist.manage': 'operations',
  'inventory.view': 'operations',
  'inventory.edit': 'operations',
  'incident.view': 'operations',
  'incident.create': 'operations',
  'incident.update': 'operations',
  'incident.resolve': 'operations',

  // Revenue
  'channel.manage': 'channels',
  'pricing.manage': 'dynamic_pricing',

  // Owners
  'owner.view': 'owner_portal',
  'owner.manage': 'owner_portal',
  'owner_statement.view': 'owner_portal',
  'owner_statement.issue': 'owner_portal',
  'owner.view_commission': 'owner_portal',

  // Agent network
  //
  // Only the grants that exist because external sellers do. The tools an agent
  // happens to use — availability, holds, quotes, leads, payment links — are
  // deliberately absent from this map: a single-cabin owner on the cheapest
  // package holds a room for a telephone caller and sends them a quote, and
  // charging for that would be gating the core product behind an add-on.
  //
  // The agent and net rates are here, though. They are not prices that exist
  // in a business without a network to sell through.
  'agent.view': 'agent_network',
  'agent.invite': 'agent_network',
  'agent.manage': 'agent_network',
  // The membership behind the seller. Every operation that asserts it also
  // asserts one of the gated grants above, so it changes no answer today —
  // which is exactly why it was easy to leave out, and exactly why leaving it
  // out would not have stayed harmless the first time it was asserted alone.
  'agent.membership.manage': 'agent_network',
  'agent.scope.manage': 'agent_network',
  'agency.manage': 'agent_network',
  'agent_agreement.view': 'agent_network',
  'agent_agreement.manage': 'agent_network',
  'agent_limits.manage': 'agent_network',
  'agent_booking.approve': 'agent_network',
  'agent.audit.view': 'agent_network',
  'commission.view': 'agent_network',
  // The other three commission grants are gated and this one was not, which
  // would have let a business with no agent network write a commission
  // statement it could then neither read, approve nor pay.
  'commission.manage': 'agent_network',
  'commission.approve': 'agent_network',
  'commission.payout': 'agent_network',
  'agent_statement.view': 'agent_network',
  'agent_statement.issue': 'agent_network',
  'report.agent.view': 'agent_network',
  'rate.view_agent': 'agent_network',
  'rate.view_net': 'agent_network',

  // Governance
  'approval.request': 'approvals',
  'approval.decide': 'approvals',
  'automation.view': 'automation',
  'automation.manage': 'automation',
}

/**
 * Quantities a package limits.
 *
 * `null` means unlimited. These are enforced by `quota.ts`, which warns rather
 * than blocks — a business must never be unable to check a guest in because it
 * added one unit too many.
 */
export interface PlanLimits {
  properties: number | null
  units: number | null
  members: number | null
  storageGb: number | null
}
