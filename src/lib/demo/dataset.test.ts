/**
 * The dataset, checked against the database it claims to imitate.
 *
 * ── Why this test reads the migrations ────────────────────────────────────
 *
 * A fixture is only useful if it is the shape the product actually receives.
 * The cheap version of this test transcribes a list of column names beside the
 * dataset and asserts they match — which proves the two transcriptions agree,
 * and proves nothing about Postgres. So the schema here is parsed out of
 * `supabase/migrations/*.sql` at test time. A column added tomorrow reaches
 * this test without anybody editing it, and a `not null` column the dataset
 * forgot fails the build on the migration that introduced it.
 *
 * Three properties are asserted about every table:
 *
 *   1. the table exists in the migrations at all — a typo in a key produces a
 *      table the product queries and finds empty, which reads as a product bug
 *      rather than a dataset one;
 *   2. every key on every row is a real column — the same typo, one level down;
 *   3. every `not null` column without a default carries a value.
 *
 * The third rule is the one that matters, and its exclusions are deliberate: a
 * column with a `default` is one Postgres fills in, and a `generated always as`
 * column is one Postgres computes. Requiring either would be requiring the
 * dataset to do the database's job.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SEED_PLANS } from '../plans/catalog'
import { SYSTEM_ROLES } from '../authz/roles'

import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from './dataset'
import { TODAY } from './dataset-support'

/* ------------------------------------------------------- the schema ------ */

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, '..', '..', '..', 'supabase', 'migrations')

type ColumnSchema = {
  /** Whether a row must supply it: `not null`, no default, not generated. */
  required: boolean
  /** The declared type, lower-cased — `uuid`, `text`, `integer`, … */
  type: string
}

type TableSchema = {
  columns: Map<string, ColumnSchema>
}

/** Words that begin a table constraint rather than a column. */
const NOT_A_COLUMN = new Set([
  'constraint',
  'unique',
  'primary',
  'check',
  'foreign',
  'exclude',
  'like',
  'partition',
])

/** The first token of a column definition, which is its type. */
function typeOf(definition: string): string {
  return (/^(\S+)/.exec(definition)?.[1] ?? '').toLowerCase()
}

function isRequired(definition: string): boolean {
  if (!/\bnot\s+null\b/.test(definition)) return false
  // A default is a value Postgres supplies; a generated column is one it
  // computes. Neither is the dataset's to provide.
  if (/\bdefault\b/.test(definition)) return false
  if (/\bgenerated\s+always\s+as\b/.test(definition)) return false
  return true
}

function readSchema(): Map<string, TableSchema> {
  const schema = new Map<string, TableSchema>()

  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const lines = readFileSync(join(MIGRATIONS, file), 'utf8').split(/\r?\n/)

    let creating: TableSchema | null = null
    let altering: TableSchema | null = null

    for (const line of lines) {
      // ── create table ────────────────────────────────────────────────────
      const created = /^create table if not exists public\.(\w+)\s*\(/.exec(
        line,
      )
      if (created) {
        const existing = schema.get(created[1])
        creating = existing ?? { columns: new Map() }
        schema.set(created[1], creating)
        altering = null
        continue
      }

      if (creating) {
        if (/^\);/.test(line)) {
          creating = null
          continue
        }
        // Exactly two spaces of indent is what a column definition carries;
        // a wrapped constraint line carries four or more.
        const column = /^ {2}([a-z_][a-z0-9_]*)\s+(\S.*)$/.exec(line)
        if (column && !NOT_A_COLUMN.has(column[1])) {
          creating.columns.set(column[1], {
            required: isRequired(column[2]),
            type: typeOf(column[2]),
          })
        }
        continue
      }

      // ── alter table … add column ────────────────────────────────────────
      const altered = /^\s*alter table public\.(\w+)\b/.exec(line)
      if (altered) {
        const existing = schema.get(altered[1])
        altering = existing ?? { columns: new Map() }
        schema.set(altered[1], altering)
        continue
      }

      if (altering) {
        const added =
          /add column(?: if not exists)?\s+([a-z_][a-z0-9_]*)\s+(.*)$/.exec(
            line,
          )
        if (added) {
          altering.columns.set(added[1], {
            required: isRequired(added[2]),
            type: typeOf(added[2]),
          })
        }
        if (/;\s*$/.test(line)) altering = null
      }
    }
  }

  return schema
}

