/**
 * TEST SUPPORT. Actors, rows and a database that records what it was asked.
 *
 * ── Why this is not `createDemoClient` ───────────────────────────────────
 *
 * Every other screen's query tests drive `createDemoClient(DEMO_DATASET)`,
 * which is the right thing: real roles, real grants, real rows, and a
 * `MissingDemoTable` error rather than a silent `[]` for a table nobody
 * thought about.
 *
 * `DEMO_DATASET.tables` carries no `autopilot_*` key. That is not an oversight
 * this file may fix — `src/lib/demo/dataset.ts` belongs to another worker —
 * and it is exactly the failure the demo client's own header describes: the
 * screens would throw rather than render. It is reported to the coordinator as
 * an integration point, and until the nine tables are declared (empty, which
 * is the honest state for a product that seeds nothing) these tests use a
 * recorder instead.
 *
 * ── What the recorder proves, and what it deliberately does not ──────────
 *
 * It returns the rows it was given, whatever was asked, and records every
 * filter. So a test can assert that the SCOPE NARROWING WAS PUSHED INTO THE
 * QUERY — which is the claim that matters and which a filtering fake would
 * hide behind its own correctness — and can then assert that `can()` dropped
 * the rows the narrowing would have excluded. Two independent floors, checked
 * independently.
 *
 * It does not enforce row level security, and neither does the demo client;
 * that floor is proven in `supabase/tests`, which is another worker's.
 */

import type { Actor, Scope } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'
import type { Db, Row } from '@/lib/persistence'

export const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
export const PROPERTY_A = '22222222-2222-4222-8222-222222222222'
export const PROPERTY_B = '33333333-3333-4333-8333-333333333333'

/** Everything an Autopilot screen might ask for, for the permissive case. */
export const ALL_AUTOPILOT_GRANTS: readonly Grant[] = [
  'autopilot.view',
  'autopilot.use',
  'autopilot.approve',
  'autopilot.configure',
  'autopilot.pause',
  'autopilot.activity_view',
  'autopilot.override',
  'autopilot.rules_manage',
  'property.view',
  'user.view',
]

export function makeActor(
  overrides: Omit<Partial<Actor>, 'grants'> & {
    grants?: readonly Grant[]
  } = {},
): Actor {
  const { grants, ...rest } = overrides
  const scope: Scope = rest.scope ?? { kind: 'all_organization' }
  const entitlements: ReadonlySet<Entitlement> =
    rest.entitlements ?? new Set<Entitlement>(['autopilot', 'operations'])

  return {
    userId: 'user-1',
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants ?? ALL_AUTOPILOT_GRANTS),
    ...rest,
    scope,
    entitlements,
  }
}

/* ------------------------------------------------------------ recorder -- */

export type RecordedCall = {
  table: string
  /** `eq:column`, `in:column`, `gte:column`, `limit`, `order:column`. */
  filters: [string, unknown][]
}

export type Recorder = {
  db: Db
  calls: RecordedCall[]
  /** Every call against one table, in order. */
  on: (table: string) => RecordedCall[]
}

export function recordingDb(tables: Record<string, readonly Row[]>): Recorder {
  const calls: RecordedCall[] = []

  const from = (table: string) => {
    const call: RecordedCall = { table, filters: [] }
    calls.push(call)

    const rows = tables[table] ?? []

    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        call.filters.push([`eq:${column}`, value])
        return api
      },
      in: (column: string, value: unknown) => {
        call.filters.push([`in:${column}`, value])
        return api
      },
      is: (column: string, value: unknown) => {
        call.filters.push([`is:${column}`, value])
        return api
      },
      gte: (column: string, value: unknown) => {
        call.filters.push([`gte:${column}`, value])
        return api
      },
      order: (column: string) => {
        call.filters.push([`order:${column}`, true])
        return api
      },
      limit: (value: number) => {
        call.filters.push(['limit', value])
        return api
      },
      then: <T>(
        resolve: (value: { data: readonly Row[]; error: null }) => T,
      ): Promise<T> =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    }

    return api
  }

  return {
    db: { from } as unknown as Db,
    calls,
    on: (table: string) => calls.filter((call) => call.table === table),
  }
}

/* ---------------------------------------------------------------- rows -- */

export function exceptionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'exception-1',
    property_id: PROPERTY_A,
    domain: 'laundry',
    risk: 'critical',
    state: 'new',
    code: 'laundry.delivery_late',
    title: 'אספקת הכביסה מאחרת',
    detail: 'ההזמנה הייתה אמורה להגיע ב־09:00.',
    resource_type: 'laundry_order',
    resource_id: 'order-9',
    evidence: [
      {
        key: 'laundry.promised_at',
        label: 'הובטח ל־',
        value: '09:00',
        source: 'laundry',
      },
    ],
    caused_by: null,
    due_at: '2026-09-06T12:00:00Z',
    warn_at: null,
    critical_at: null,
    owner_user_id: null,
    first_seen_at: '2026-09-06T06:00:00Z',
    last_seen_at: '2026-09-06T09:30:00Z',
    seen_count: 12,
    ...overrides,
  }
}

export function actionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'action-1',
    property_id: PROPERTY_A,
    exception_id: 'exception-1',
    action_kind: 'guest.send_reminder',
    safety_level: 'external_communication',
    disposition: 'ask_approval',
    run_mode: 'live',
    outcome: 'awaiting_approval',
    confidence: 'high',
    reason: 'היתרה לא שולמה והאורח מגיע היום.',
    trigger_event: 'booking.confirmed',
    evidence: [],
    command: 'messaging.sendGuestMessage',
    suppressed_reason: null,
    error_code: null,
    error_detail: null,
    attempt: 1,
    requested_by: null,
    approved_by: null,
    approved_at: null,
    scheduled_for: null,
    executed_at: null,
    undone_at: null,
    created_at: '2026-09-06T07:00:00Z',
    ...overrides,
  }
}
