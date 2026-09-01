/**
 * Who the organization is, who works in it, and what it pays for.
 *
 * This module holds the rows that everything else points at — the tenant, the
 * people, the role catalogue and the packages — and it deliberately imports
 * nothing from the rest of the dataset. Properties, units and teams depend on
 * these ids; nothing here depends on theirs, so the graph has no cycle and a
 * reader can start at the top.
 *
 * ── The role catalogue is transcribed, not invented ───────────────────────
 *
 * `roles` is seeded by `0002_authz.sql` and `0012_permission_catalogue.sql`
 * with `organization_id = null` — the catalogue is global, and a customer's
 * own roles sit beside it. The Hebrew names below are the ones in those
 * migrations, because they are what the shell prints next to a person's name
 * and a demo that renamed them would be showing a product that does not
 * exist.
 *
 * `role_permissions` is deliberately NOT populated for these rows. Every one
 * of them is `is_system = true`, and `SupabaseActorSource.loadRoles` is
 * explicit that a system role's grants come from the catalogue in code rather
 * than from that table. Filling it would be inventing an answer the product
 * does not read.
 */

import type { SystemRole } from '../authz/roles'
import { SEED_PLANS } from '../plans/catalog'

import type { DemoRow } from './types'
import { ID_GROUP, idsFor, momentOn, stamped } from './dataset-support'

/* ------------------------------------------------------- the tenant ------ */

const organizationIds = idsFor(ID_GROUP.organization)

export const ORGANIZATION_ID = organizationIds(1)

/* -------------------------------------------------------- the people ----- */

const userIds = idsFor(ID_GROUP.userProfile)

/**
 * A person in this business.
 *
 * `role` is the system role their membership carries, and it is the same
 * value the persona switcher offers. Keeping them on one record is what makes
 * "a persona without a membership" impossible to write rather than merely
 * discouraged.
 */
export type DemoPerson = {
  key: string
  userId: string
  fullName: string
  email: string
  phone: string
  role: SystemRole
  employmentType: string
  /** Shown in the switcher. Empty for a member who is not a persona. */
  personaLabel: string | null
  personaSummary: string
}