const SCHEMA = readSchema()

/* ------------------------------------------------------------- helpers -- */

const tables = DEMO_DATASET.tables

function rows(table: string) {
  const found = tables[table]
  if (!found) throw new Error(`The demo dataset has no '${table}' table`)
  return found
}

function ids(table: string, column = 'id'): Set<unknown> {
  return new Set(rows(table).map((row) => row[column]))
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/* ---------------------------------------------------------- the schema -- */

describe('the dataset matches the migrations', () => {
  it('parsed a schema at all — otherwise everything below is vacuous', () => {
    expect(SCHEMA.size).toBeGreaterThan(40)
    expect(SCHEMA.get('bookings')?.columns.get('check_in')?.required).toBe(true)
    expect(SCHEMA.get('bookings')?.columns.get('check_in')?.type).toBe('date')
    // A default, so Postgres supplies it.
    expect(SCHEMA.get('bookings')?.columns.get('status')?.required).toBe(false)
    // Generated, so Postgres computes it.
    expect(SCHEMA.get('bookings')?.columns.get('stay')?.required).toBe(false)
    // Added by a later migration, and found anyway.
    expect(SCHEMA.get('payments')?.columns.has('purpose')).toBe(true)

    // The assertion below this one is only worth anything if the parse found
    // required columns to assert about. `bookings` has six.
    const requiredOnBookings = [...(SCHEMA.get('bookings')?.columns ?? [])]
      .filter(([, column]) => column.required)
      .map(([name]) => name)
    expect(requiredOnBookings).toEqual([
      'organization_id',
      'property_id',
      'unit_id',
      'guest_id',
      'check_in',
      'check_out',
    ])
  })

  it('names only tables the migrations create', () => {
    const unknown = Object.keys(tables).filter((name) => !SCHEMA.has(name))
    expect(unknown).toEqual([])
  })

  it('names EVERY table the migrations create', () => {
    // The direction above cannot catch the failure that has actually
    // happened here twice. `DemoDatabase.rows` throws `MissingDemoTable` for
    // a key it has never heard of, so a table left out entirely makes a
    // demo-mode read fail where it should have answered "nothing yet" — and
    // a screen cannot tell that from a broken deployment.
    //
    // It went undetected for 43 tables, then for 17 more, because the only
    // assertion ran the other way: it proved no key was invented and said
    // nothing about keys that were missing. Both directions, from here on.
    //
    // Declared and empty is the correct answer for most of these. The point
    // is that the answer is written down.
    const missing = [...SCHEMA.keys()].filter((name) => !(name in tables))
    expect(missing).toEqual([])
  })

  it('puts only real columns on its rows', () => {
    const strays: string[] = []

    for (const [table, list] of Object.entries(tables)) {
      const known = SCHEMA.get(table)?.columns
      if (!known) continue
      for (const [index, row] of list.entries()) {
        for (const key of Object.keys(row)) {
          if (!known.has(key)) strays.push(`${table}[${index}].${key}`)
        }
      }
    }

    expect(strays).toEqual([])
  })

  it('supplies every not-null column that has no default', () => {
    const missing: string[] = []

    for (const [table, list] of Object.entries(tables)) {
      const schema = SCHEMA.get(table)
      if (!schema) continue

      const required = [...schema.columns.entries()]
        .filter(([, column]) => column.required)
        .map(([name]) => name)

      for (const [index, row] of list.entries()) {
        for (const column of required) {
          if (row[column] === undefined || row[column] === null) {
            missing.push(`${table}[${index}].${column}`)
          }
        }
      }
    }

    expect(missing).toEqual([])
  })

  it('carries rows in every table the demo promises to populate', () => {
    const populated = [
      'organizations',
      'user_profiles',
      'memberships',
      'roles',
      'membership_roles',
      'membership_scopes',
      'plans',
      'organization_subscriptions',
      'teams',
      'properties',
      'units',
      'guests',
      'bookings',
      'booking_price_lines',
      'unit_occupancy',
      'holds',
      'payments',
      'invoices',
      'invoice_lines',
      'deposits',
      'tasks',
      'task_assignments',
      'task_checklists',
      'inventory_items',
      'inventory_movements',
      'approvals',
      'commissions',
      'agencies',
      'agency_agreements',
      'agent_organization_settings',
      'expense_rules',
      'expense_allocations',
    ]

    const empty = populated.filter((table) => rows(table).length === 0)
    expect(empty).toEqual([])
  })
})

/* ---------------------------------------------------------- identifiers -- */

describe('identifiers', () => {
  /**
   * Every `uuid` column, and only those.
   *
   * Asked of the migration's declared type rather than of the column's name:
   * `properties.tax_id` and `invoices.provider_invoice_id` end in `_id` and
   * are `text`, because a company number and a provider's reference are not
   * uuids. A name-based rule would have demanded a uuid there and taught the
   * dataset to write a fake one.
   */
  it('writes a real uuid in every uuid column', () => {
    const bad: string[] = []

    for (const [table, list] of Object.entries(tables)) {
      const schema = SCHEMA.get(table)
      if (!schema) continue

      for (const [index, row] of list.entries()) {
        for (const [key, value] of Object.entries(row)) {
          if (schema.columns.get(key)?.type !== 'uuid') continue
          if (value === null) continue
          if (typeof value !== 'string' || !UUID.test(value)) {
            bad.push(`${table}[${index}].${key}=${String(value)}`)
          }
        }
      }
    }

    expect(bad).toEqual([])
  })

  it('does not repeat a primary key inside one table', () => {
    for (const list of Object.values(tables)) {
      const keyed = list.filter((row) => row.id !== undefined)
      if (keyed.length === 0) continue
      expect(new Set(keyed.map((row) => row.id)).size).toBe(keyed.length)
    }
  })
})

/* ------------------------------------------------------------ personas -- */

describe('every persona is a real member', () => {
  const memberships = rows('memberships')
  const membershipRoles = rows('membership_roles')
  const roles = rows('roles')

  it('offers the nine the tour walks, in order', () => {
    // Pinned as a list rather than counted, because the order is what the
    // switcher shows and what resolvePersona falls back to when no cookie
    // names one. The first entry is the owner, and that is deliberate: it is
    // the demo front door.
    //
    // housekeeping_supervisor joined ninth. Without it the laundry module
    // central distinction — the supervisor raises an order and a manager sends
    // it, because sending is a message to an outside company in the
    // organization name — had no identity that could see it, and was proved
    // only by unit test.
    expect(DEMO_PERSONAS.map((persona) => persona.role)).toEqual([
      'organization_owner',
      'administrator',
      'general_manager',
      'property_manager',
      'reception',
      'cleaner',
      'accountant',
      'sales_agent',
      'housekeeping_supervisor',
    ])
  })

  it.each(DEMO_PERSONAS.map((persona) => [persona.label, persona] as const))(
    '%s has an active membership in the demo organization',
    (_label, persona) => {
      const membership = memberships.find(
        (row) => row.user_id === persona.userId,
      )

      expect(membership).toBeDefined()
      expect(membership?.organization_id).toBe(DEMO_DATASET.organizationId)
      // Anything but `active` and the shell refuses to render a menu at all.
      expect(membership?.status).toBe('active')
    },
  )

  it.each(DEMO_PERSONAS.map((persona) => [persona.label, persona] as const))(
    '%s holds exactly the role the switcher names',
    (_label, persona) => {
      const membership = memberships.find(
        (row) => row.user_id === persona.userId,
      )
      const assignments = membershipRoles.filter(
        (row) => row.membership_id === membership?.id,
      )

      const codes = assignments.map(
        (row) => roles.find((role) => role.id === row.role_id)?.code,
      )

      expect(codes).toEqual([persona.role])
    },
  )

  it.each(DEMO_PERSONAS.map((persona) => [persona.label, persona] as const))(
    '%s has a scope row, without which they can see nothing',
    (_label, persona) => {
      const membership = rows('memberships').find(
        (row) => row.user_id === persona.userId,
      )
      const scope = rows('membership_scopes').find(
        (row) => row.membership_id === membership?.id,
      )

      expect(scope).toBeDefined()
      // `resolve.ts` reads a missing scope row as "nothing", not "everything".
      expect(scope?.kind).toBeTruthy()
    },
  )

  it('carries a user profile for every member', () => {
    const profiles = ids('user_profiles')
    for (const membership of memberships) {
      expect(profiles.has(membership.user_id)).toBe(true)
    }
  })

  it('seeds the whole role catalogue, so a custom role has a neighbour', () => {
    const seeded = new Set(roles.map((role) => role.code))
    for (const role of SYSTEM_ROLES) expect(seeded.has(role)).toBe(true)
  })

  it('narrows two personas, so switching changes the rows and not only the buttons', () => {
    const narrowed = DEMO_PERSONAS.filter((persona) => {
      const membership = memberships.find(
        (row) => row.user_id === persona.userId,
      )
      const scope = rows('membership_scopes').find(
        (row) => row.membership_id === membership?.id,
      )
      return scope?.kind !== 'all_organization'
    })

    expect(narrowed.length).toBeGreaterThanOrEqual(2)
  })
})

/* ---------------------------------------------------------------- plans -- */

describe('plans', () => {
  it('offers Basic, Direct and Pro', () => {
    expect(DEMO_PLANS.map((plan) => plan.code)).toEqual([
      'basic',
      'direct',
      'pro',
    ])
  })

  it('takes entitlements from the catalogue rather than retyping them', () => {
    for (const plan of DEMO_PLANS) {
      const seed = SEED_PLANS.find((candidate) => candidate.code === plan.code)
      expect(plan.entitlements).toEqual(seed?.entitlements)
    }
  })

  it('has exactly one live subscription, because loadPlan reads one row', () => {
    const live = rows('organization_subscriptions').filter(
      (row) => row.status !== 'cancelled' && row.deleted_at === null,
    )
    expect(live).toHaveLength(1)
  })

  it('points that subscription at a plan the dataset actually holds', () => {
    const subscription = rows('organization_subscriptions')[0]
    expect(ids('plans').has(subscription.plan_id)).toBe(true)
  })
})

/* ------------------------------------------------------------- calendar -- */

describe('the calendar has something true to show', () => {
  const bookings = rows('bookings')

  const asDate = (value: unknown): string => {
    expect(typeof value).toBe('string')
    expect(value as string).toMatch(ISO_DATE)
    return value as string
  }

  it('resolves today from the clock, not from a literal in the file', () => {
    const now = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

    expect(TODAY).toBe(now)
  })

  it('has a stay in progress right now', () => {
    const straddling = bookings.filter(
      (row) =>
        asDate(row.check_in) <= TODAY &&
        asDate(row.check_out) > TODAY &&
        row.status !== 'cancelled',
    )
    expect(straddling.length).toBeGreaterThan(0)
  })

  it('has somebody arriving today and somebody leaving today', () => {
    expect(bookings.some((row) => row.check_in === TODAY)).toBe(true)
    expect(bookings.some((row) => row.check_out === TODAY)).toBe(true)
  })

  it('reaches at least six weeks back and eight weeks forward', () => {
    const checkIns = bookings.map((row) => asDate(row.check_in)).sort()
    const checkOuts = bookings.map((row) => asDate(row.check_out)).sort()

    const dayOffset = (date: string): number =>
      Math.round(
        (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) /
          86_400_000,
      )

    expect(dayOffset(checkIns[0])).toBeLessThanOrEqual(-42)
    expect(dayOffset(checkOuts[checkOuts.length - 1])).toBeGreaterThanOrEqual(
      56,
    )
  })

  it('spreads roughly thirty stays across past, present and future', () => {
    expect(bookings.length).toBeGreaterThanOrEqual(30)

    const past = bookings.filter((row) => (row.check_out as string) < TODAY)
    const future = bookings.filter((row) => (row.check_in as string) > TODAY)

    expect(past.length).toBeGreaterThan(8)
    expect(future.length).toBeGreaterThan(8)
  })

  it('ends every stay after it starts', () => {
    for (const row of bookings) {
      expect(asDate(row.check_out) > asDate(row.check_in)).toBe(true)
    }
  })

  it('never occupies one unit twice over the same night', () => {
    const byUnit = new Map<unknown, { from: string; to: string }[]>()

    for (const row of rows('unit_occupancy')) {
      const during = row.during as string
      const [from, to] = during.slice(1, -1).split(',')
      const list = byUnit.get(row.unit_id) ?? []
      list.push({ from, to })
      byUnit.set(row.unit_id, list)
    }

    // Collected rather than asserted one by one, so a failure names every
    // clash at once instead of stopping at the first.
    const clashes: string[] = []

    for (const [unitId, ranges] of byUnit) {
      const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from))
      for (let index = 1; index < sorted.length; index += 1) {
        // Half-open: one stay may end on the day the next begins, and may not
        // start before it.
        if (sorted[index].from < sorted[index - 1].to) {
          clashes.push(
            `${String(unitId)}: ${sorted[index - 1].from}–${sorted[index - 1].to} ` +
              `overlaps ${sorted[index].from}–${sorted[index].to}`,
          )
        }
      }
    }

    expect(clashes).toEqual([])
  })

  it('releases the room a cancelled stay was holding', () => {
    const cancelled = bookings.filter((row) => row.status === 'cancelled')
    expect(cancelled.length).toBeGreaterThan(0)

    const occupying = new Set(
      rows('unit_occupancy').map((row) => row.booking_id),
    )
    for (const row of cancelled) expect(occupying.has(row.id)).toBe(false)
  })
})

