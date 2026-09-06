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
// `day` rather than a local date helper: every relative date in the demo is
// computed from one frozen `TODAY`, so a dataset whose today moved mid-render
// cannot produce a reservation that straddles a different day than the
// forecast drawn beside it.
import { day } from './dataset-support'
import {
  LAUNDRY_ITEM_PROFILE_ROWS,
  LAUNDRY_ORDER_LINE_ROWS,
  LAUNDRY_ORDER_ROWS,
  LAUNDRY_PROVIDER_ROWS,
  LAUNDRY_SETTINGS_ROWS,
} from './dataset-laundry'
import {
  STORE_AVAILABILITY_RULE_ROWS,
  STORE_CATEGORY_ROWS,
  STORE_ITEM_ADDON_ROWS,
  STORE_ITEM_OPTION_ROWS,
  STORE_ITEM_OPTION_VALUE_ROWS,
  STORE_ITEM_PROPERTY_OVERRIDE_ROWS,
  STORE_ITEM_ROWS,
  STORE_ORDER_AMENDMENT_ROWS,
  STORE_ORDER_LINE_OPTION_ROWS,
  STORE_ORDER_LINE_ROWS,
  STORE_ORDER_PAYMENT_ROWS,
  STORE_ORDER_ROWS,
  STORE_PACKAGE_ITEM_ROWS,
  STORE_PACKAGE_ROWS,
  STORE_PRICE_HISTORY_ROWS,
  STORE_PROMO_CODE_ROWS,
  STORE_PROVIDER_REQUEST_ROWS,
  STORE_PROVIDER_ROWS,
  STORE_SETTINGS_ROWS,
} from './dataset-store'

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

  // ── Payment collection ──────────────────────────────────────────────────
  //
  // Four tables from 0031. The first two are seeded rather than left empty,
  // deliberately: an empty settings table is not a neutral demo, it is a
  // business that has said nothing about how it takes money, and the screen
  // would honestly render "not configured" for the one case that is not the
  // point of the feature.
  //
  // The point is the Israeli guesthouse that confirms by telephone, asks for a
  // thirty-percent deposit by bank transfer, and has no card processing at
  // all — so `live_payments_enabled` is false and everything still works.
  //
  // Column names taken from `channelFromRow` and `settingsFromRow` in
  // `src/lib/payments/repository.ts` rather than from memory: the channel's
  // flag is `enabled`, not `is_enabled`, and a row shaped from the wrong name
  // reads as a disabled channel instead of failing.
  payment_collection_settings: [
    {
      id: '9f2a4c10-6d3b-4e58-9a71-2c4e6f8a0b12',
      organization_id: ORGANIZATION_ID,
      policy: 'deposit',
      requirements: [],
      deposit_percent_bps: 3000,
      deposit_fixed_agorot: null,
      balance_due_days_before: 14,
      live_payments_enabled: false,
      live_provider: null,
      guest_instructions:
        'לאישור ההזמנה יש להעביר מקדמה. אפשר להעביר בהעברה בנקאית ולשלוח אסמכתא, ואנחנו נאשר תוך יום עסקים.',
      version: 1,
    },
  ],

  payment_manual_channels: [
    {
      id: 'b7c1d3e5-4f60-4a29-8b3d-1e5f7a9c0d24',
      organization_id: ORGANIZATION_ID,
      channel: 'bank_transfer',
      enabled: true,
      display_name: 'העברה בנקאית',
      instructions:
        'בנק הפועלים · סניף 613 · חשבון 123456 · על שם אחוזת רימונים בע״מ. נא לציין את מספר ההזמנה בהעברה.',
      sort_order: 10,
      version: 1,
    },
  ],

  // Empty, and honestly so. An override is something a manager did to one
  // booking and a proof is something a guest uploaded; fabricating either
  // would put an act in the demo that nobody performed.
  payment_collection_overrides: [],
  payment_proofs: [],

  // ── Stock, the forward half ─────────────────────────────────────────────
  //
  // The settings row is not optional decoration. `/inventory` and every screen
  // under it is gated on the module, and an organization with items and no
  // settings row correctly reads as "inventory is off" — so without this row
  // the entire module renders its off state and the forecast cannot be seen at
  // all. `advanced`, because the demo's job is to show what the product does.
  inventory_settings: [
    {
      // No `id`: `organization_id` is the primary key, one settings row per
      // tenant. `dataset.test.ts` cross-checks every demo row against the
      // migrations and caught the invented column, which is exactly what it
      // is for — a fabricated key reads as a real one until something joins
      // on it.
      organization_id: ORGANIZATION_ID,
      mode: 'advanced',
      safety_buffer_units: 0,
      safety_buffer_percent: 10,
      shortage_warning_horizon_days: 7,
      forecast_horizon_days: 30,
      // Two days, which is what makes the timeline bite: linen sent on Friday
      // is not back on Saturday.
      linen_turnaround_days: 2,
      shared_stock: false,
      reservations_enabled: true,
      warehouse_enabled: false,
      discrepancy_tracking: true,
      transfers_enabled: true,
      version: 1,
    },
  ],

  // Two claims on the same towels, three days apart, sized so the second
  // cannot be met while the first is still in the wash.
  //
  // This is the specification's canonical failure reproduced on the demo's own
  // numbers rather than on invented ones: 61 body towels exist at אחוזת
  // רימונים and 12 are already spoken for, so 49 are free. Twenty-five leave
  // on day +2 and thirty are wanted on day +4, and with a two-day turnaround
  // the first twenty-five are not back yet. A forecast that subtracts totals
  // says 49 ≥ 30 and reports nothing. A forecast that walks the timeline
  // reports the shortage before anybody is standing in an unmade bedroom.
  //
  // The item is found by SKU rather than by index, so a seed added above this
  // one moves nothing.
  inventory_reservations: (() => {
    const towels = INVENTORY_ITEM_ROWS.find(
      (row) => row.sku === 'LIN-TOWEL-L' && row.state === 'available',
    )
    const linen = INVENTORY_ITEM_ROWS.find((row) => row.sku === 'LIN-SHEET-K')

    // Declared-and-empty rather than absent if the seeds ever change shape:
    // `DemoDatabase.rows` throws for a key it has never heard of, and a
    // screen cannot render an honest empty state against a table that does
    // not exist.
    if (!towels || !linen) return []

    return [
      {
        id: 'd1f0b284-3a5c-4e79-9b02-1c3d5e7f9a0b',
        organization_id: ORGANIZATION_ID,
        property_id: towels.property_id,
        item_id: towels.id,
        booking_id: null,
        quantity: 25,
        status: 'reserved',
        needed_from: day(2),
        needed_to: day(4),
        note: 'שבת משפחתית — 25 אורחים',
        version: 1,
      },
      {
        id: 'e2a1c395-4b6d-4f80-8c13-2d4e6f8a0b1c',
        organization_id: ORGANIZATION_ID,
        property_id: towels.property_id,
        item_id: towels.id,
        booking_id: null,
        // Forty for thirty guests, and two days after the first claim rather
        // than four. Both were wrong in the first version of this fixture, and
        // the inventory engine's own tests are what said so: at +4 the first
        // twenty-five had already landed — a two-day wash lands exactly on the
        // morning they were wanted — and at thirty the remaining thirty-six
        // covered it anyway. Either correction alone leaves the screen blank.
        //
        // Forty is not a stretched figure for a thirty-person birthday with a
        // pool: most guests take two. The shortage it produces is four, which
        // is the arithmetic being right rather than the fixture being loud.
        quantity: 40,
        status: 'reserved',
        needed_from: day(3),
        needed_to: day(5),
        note: 'אירוע יום הולדת — 30 אורחים',
        version: 1,
      },
      {
        id: 'f3b2d406-5c7e-4a91-9d24-3e5f7a9b0c1d',
        organization_id: ORGANIZATION_ID,
        property_id: linen.property_id,
        item_id: linen.id,
        booking_id: null,
        quantity: 8,
        status: 'reserved',
        needed_from: day(3),
        needed_to: day(5),
        note: 'סטים לווילה כחול ים',
        version: 1,
      },
    ]
  })(),

  // Empty, and honestly so. A discrepancy is something a person counted and a
  // transfer is something a manager approved; seeding either would put an act
  // in the demo that nobody performed.
  inventory_discrepancies: [],
  inventory_transfers: [],

  // ── Laundry ─────────────────────────────────────────────────────────────
  //
  // A hybrid organization: some items washed in-house, some sent out. That is
  // the mode most likely to be misread as two half-built features, so it is
  // the one the demo shows — including a consolidated run across properties,
  // an order somebody adjusted with a stated reason, and one that is overdue.
  laundry_settings: LAUNDRY_SETTINGS_ROWS,
  laundry_providers: LAUNDRY_PROVIDER_ROWS,
  laundry_item_profiles: LAUNDRY_ITEM_PROFILE_ROWS,
  laundry_orders: LAUNDRY_ORDER_ROWS,
  laundry_order_lines: LAUNDRY_ORDER_LINE_ROWS,

  // ── The store ───────────────────────────────────────────────────────────
  //
  // An organization on `simple` — a catalogue and orders handled by hand, with
  // no payment provider anywhere. That is the villa owner selling a שולחן שוק
  // and pool heating, and it is the mode most likely to be dismissed as an
  // unfinished version of the other two.
  store_settings: STORE_SETTINGS_ROWS,
  store_categories: STORE_CATEGORY_ROWS,
  store_providers: STORE_PROVIDER_ROWS,
  store_items: STORE_ITEM_ROWS,
  store_item_options: STORE_ITEM_OPTION_ROWS,
  store_item_option_values: STORE_ITEM_OPTION_VALUE_ROWS,
  store_item_addons: STORE_ITEM_ADDON_ROWS,
  store_packages: STORE_PACKAGE_ROWS,
  store_package_items: STORE_PACKAGE_ITEM_ROWS,
  store_item_property_overrides: STORE_ITEM_PROPERTY_OVERRIDE_ROWS,
  store_availability_rules: STORE_AVAILABILITY_RULE_ROWS,
  store_promo_codes: STORE_PROMO_CODE_ROWS,
  store_orders: STORE_ORDER_ROWS,
  store_order_lines: STORE_ORDER_LINE_ROWS,
  store_order_line_options: STORE_ORDER_LINE_OPTION_ROWS,

  // Empty on purpose, and declared rather than absent: these four are written
  // by the product — a price change somebody made, a payment somebody took, an
  // amendment somebody approved, a request somebody sent a supplier. Seeding
  // any of them would put an act in the demo that nobody performed.
  store_price_history: STORE_PRICE_HISTORY_ROWS,
  store_order_payments: STORE_ORDER_PAYMENT_ROWS,
  store_order_amendments: STORE_ORDER_AMENDMENT_ROWS,
  store_provider_requests: STORE_PROVIDER_REQUEST_ROWS,

  // ── The guest journey's configuration ───────────────────────────────────
  //
  // 0034 created both of these and no screen wrote them, so the whole guest
  // portal was driven by rows nobody could create through the product. The
  // settings screen writes them now, and it needs somewhere to write.
  //
  // Seeded rather than left empty, deliberately. `functions-guest.ts` was
  // reading these through a per-database side store precisely *because*
  // `db.has(table)` was false, while the settings screen writes through
  // `db.from(...)` — two different places, so a change made on the screen
  // never reached the portal. Declaring the tables makes both use the same
  // array, which is what closes that loop.
  guest_journey_settings: [
    {
      id: 'a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      organization_id: ORGANIZATION_ID,
      // The organization default. A property override is a second row with a
      // property_id, and the resolver prefers it — see `effectiveSettings`.
      property_id: null,
      // Every value below is the column's own default from 0034. A demo that
      // configured something unusual would teach the unusual thing.
      contract_mode: 'disabled',
      require_guest_confirmation: true,
      required_detail_fields: [],
      optional_detail_fields: [],
      arrival_release: 'after_confirmation',
      arrival_release_hours: 24,
      during_stay_topics: ['wifi', 'guide', 'access', 'checkout'],
      requests_enabled: true,
      request_categories: [
        'towels',
        'linen',
        'cleaning',
        'maintenance',
        'equipment',
        'other',
      ],
      checkout_declaration_enabled: true,
      review_enabled: false,
      review_url: null,
      rebook_enabled: false,
      reconfirmation_triggers: ['dates', 'guests', 'price', 'cancellation'],
      version: 1,
    },
  ],

  // Per property by definition — `property_id` is NOT NULL on this table,
  // because a door code belongs to a door.
  guest_journey_content: PROPERTY_ROWS.map((property, index) => ({
    id: `b2d3f4a5-6c7e-4f80-9a1b-2c3d4e5f60${String(index).padStart(2, '0')}`,
    organization_id: ORGANIZATION_ID,
    property_id: property.id,
    address_note: 'הבית האחרון ברחוב, שער עץ בהיר.',
    directions: 'ביציאה מכביש 6 באליקים, ארבעה קילומטרים מזרחה.',
    map_url: null,
    access_instructions: 'הקוד נמצא בתיבה שמימין לשער.',
    // Gated in SQL by `guest_arrival_released`, which since 0038 also refuses
    // a cancelled or no-show booking. Seeded so the gate has something real
    // to withhold — a gate tested against an empty value proves nothing.
    access_code: '4821#',
    parking: 'חניה פרטית לשני רכבים לפני השער.',
    wifi_network: 'ESTIA-GUEST',
    // Withheld until the stay actually begins, independently of the arrival
    // gate. Two gates, and the demo can show that they are two.
    wifi_password: 'olive2026',
    property_guide:
      'מזגן: שלט על השיש במטבח. דוד שמש: מתג בכניסה. פינוי אשפה: יום שלישי.',
    emergency_contact: 'דנה — 052-0000000',
    checkout_instructions:
      'להשאיר את המפתח בתיבה, לכבות מזגנים ולסגור את השער.',
    version: 1,
  })),

  /* ── Declared and empty ────────────────────────────────────────────────
   *
   * Forty-three tables the product can read and this dataset does not fill.
   * They are here because `DemoDatabase.rows` throws `MissingDemoTable` for a
   * key it has never heard of — so a table left out entirely makes a read
   * FAIL where it should have answered "nothing yet", and a screen cannot
   * tell that from a broken deployment. That distinction has already cost two
   * screens once; this is the same lesson applied to the six waves that
   * landed after it.
   *
   * Empty rather than seeded, and that is the honest choice rather than an
   * unfinished one. Every one of these is written by the product as it runs:
   * an Autopilot action nobody's engine decided, a notification nobody's
   * event raised, a published website version nobody published, a signed
   * contract nobody signed. Seeding them would be seeding the output of the
   * very code paths the demo exists to exercise — and a demo that ships an
   * audit trail nobody performed, or an automatic action nobody's policy
   * allowed, teaches the wrong thing about a product whose whole argument is
   * that it does not fabricate.
   *
   * A wave that wants its screen populated in the demo should add rows in its
   * own `dataset-*.ts` and reference them here, which is how laundry, store
   * and agents already do it.
   */

  // 0041 · platform console
  platform_staff: [],
  platform_support_sessions: [],

  // 0042 · website studio
  sites: [],
  site_pages: [],
  site_sections: [],
  site_seo: [],
  site_media: [],
  site_versions: [],
  site_domains: [],
  site_generation_requests: [],
  site_quality_runs: [],
  site_quality_findings: [],
  site_booking_requests: [],

  // 0043 · notifications
  notification_settings: [],
  notification_preferences: [],
  notifications: [],
  notification_deliveries: [],
  notification_escalation_rules: [],

  // 0046 · autopilot
  autopilot_capability: [],
  autopilot_settings: [],
  autopilot_property_settings: [],
  autopilot_booking_overrides: [],
  autopilot_policies: [],
  autopilot_safety_rules: [],
  autopilot_exceptions: [],
  autopilot_actions: [],
  autopilot_rule_candidates: [],

  // Guest journey — the other session's wave.
  booking_guest_journey: [],
  booking_guest_confirmations: [],
  booking_guest_details: [],
  booking_contract_signatures: [],
  guest_contract_templates: [],
  guest_link_sends: [],
  guest_requests: [],

  // Agents, finance and preparation — written as the product runs.
  agent_commission_rule_versions: [],
  agent_payout_batches: [],
  agent_payout_batch_lines: [],
  commission_statements: [],
  finance_snapshots: [],
  payment_schedules: [],
  payment_schedule_instalments: [],
  work_plan_versions: [],

  // 0050 · fiscal documents and the guest register
  fiscal_settings: [],
  fiscal_documents: [],
  fiscal_reconciliation_runs: [],
  guest_book_settings: [],
  guest_book_entries: [],

  // 0051 · the channel manager
  channel_connections: [],
  channel_listings: [],
  channel_listing_mappings: [],
  channel_reservations: [],
  channel_sync_runs: [],
  channel_exceptions: [],

  // 0053 · outward guest messages
  guest_messages: [],

  // 0052 · the import factory
  import_sessions: [],
  import_records: [],
  import_conflicts: [],
  import_field_mappings: [],

  // The permission catalogue. Empty for the same reason `role_permissions` is:
  // every role in this demo is `is_system`, and a system role's grants come
  // from the catalogue in code rather than from a table.
  permissions: [],
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