export const PEOPLE: readonly DemoPerson[] = [
  {
    key: 'owner',
    userId: userIds(1),
    fullName: 'דנה אלמוג',
    email: 'dana@ahuzat-hagalil.co.il',
    phone: '+972 52-441-8890',
    role: 'organization_owner',
    employmentType: 'owner',
    personaLabel: 'בעלת העסק',
    personaSummary:
      'רואה הכול ויכולה הכול — כולל חיוב, הרשאות והעברת בעלות. נקודת הפתיחה של הסיור.',
  },
  {
    key: 'administrator',
    userId: userIds(2),
    fullName: 'יואב שטרן',
    email: 'yoav@ahuzat-hagalil.co.il',
    phone: '+972 54-207-1163',
    role: 'administrator',
    employmentType: 'employee',
    personaSummary:
      'כל הפעולות בארגון, למעט מה ששמור לבעלים. ההבדל מהבעלים נראה בהגדרות, לא ביומן.',
    personaLabel: 'מנהל מערכת',
  },
  {
    key: 'general-manager',
    userId: userIds(3),
    fullName: 'מיכל בר-ששת',
    email: 'michal@ahuzat-hagalil.co.il',
    phone: '+972 50-338-2274',
    role: 'general_manager',
    employmentType: 'employee',
    personaLabel: 'מנהלת כללית',
    personaSummary:
      'ניהול תפעולי ומסחרי מלא של שני הנכסים — הזמנות, כספים, צוות ותפעול.',
  },
  {
    key: 'property-manager',
    userId: userIds(4),
    fullName: 'אבי כהן',
    email: 'avi@ahuzat-hagalil.co.il',
    phone: '+972 52-916-4402',
    role: 'property_manager',
    employmentType: 'employee',
    personaLabel: 'מנהל נכס',
    personaSummary:
      'אותה עוצמה כמו מנהלת כללית, אבל רק באחוזת רימונים. וילה כחול ים פשוט לא קיימת אצלו.',
    // The scope is what makes this persona worth switching to.
  },
  {
    key: 'reception',
    userId: userIds(5),
    fullName: 'נועה פרץ',
    email: 'noa@ahuzat-hagalil.co.il',
    phone: '+972 53-770-9128',
    role: 'reception',
    employmentType: 'employee',
    personaLabel: 'קבלה',
    personaSummary:
      'מקבלת אורחים ומנהלת את היום — בלי רווחיות, בלי ייצוא ובלי הגדרות ארגון.',
  },
  {
    key: 'housekeeping',
    userId: userIds(6),
    fullName: 'ורד מזרחי',
    email: 'vered@ahuzat-hagalil.co.il',
    phone: '+972 54-612-3387',
    role: 'cleaner',
    employmentType: 'employee',
    personaLabel: 'משק בית',
    personaSummary:
      'משימות בלבד. לא רואה שם אורח, לא מחיר ולא כסף — וזה נראה על אותם מסכים.',
  },
  {
    key: 'accountant',
    userId: userIds(7),
    fullName: 'רונית לוי',
    email: 'ronit@levi-cpa.co.il',
    phone: '+972 50-884-2019',
    role: 'accountant',
    employmentType: 'freelancer',
    personaLabel: 'הנהלת חשבונות',
    personaSummary:
      'צפייה וייצוא בלבד. רואה חשבוניות ותשלומים, ולא משנה אף רשומה תפעולית.',
  },
  {
    key: 'sales-agent',
    userId: userIds(8),
    fullName: 'סלים חדאד',
    email: 'salim@nofesh-tzafon.co.il',
    phone: '+972 52-503-7741',
    role: 'sales_agent',
    employmentType: 'agency',
    personaLabel: 'סוכן מכירות חיצוני',
    personaSummary:
      'מוכר שהות באחוזת רימונים בלבד: זמינות, החזקות והזמנות — ורואה רק את העמלות שלו.',
  },
  {
    key: 'housekeeping-supervisor',
    userId: userIds(11),
    fullName: 'סיגל אוחיון',
    email: 'sigal@ahuzat-hagalil.co.il',
    phone: '+972 54-771-2295',
    role: 'housekeeping_supervisor',
    employmentType: 'employee',
    personaLabel: 'אחראית משק בית',
    personaSummary:
      'מרימה הזמנת כביסה ואינה שולחת אותה. רואה את המסר המלא לספק ולא את פרטי הספק — ההפרדה בין מי שמכין למי שמדבר החוצה, על המסך.',
  },
  // Two members who are not personas. They exist so assignments, teams and
  // approvals point at real people rather than at the same eight ids, and so
  // the team screens are not a list of one.
  {
    key: 'second-cleaner',
    userId: userIds(9),
    fullName: 'אמל סרור',
    email: 'amal@ahuzat-hagalil.co.il',
    phone: '+972 52-118-6640',
    role: 'cleaner',
    employmentType: 'contractor',
    personaLabel: null,
    personaSummary: '',
  },
  {
    key: 'maintenance',
    userId: userIds(10),
    fullName: 'יוסי אבוטבול',
    email: 'yossi@ahuzat-hagalil.co.il',
    phone: '+972 54-330-7712',
    role: 'maintenance',
    employmentType: 'contractor',
    personaLabel: null,
    personaSummary: '',
  },
]

/** Look a person up by key. Throws, because a typo here is a broken demo. */
export function person(key: string): DemoPerson {
  const found = PEOPLE.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`Demo dataset: no person named "${key}"`)
  return found
}

export const OWNER_ID = person('owner').userId

/* ------------------------------------------------------------- rows ------ */

export const ORGANIZATION_ROWS: DemoRow[] = [
  {
    id: ORGANIZATION_ID,
    slug: 'ahuzat-hagalil',
    name: 'אחוזת הגליל — אירוח כפרי',
    legal_name: 'אחוזת הגליל אירוח בע״מ',
    business_type: 'complex',
    country: 'IL',
    timezone: 'Asia/Jerusalem',
    currency: 'ILS',
    locale: 'he-IL',
    logo_url: null,
    logo_dark_url: null,
    brand_primary_color: '#1F6F5C',
    brand_secondary_color: '#C9A227',
    status: 'active',
    metadata: {},
    ...stamped(OWNER_ID, -420),
  },
]

export const USER_PROFILE_ROWS: DemoRow[] = PEOPLE.map((entry) => ({
  id: entry.userId,
  full_name: entry.fullName,
  phone: entry.phone,
  // Generated by 0020 from `phone`, and returned like any other column.
  phone_e164: entry.phone.replace(/[^\d+]/g, ''),
  locale: 'he-IL',
  timezone: 'Asia/Jerusalem',
  avatar_url: null,
  mfa_enforced_at: entry.role === 'organization_owner' ? momentOn(-300) : null,
  metadata: {},
  created_at: momentOn(-420, '09:00'),
  updated_at: momentOn(-30, '09:00'),
  version: 2,
}))

/* -------------------------------------------------- the role catalogue --- */

const roleIds = idsFor(ID_GROUP.role)

type RoleSeed = {
  code: string
  name: string
  description: string
  sortOrder: number
  isPlatform: boolean
}