/* ------------------------------------------------------------ integrity -- */

describe('the rows point at each other', () => {
  const check = (
    table: string,
    column: string,
    target: string,
    targetColumn = 'id',
  ) => {
    const valid = ids(target, targetColumn)
    const broken = rows(table)
      .filter((row) => row[column] !== null && row[column] !== undefined)
      .filter((row) => !valid.has(row[column]))
      .map((row) => `${table}.${column}=${String(row[column])}`)
    expect(broken).toEqual([])
  }

  it('keeps every foreign key inside the dataset', () => {
    check('bookings', 'unit_id', 'units')
    check('bookings', 'property_id', 'properties')
    check('bookings', 'guest_id', 'guests')
    check('booking_price_lines', 'booking_id', 'bookings')
    check('booking_status_history', 'booking_id', 'bookings')
    check('unit_occupancy', 'unit_id', 'units')
    check('unit_occupancy', 'hold_id', 'holds')
    check('payments', 'booking_id', 'bookings')
    check('deposits', 'booking_id', 'bookings')
    check('invoices', 'booking_id', 'bookings')
    check('invoice_lines', 'invoice_id', 'invoices')
    check('invoice_payments', 'invoice_id', 'invoices')
    check('invoice_payments', 'payment_id', 'payments')
    check('tasks', 'booking_id', 'bookings')
    check('tasks', 'unit_id', 'units')
    check('tasks', 'team_id', 'teams')
    check('task_assignments', 'task_id', 'tasks')
    check('task_checklists', 'task_id', 'tasks')
    check('inventory_movements', 'item_id', 'inventory_items')
    check('commissions', 'booking_id', 'bookings')
    check('units', 'property_id', 'properties')
    check('memberships', 'organization_id', 'organizations')
    check('membership_roles', 'role_id', 'roles')
    check('agent_organization_settings', 'agency_id', 'agencies')
    check('expense_allocations', 'rule_id', 'expense_rules')
  })

  it('attributes every agent booking to the agent who sold it', () => {
    for (const row of rows('bookings')) {
      if (row.source !== 'agent') continue
      // `bookings_agent_attributed` in the migration, asserted here because a
      // dataset that broke it would be rejected by the real database.
      expect(row.agent_user_id).not.toBeNull()
    }
  })
})

