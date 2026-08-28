/**
 * The seed catalogue.
 *
 * These are the packages ESTIA ships with on day one. They are a starting
 * point that gets written into the database once — from there the platform
 * administrator edits names, prices, limits and features in the back office,
 * and this file stops being the source of truth.
 *
 * Nothing in the product reads this at runtime. It exists so a fresh
 * installation has something sensible in it, and so the intended shape of the
 * offer is recorded next to the code that enforces it.
 *
 * Prices are in agorot, excluding VAT.
 */

import type { Entitlement } from './entitlements'
import type { Agorot } from './plan'
import type { PlanLimits } from './entitlements'

export interface SeedPlan {
  code: string
  name: string
  description: string
  monthlyPrice: Agorot
  yearlyPrice: Agorot
  limits: PlanLimits
  entitlements: readonly Entitlement[]
  isPublic: boolean
  sortOrder: number
}

/** Ten months for twelve — the two-months-free rule, applied consistently. */
const yearly = (monthly: Agorot): Agorot => monthly * 10

export const SEED_PLANS: readonly SeedPlan[] = [
  {
    code: 'basic',
    name: 'Basic',
    description:
      'ניהול צימר או וילה בודדת — הזמנות, יומן, חוזה, תשלומים וחשבוניות.',
    monthlyPrice: 14900,
    yearlyPrice: yearly(14900),
    limits: { properties: 1, units: 2, members: 2, storageGb: 2 },
    // Payments and invoicing are core on every package. A customer who cannot
    // take money in ESTIA is not really using it, and does not stay.
    // Payments and invoicing are core on every package. A customer who cannot
    // take money in ESTIA is not really using it, and does not stay.
    //
    // `agent_network` is deliberately absent and is sold to Basic as a paid
    // add-on. That needs no code: `subscription.entitlementGrants` already
    // grants a feature to one customer without moving them off their plan.
    entitlements: ['core', 'payments', 'invoicing'],
    isPublic: true,
    sortOrder: 1,
  },
  {
    code: 'direct',
    name: 'Direct',
    description:
      'הכל ב-Basic, ובנוסף אתר עסקי עם SEO והזמנה ישירה — בלי עמלת Airbnb.',
    monthlyPrice: 29900,
    yearlyPrice: yearly(29900),
    limits: { properties: 1, units: 4, members: 3, storageGb: 10 },
    entitlements: [
      'core',
      'payments',
      'invoicing',
      'website',
      'ai_content',
      // Included from Direct upward. A cabin owner selling through two
      // holiday agents is an ordinary case, not a large-operator one, and
      // agents are a growth channel rather than an enterprise feature.
      // Basic buys it as an add-on through `subscription.entitlementGrants`.
      'agent_network',
    ],
    isPublic: true,
    sortOrder: 2,
  },
  {
    code: 'pro',
    name: 'Pro',
    description:
      'למתחמים: צוות ותפקידים, ניקיון ותחזוקה, ערוצי הפצה ותמחור דינמי.',
    monthlyPrice: 64900,
    yearlyPrice: yearly(64900),
    limits: { properties: 5, units: 15, members: 10, storageGb: 50 },
    entitlements: [
      'core',
      'payments',
      'invoicing',
      'website',
      'ai_content',
      'custom_domain',
      'team',
      'operations',
      'channels',
      'dynamic_pricing',
      'agent_network',
    ],
    isPublic: true,
    sortOrder: 3,
  },
  {
    code: 'management',
    name: 'Management',
    description:
      'לחברות ניהול נכסים: פורטל בעלים, דוחות והתחשבנות, אישורים ותקלות.',
    monthlyPrice: 149000,
    yearlyPrice: yearly(149000),
    limits: { properties: 25, units: 60, members: null, storageGb: 200 },
    entitlements: [
      'core',
      'payments',
      'invoicing',
      'website',
      'ai_content',
      'custom_domain',
      'team',
      'operations',
      'channels',
      'dynamic_pricing',
      'agent_network',
      'owner_portal',
      'approvals',
      'automation',
      'custom_roles',
      'multi_brand',
    ],
    isPublic: true,
    sortOrder: 4,
  },
]