/**
 * Transcribed from the two seed migrations, in their order.
 *
 * The two platform roles are included because the migration creates them and
 * a dataset that quietly dropped them would be describing a different
 * database. They are never assigned to anybody here — `is_platform` roles are
 * ESTIA's own staff and are not assignable inside a customer organization.
 */
const ROLE_SEEDS: readonly RoleSeed[] = [
  {
    code: 'organization_owner',
    name: 'בעל העסק',
    description: 'שליטה מלאה בארגון, כולל חיוב, הרשאות והעברת בעלות.',
    sortOrder: 10,
    isPlatform: false,
  },
  {
    code: 'administrator',
    name: 'מנהל מערכת',
    description: 'כל הפעולות בארגון, למעט הפעולות השמורות לבעלים.',
    sortOrder: 20,
    isPlatform: false,
  },
  {
    code: 'general_manager',
    name: 'מנהל כללי',
    description: 'ניהול תפעולי ומסחרי מלא של העסק.',
    sortOrder: 30,
    isPlatform: false,
  },
  {
    code: 'property_manager',
    name: 'מנהל נכס',
    description: 'אותה עוצמה תפעולית כמו מנהל כללי, מוגבלת לנכסים שהוקצו לו.',
    sortOrder: 40,
    isPlatform: false,
  },
  {
    code: 'reservation_manager',
    name: 'מנהל הזמנות',
    description: 'ניהול הזמנות, זמינות ומחירים מול אורחים.',
    sortOrder: 50,
    isPlatform: false,
  },
  {
    code: 'reception',
    name: 'קבלה',
    description: 'קבלת אורחים ותפעול יומיומי, ללא רווחיות וללא ייצוא.',
    sortOrder: 60,
    isPlatform: false,
  },
  {
    code: 'revenue_manager',
    name: 'מנהל הכנסות',
    description: 'תמחור, ערוצי הפצה ותפוסה.',
    sortOrder: 70,
    isPlatform: false,
  },
  {
    code: 'finance_manager',
    name: 'מנהל כספים',
    description: 'תשלומים, פיקדונות, חשבוניות, הוצאות ודוחות.',
    sortOrder: 80,
    isPlatform: false,
  },
  {
    code: 'accountant',
    name: 'הנהלת חשבונות',
    description: 'צפייה וייצוא בלבד. אינו משנה רשומה תפעולית.',
    sortOrder: 90,
    isPlatform: false,
  },
  {
    code: 'operations_manager',
    name: 'מנהל תפעול',
    description: 'משימות, ניקיון, תחזוקה, תקלות ומלאי.',
    sortOrder: 100,
    isPlatform: false,
  },
  {
    code: 'housekeeping_supervisor',
    name: 'אחראי משק בית',
    description: 'הקצאה ובקרה של עבודות ניקיון והכנת יחידות.',
    sortOrder: 110,
    isPlatform: false,
  },
  {
    code: 'cleaner',
    name: 'מנקה',
    description: 'משימות בלבד. אינו רואה פרטי אורח, מחיר או כסף.',
    sortOrder: 120,
    isPlatform: false,
  },
  {
    code: 'maintenance',
    name: 'אחזקה',
    description: 'תקלות, משימות תחזוקה ומלאי.',
    sortOrder: 130,
    isPlatform: false,
  },
  {
    code: 'property_owner',
    name: 'בעל נכס',
    description: 'בעל נכס חיצוני. רואה את הנכס שלו בלבד.',
    sortOrder: 140,
    isPlatform: false,
  },
  {
    code: 'external_vendor',
    name: 'ספק חיצוני',
    description: 'קבלן המחזיק במשימה בודדת. אינו חלק מהעסק.',
    sortOrder: 150,
    isPlatform: false,
  },
  {
    code: 'marketing_editor',
    name: 'עורך שיווק',
    description: 'כותב ומעצב תוכן לאתר. הפרסום עצמו נשאר בידי מנהל.',
    sortOrder: 160,
    isPlatform: false,
  },
  {
    code: 'referral_agent',
    name: 'סוכן הפניה',
    description: 'ממליץ בלבד. רואה זמינות, ואינו רואה מחיר ואינו מזמין.',
    sortOrder: 170,
    isPlatform: false,
  },
  {
    code: 'sales_agent',
    name: 'סוכן מכירות',
    description: 'מוכר שהות: הצעות מחיר, החזקות והזמנות בנכסים שהוקצו לו.',
    sortOrder: 180,
    isPlatform: false,
  },
  {
    code: 'senior_agent',
    name: 'סוכן בכיר',
    description: 'סוכן מכירות עם מחיר נטו, הנחות רחבות יותר וצפייה בעמלות שלו.',
    sortOrder: 190,
    isPlatform: false,
  },
  {
    code: 'agency_manager',
    name: 'מנהל סוכנות',
    description: 'מנהל צוות סוכנים: היקף, הסכמים, עמלות ודוחות של הסוכנות.',
    sortOrder: 200,
    isPlatform: false,
  },
  {
    code: 'platform_super_admin',
    name: 'מנהל-על ESTIA',
    description: 'צוות ESTIA. גישה לניהול הפלטפורמה.',
    sortOrder: 900,
    isPlatform: true,
  },
  {
    code: 'platform_support',
    name: 'תמיכת ESTIA',
    description: 'צוות ESTIA. צפייה לצורכי תמיכה.',
    sortOrder: 910,
    isPlatform: true,
  },
]

