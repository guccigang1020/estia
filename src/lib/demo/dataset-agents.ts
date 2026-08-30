/**
 * The external sales channel: an agency, the agreement behind it, the terms
 * one agent sells under, and the commission rule that prices the work.
 *
 * ── The agency is not a tenant ────────────────────────────────────────────
 *
 * `agencies` carries no `organization_id`, deliberately: a holiday agency
 * sells for several businesses, and the relationship is the agreement, not
 * ownership. So the agency row is party data and `agency_agreements` is the
 * row that ties it to אחוזת הגליל on particular terms.
 *
 * ── Two ladders and a set ─────────────────────────────────────────────────
 *
 * `agent_organization_settings` is where the graduated access in
 * `src/lib/authz/roles.ts` becomes data. סלים may see availability and book
 * on it, may see the agent rate but not the net rate, and may see a guest's
 * name and phone but never their email. That combination is the demo's whole
 * argument about external access, and it is a row rather than a special case
 * in a screen.
 */

import type { DemoRow } from './types'
import {
  AGENCY_ID,
  ID_GROUP,
  day,
  idsFor,
  momentOn,
  stamped,
  stampedNoDelete,
} from './dataset-support'
import { ORGANIZATION_ID, person } from './dataset-identity'
import { MEMBERSHIP_IDS } from './dataset-access'
import { PROPERTY_IDS } from './dataset-inventory'

const agreementIds = idsFor(ID_GROUP.agencyAgreement)
const ruleIds = idsFor(ID_GROUP.commissionRule)
const settingsIds = idsFor(ID_GROUP.agentSettings)

const OWNER_ID = person('owner').userId
const MANAGER_ID = person('general-manager').userId
const AGENT_ID = person('sales-agent').userId

export const AGENCY_ROWS: DemoRow[] = [
  {
    id: AGENCY_ID,
    name: 'נופש הצפון — סוכנות אירוח',
    tax_id: '514772290',
    contact_phone: '+972 4-681-2290',
    // Generated from `contact_phone`, for the same reason the guest's is.
    contact_phone_e164: '+97246812290',
    contact_email: 'office@nofesh-tzafon.co.il',
    address_line1: 'שדרות ניל״י 8',
    city: 'כרמיאל',
    country: 'IL',
    status: 'active',
    note: 'מוכרת בעיקר סופי שבוע וחבילות למשפחות מהמרכז.',
    metadata: {},
    ...stamped(OWNER_ID, -130),
  },
]

export const AGENCY_MEMBERSHIP_ROWS: DemoRow[] = [
  {
    agency_id: AGENCY_ID,
    user_id: AGENT_ID,
    role: 'agent',
    status: 'active',
    joined_at: momentOn(-125, '09:00'),
    left_at: null,
    metadata: {},
    created_at: momentOn(-125, '09:00'),
    updated_at: momentOn(-125, '09:00'),
    version: 1,
  },
]

export const AGENCY_AGREEMENT_ROWS: DemoRow[] = [
  {
    id: agreementIds(1),
    agency_id: AGENCY_ID,
    organization_id: ORGANIZATION_ID,
    // 10% of the nights alone. The cleaning fee is a cost passed through, and
    // nobody earns a commission on it.
    rule: { kind: 'percentage', percent: 10 },
    base: 'accommodation_only',
    active_from: day(-120),
    active_until: null,
    payment_terms_days: 30,
    status: 'active',
    signed_at: momentOn(-120, '14:00'),
    terminated_at: null,
    termination_reason: null,
    note: 'עמלה משולמת בסוף החודש שלאחר סיום השהות.',
    metadata: {},
    ...stampedNoDelete(OWNER_ID, -120),
  },
]

export const AGENT_COMMISSION_RULE_ROWS: DemoRow[] = [
  {
    id: ruleIds(1),
    organization_id: ORGANIZATION_ID,
    agent_user_id: AGENT_ID,
    agency_id: AGENCY_ID,
    name: 'סלים חדאד — רימונים',
    rule: { kind: 'percentage', percent: 10 },
    base: 'accommodation_only',
    property_ids: [PROPERTY_IDS.rimonim],
    unit_ids: null,
    rate_plan_ids: null,
    period_from: null,
    period_to: null,
    // The commission becomes payable when the guest has actually stayed —
    // not when the booking was made, and not when the deposit landed.
    eligibility_conditions: ['stay_completed'],
    priority: 10,
    effective_from: day(-120),
    effective_until: null,
    note: null,
    metadata: {},
    ...stamped(MANAGER_ID, -120),
  },
]

export const AGENT_ORGANIZATION_SETTINGS_ROWS: DemoRow[] = [
  {
    id: settingsIds(1),
    organization_id: ORGANIZATION_ID,
    agent_user_id: AGENT_ID,
    membership_id: MEMBERSHIP_IDS['sales-agent'],
    access_calendar: 'availability_booking',
    access_price: 'agent',
    // The guest ladder stops at the phone. There is no rung on this dial that
    // hands an external seller a guest's email in this business.
    access_guest_data: 'phone',
    access_amendments: ['guest_details', 'guest_count'],
    access_cancellation_kind: 'until_paid',
    access_cancellation_hours: null,
    access_payment_link: true,
    inventory_kind: 'properties',
    inventory_property_ids: [PROPERTY_IDS.rimonim],
    inventory_unit_ids: [],
    discount_max_percent: '8.000',
    discount_max_agorot: 30_000,
    hold_max_concurrent: 3,
    hold_max_per_day: 10,
    hold_max_extensions: 1,
    hold_default_minutes: 30,
    hold_max_minutes: 120,
    reputation_score: 72,
    agency_id: AGENCY_ID,
    internal_note: 'מוכר טוב, אבל נוטה לבקש הנחות מעבר לתקרה.',
    metadata: {},
    ...stampedNoDelete(MANAGER_ID, -120),
  },
]
