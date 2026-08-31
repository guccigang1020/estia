/**
 * The demo dataset, assembled.
 *
 * One organization — אחוזת הגליל, two properties in the Galilee and the
 * Carmel — seen from eight angles. Everything below is a re-export of rows
 * built in the `dataset-*` modules beside this file; nothing is constructed
 * here except the table map itself, so a reader looking for "what is in the
 * bookings table" opens `dataset-bookings.ts` rather than scrolling.
 *
 * ── Keys are table names, exactly ─────────────────────────────────────────
 *
 * `DemoTables` is `Record<string, DemoRow[]>` keyed as `public.<name>` in the
 * migrations. A typo here does not fail to compile — it produces a table the
 * product queries and finds empty, which looks like a product bug rather than
 * a dataset one. `dataset.test.ts` therefore checks every key against the
 * migrations themselves.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * `role_permissions` is empty: every role here is `is_system`, and
 * `SupabaseActorSource.loadRoles` is explicit that a system role's grants
 * come from the catalogue in code rather than from that table. Filling it
 * would invent an answer the product does not read.
 *
 * `audit_events`, `idempotency_keys`, `payment_attempts`, `refunds`,
 * `credit_notes`, `payment_provider_events`, `work_plans` and the preparation
 * tables are declared and left empty. They are written by the product as it
 * runs; seeding them would be seeding the output of the very code paths this
 * demo exists to exercise, and an audit trail nobody performed is the one kind
 * of fiction a product like this must never ship.
 *
 * Declared and empty is not the same as absent, and the difference cost two
 * screens. `DemoDatabase.rows` throws `MissingDemoTable` for a key it has
 * never heard of, so a table left out entirely makes a read fail where it
 * should have answered "nothing yet" — and a screen cannot tell that from a
 * broken deployment. Every table the product reads belongs in the map, even
 * when the honest contents are none.
 */

import type { DemoDataset, DemoPersona, DemoPlan, DemoTables } from './types'
import { SEED_PLANS } from '../plans/catalog'

import {
  INVOICE_SEQUENCE_ROWS,
  ORGANIZATION_ID,
  ORGANIZATION_ROWS,
  PLAN_ROWS,
  ROLE_ROWS,
  SUBSCRIPTION_ROWS,
  USER_PROFILE_ROWS,
} from './dataset-identity'
import {
  DEMO_PERSONAS,
  MEMBERSHIP_ROLE_ROWS,
  MEMBERSHIP_ROWS,
  MEMBERSHIP_SCOPE_ROWS,
} from './dataset-access'
import {
  AMENITY_ROWS,
  PROPERTY_AMENITY_ROWS,
  PROPERTY_ROWS,
  TEAM_ROWS,
  UNIT_AMENITY_ROWS,
  UNIT_GROUP_ROWS,
  UNIT_ROWS,
} from './dataset-inventory'
import {
  BOOKING_PRICE_LINE_ROWS,
  BOOKING_ROWS,
  BOOKING_STATUS_HISTORY_ROWS,
  GUEST_ROWS,
  HOLD_ROWS,
  UNIT_OCCUPANCY_ROWS,
} from './dataset-bookings'
import {
  COMMISSION_ROWS,
  DEPOSIT_ROWS,
  EXPENSE_ALLOCATION_ROWS,
  EXPENSE_RULE_ROWS,
  INVOICE_LINE_ROWS,
  INVOICE_PAYMENT_ROWS,
  INVOICE_ROWS,
  PAYMENT_ROWS,
} from './dataset-finance'
import {
  AGENCY_AGREEMENT_ROWS,
  AGENCY_MEMBERSHIP_ROWS,
  AGENCY_ROWS,
  AGENT_COMMISSION_RULE_ROWS,
  AGENT_ORGANIZATION_SETTINGS_ROWS,
} from './dataset-agents'
import {
  APPROVAL_ROWS,
  INVENTORY_ITEM_ROWS,
  INVENTORY_MOVEMENT_ROWS,
  TASK_ASSIGNMENT_ROWS,
  TASK_CHECKLIST_ROWS,
  TASK_ROWS,
} from './dataset-operations'

/* -------------------------------------------------------------- tables --- */