/* --------------------------------------------------------------- money -- */

describe('the money adds up', () => {
  it('makes each booking total the sum of its own price lines', () => {
    const linesByBooking = new Map<unknown, number>()
    for (const line of rows('booking_price_lines')) {
      const total = linesByBooking.get(line.booking_id) ?? 0
      linesByBooking.set(
        line.booking_id,
        total + (line.amount_agorot as number),
      )
    }

    for (const booking of rows('bookings')) {
      expect(booking.total_agorot).toBe(linesByBooking.get(booking.id))
    }
  })

  it('splits every invoice so the total is subtotal plus tax', () => {
    for (const invoice of rows('invoices')) {
      expect(invoice.total_agorot).toBe(
        (invoice.subtotal_agorot as number) + (invoice.tax_agorot as number),
      )
    }
  })

  it('gives an issued invoice a number and a draft none', () => {
    for (const invoice of rows('invoices')) {
      if (invoice.status === 'draft') {
        expect(invoice.number).toBeNull()
        expect(invoice.issued_at).toBeNull()
      } else {
        expect(invoice.number).not.toBeNull()
        expect(invoice.issued_at).not.toBeNull()
      }
    }
  })

  it('dates every payment that claims to have been made', () => {
    const settled = ['paid', 'partially_paid', 'refunded', 'partially_refunded']
    for (const payment of rows('payments')) {
      if (!settled.includes(payment.status as string)) continue
      expect(payment.paid_at).not.toBeNull()
    }
  })

  it('shows more than one payment state, or it shows nothing', () => {
    const states = new Set(rows('payments').map((row) => row.status))
    expect(states.size).toBeGreaterThanOrEqual(3)
  })

  it('never lets somebody approve their own request', () => {
    for (const approval of rows('approvals')) {
      if (approval.decided_by === null) continue
      expect(approval.decided_by).not.toBe(approval.requested_by)
    }
    // And an undecided request carries no decision moment.
    for (const approval of rows('approvals')) {
      const decided = ['approved', 'rejected'].includes(
        approval.status as string,
      )
      expect(approval.decided_at !== null).toBe(decided)
    }
  })
})

/* ---------------------------------------------------------- operations -- */

describe('operations', () => {
  it('gives a blocked or cancelled task the reason its status requires', () => {
    for (const task of rows('tasks')) {
      if (task.status === 'blocked') {
        expect(task.blocked_reason).toBeTruthy()
      }
      if (task.status === 'cancelled') {
        expect(task.cancellation_reason).toBeTruthy()
      }
      if (task.status === 'completed' || task.status === 'verified') {
        expect(task.completed_at).not.toBeNull()
      }
    }
  })

  it('puts every task on a team, which is what a cleaner is scoped to', () => {
    const teams = ids('teams')
    for (const task of rows('tasks')) expect(teams.has(task.team_id)).toBe(true)
  })

  it('keeps reserved stock inside the stock that exists', () => {
    for (const item of rows('inventory_items')) {
      expect(item.quantity_reserved as number).toBeLessThanOrEqual(
        item.quantity as number,
      )
    }
  })
})