/** `code → id`, so a membership can name a role rather than a uuid. */
export const ROLE_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ROLE_SEEDS.map((seed, index) => [seed.code, roleIds(index + 1)]),
  ),
)

export function roleId(code: SystemRole): string {
  const id = ROLE_IDS[code]
  if (!id) throw new Error(`Demo dataset: no role seeded for "${code}"`)
  return id
}

/** The Hebrew label the shell prints for a role. */
export function roleName(code: SystemRole): string {
  const seed = ROLE_SEEDS.find((candidate) => candidate.code === code)
  if (!seed) throw new Error(`Demo dataset: no role seeded for "${code}"`)
  return seed.name
}

export const ROLE_ROWS: DemoRow[] = ROLE_SEEDS.map((seed) => ({
  id: ROLE_IDS[seed.code],
  // The catalogue is global: a system role belongs to no tenant.
  organization_id: null,
  code: seed.code,
  name: seed.name,
  description: seed.description,
  is_system: true,
  is_platform: seed.isPlatform,
  sort_order: seed.sortOrder,
  metadata: {},
  ...stamped(null, -420),
}))

/* ------------------------------------------------------------ plans ------ */

const planIds = idsFor(ID_GROUP.plan)

/**
 * The packages, taken from `SEED_PLANS` rather than retyped.
 *
 * Prices, limits and entitlements are the catalogue's, so a change there
 * reaches the demo without anybody remembering this file exists.
 */
export const PLAN_ROWS: DemoRow[] = SEED_PLANS.map((plan, index) => ({
  id: planIds(index + 1),
  code: plan.code,
  name: plan.name,
  description: plan.description,
  monthly_price_agorot: plan.monthlyPrice,
  yearly_price_agorot: plan.yearlyPrice,
  limits: plan.limits,
  entitlements: [...plan.entitlements],
  is_public: plan.isPublic,
  sort_order: plan.sortOrder,
  metadata: {},
  ...stamped(null, -420),
}))

/** `code → plans.id`. The plan switcher needs this to repoint the sub. */
export const PLAN_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    SEED_PLANS.map((plan, index) => [plan.code, planIds(index + 1)]),
  ),
)

/**
 * The package the demo opens on.
 *
 * Pro, because opening on Basic would hide two thirds of the product behind
 * locks before anybody had seen it once. The switcher then moves down, which
 * is the direction that teaches something.
 */
export const DEFAULT_PLAN_CODE = 'pro'

const subscriptionIds = idsFor(ID_GROUP.subscription)

/**
 * Exactly one live subscription.
 *
 * `loadPlan` asks for it with `.maybeSingle()`, so a second non-cancelled row
 * would not be a richer demo — it would be an error on every screen. The plan
 * switcher changes `plan_id` on this row rather than adding another.
 */
export const SUBSCRIPTION_ROWS: DemoRow[] = [
  {
    id: subscriptionIds(1),
    organization_id: ORGANIZATION_ID,
    plan_id: PLAN_IDS[DEFAULT_PLAN_CODE],
    status: 'active',
    billing_interval: 'monthly',
    agreed_monthly_price_agorot: 64900,
    agreed_yearly_price_agorot: 649000,
    trial_ends_at: momentOn(-390),
    current_period_start: momentOn(-12),
    current_period_end: momentOn(18),
    cancelled_at: null,
    limit_overrides: {},
    entitlement_grants: [],
    entitlement_revocations: [],
    metadata: {},
    ...stamped(OWNER_ID, -420),
  },
]

/* ------------------------------------------------------- sequences ------- */

export const INVOICE_SEQUENCE_ROWS: DemoRow[] = [
  {
    organization_id: ORGANIZATION_ID,
    series: 'default',
    year: Number(momentOn(0).slice(0, 4)),
    next_number: 41,
    updated_at: momentOn(-2, '18:20'),
  },
]