const TABLES: DemoTables = {
  // 0001 · identity
  organizations: ORGANIZATION_ROWS,
  user_profiles: USER_PROFILE_ROWS,
  memberships: MEMBERSHIP_ROWS,

  // 0002 · authorization
  roles: ROLE_ROWS,
  membership_roles: MEMBERSHIP_ROLE_ROWS,
  membership_scopes: MEMBERSHIP_SCOPE_ROWS,

  // 0003 · plans
  plans: PLAN_ROWS,
  organization_subscriptions: SUBSCRIPTION_ROWS,

  // 0008 · accommodation
  teams: TEAM_ROWS,
  properties: PROPERTY_ROWS,
  unit_groups: UNIT_GROUP_ROWS,
  units: UNIT_ROWS,
  amenities: AMENITY_ROWS,
  property_amenities: PROPERTY_AMENITY_ROWS,
  unit_amenities: UNIT_AMENITY_ROWS,

  // 0009 · bookings
  guests: GUEST_ROWS,
  bookings: BOOKING_ROWS,
  booking_status_history: BOOKING_STATUS_HISTORY_ROWS,
  booking_price_lines: BOOKING_PRICE_LINE_ROWS,
  holds: HOLD_ROWS,
  unit_occupancy: UNIT_OCCUPANCY_ROWS,

  // 0010 · payments, 0016 · finance, 0022 · invoice links
  payments: PAYMENT_ROWS,
  deposits: DEPOSIT_ROWS,
  invoice_sequences: INVOICE_SEQUENCE_ROWS,
  invoices: INVOICE_ROWS,
  invoice_lines: INVOICE_LINE_ROWS,
  invoice_payments: INVOICE_PAYMENT_ROWS,
  expense_rules: EXPENSE_RULE_ROWS,
  expense_allocations: EXPENSE_ALLOCATION_ROWS,

  // 0011 · operations
  tasks: TASK_ROWS,
  task_assignments: TASK_ASSIGNMENT_ROWS,
  task_checklists: TASK_CHECKLIST_ROWS,
  inventory_items: INVENTORY_ITEM_ROWS,
  inventory_movements: INVENTORY_MOVEMENT_ROWS,
  approvals: APPROVAL_ROWS,
  commissions: COMMISSION_ROWS,

  // 0015 / 0019 · the agent network
  agencies: AGENCY_ROWS,
  agency_memberships: AGENCY_MEMBERSHIP_ROWS,
  agency_agreements: AGENCY_AGREEMENT_ROWS,
  agent_commission_rules: AGENT_COMMISSION_RULE_ROWS,
  agent_organization_settings: AGENT_ORGANIZATION_SETTINGS_ROWS,

  // Written by the product, never seeded. Present and empty so a query
  // against them answers "nothing yet" rather than "no such table".
  role_permissions: [],
  invitations: [],
  audit_events: [],
  idempotency_keys: [],
  payment_attempts: [],
  refunds: [],
  credit_notes: [],
  credit_note_lines: [],
  agent_invitations: [],

  // These three belong to the list above and were missing from it, which is
  // not the same as being seeded empty: `DemoDatabase.rows` throws
  // `MissingDemoTable` for a key it has never heard of, so the preparation
  // read failed instead of answering "nothing scheduled yet". A screen cannot
  // render an honest empty state against a table that does not exist.
  work_plans: [],
  preparation_catalogues: [],
  preparation_snapshots: [],

  // The same omission, found the same way. `SupabaseFinanceRepository`
  // rebuilds `Payment.appliedEventIds` from this table on every payment read,
  // so `loadPaymentsForBooking` threw `MissingDemoTable` before returning a
  // row. The table is owned by the webhook ingestion path — the only code that
  // knows an event's provider, type and payload, all `NOT NULL` — exactly like
  // `payment_attempts` and `audit_events` above, so it is seeded empty rather
  // than filled: an applied event nobody delivered is fabricated evidence.
  payment_provider_events: [],
}

export const DEMO_DATASET: DemoDataset = {
  organizationId: ORGANIZATION_ID,
  tables: TABLES,
}

/* ------------------------------------------------------------ personas --- */

export { DEMO_PERSONAS }
export type { DemoPersona }

/* --------------------------------------------------------------- plans --- */

/** The Hebrew names the switcher shows. The codes are the catalogue's. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  basic: 'Basic — צימר בודד',
  direct: 'Direct — עם אתר והזמנה ישירה',
  pro: 'Pro — מתחם, צוות ותפעול',
}

/**
 * The three packages the demo runs on.
 *
 * Entitlements come from `SEED_PLANS` rather than being retyped, so the demo
 * cannot claim a feature the catalogue does not sell. `management` exists in
 * the catalogue and is deliberately not offered here: it adds an owner portal
 * and multi-brand, neither of which has a screen yet, so switching to it
 * would show nothing new and imply otherwise.
 */
export const DEMO_PLANS: readonly DemoPlan[] = SEED_PLANS.filter(
  (plan) => plan.code in PLAN_LABELS,
).map((plan) => ({
  code: plan.code,
  label: PLAN_LABELS[plan.code],
  entitlements: plan.entitlements,
}))
