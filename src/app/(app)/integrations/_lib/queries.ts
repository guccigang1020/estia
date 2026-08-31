/**
 * EXECUTION CONTEXT — SERVER ONLY. Connected services, and what is known.
 *
 * ══ THERE IS NO INTEGRATIONS TABLE, AND THIS FILE DOES NOT PRETEND ═══════
 *
 * Say it plainly, because every other screen in this section reads a table
 * named after itself. `supabase/migrations` declares sixty-odd tables and not
 * one of them is a registry of connections: there is no stored record of "the
 * card processor is connected", no credential, no health check, no last-sync
 * timestamp, and no connect/disconnect state to toggle. A screen that rendered
 * green ticks against a list of logos would be inventing every one of them.
 *
 * What the database *does* carry is the mark each service leaves when it does
 * its work, and those marks are columns:
 *
 *   · `payments.provider` and `payments.provider_payment_id` — who took the
 *     money and what they called the transaction. `0010_payments.sql` indexes
 *     the pair precisely so reconciliation can ask the processor about a
 *     specific charge.
 *   · `invoices.provider` and `invoices.provider_invoice_id` — who issued the
 *     document that the tax authority will see.
 *   · `bookings.source` and `bookings.source_channel` — which channel sold the
 *     stay. Recorded on every booking since the first migration, because a
 *     commission dispute against a table that does not know who sold it cannot
 *     be settled.
 *
 * So this screen reports observed traffic, and labels it as observed traffic.
 * "Cardcom has taken fifty-three payments, the most recent one on Tuesday" is
 * a fact this database can support. "Cardcom is connected" is not, and the
 * difference matters to exactly the person who reads this screen first.
 *
 * That gap is a finding about the product, not a limitation of the screen.
 * Until an `integrations` table exists there is nothing to configure here, and
 * `integration.manage` — which the route is gated on, and which
 * `SENSITIVE_ACTIONS` marks — currently governs no write path at all.
 *
 * ── Why each read is guarded by a grant ───────────────────────────────────
 *
 * `integration.manage` says nothing about payments, invoices or bookings, and
 * the policies on those tables have never heard of it. A reader holding it
 * without `payment.view` gets nothing from `payments_select` — so the query is
 * not issued, and the section says "you may not read payments" rather than
 * "no payment provider has ever been used". Collapsing those two would tell an
 * owner their processor was never connected because of their own permissions.
 * Same reasoning, and the same `holdsGrant` shape, as `bookingReferences` in
 * the finance queries.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Db } from '@/lib/persistence'
import {
  asString,
  asStringOrNull,
  asTimestampOrNull,
  toRows,
  type Row,
} from '@/lib/persistence'

/* ---------------------------------------------------------------- shape -- */

export type IntegrationKind =
  'payment_provider' | 'invoice_provider' | 'booking_channel'

/**
 * One service, described by the traffic it left behind.
 *
 * `lastSeenAt` is null when the service has rows but none of them carried a
 * usable timestamp — a real possibility and a different statement from "never
 * used", which is the absence of the record altogether.
 */
export type IntegrationRecord = {
  kind: IntegrationKind
  /** The stored value: `cardcom`, `greeninvoice`, `booking_com`. */
  id: string
  /** How many rows in this organization name it. */
  rowCount: number
  lastSeenAt: string | null
  /**
   * Rows this service left in a state a person has to resolve.
   *
   * Only meaningful for the payment processor, where `unknown` means the
   * provider stopped answering and the card may or may not have been charged.
   * Zero everywhere else, and the screen does not print a health figure it
   * cannot derive.
   */
  needsAttentionCount: number
}

/**
 * A section of the screen: one class of service, or the reason it is unknown.
 *
 * `unreadable` is not an error. It is the honest answer for a reader who holds
 * `integration.manage` and not the grant the underlying table requires, and it
 * carries the grant that was missing so the screen can name it.
 */
export type IntegrationSection =
  | {
      kind: IntegrationKind
      state: 'read'
      records: readonly IntegrationRecord[]
    }
  | { kind: IntegrationKind; state: 'unreadable'; missing: Grant }

export type IntegrationsReport = {
  sections: readonly IntegrationSection[]
  /**
   * True when nothing at all could be read — every section is `unreadable`.
   * The screen says so once rather than three times.
   */
  nothingReadable: boolean
}

export type LoadIntegrationsArgs = {
  db: Db
  actor: Actor
  organizationId: string
}

/**
 * What this organization's rows say about the services it uses.
 *
 * Three independent reads, run together. None of them is a join: the three
 * tables have nothing to join on — a payment provider and a booking channel
 * are unrelated facts about the same business — and pretending otherwise would
 * invent a relationship the schema does not model.
 */
export async function loadIntegrations(
  args: LoadIntegrationsArgs,
): Promise<IntegrationsReport> {
  const { db, actor, organizationId } = args

  const [payments, invoices, channels] = await Promise.all([
    paymentProviders(db, actor, organizationId),
    invoiceProviders(db, actor, organizationId),
    bookingChannels(db, actor, organizationId),
  ])

  const sections = [payments, invoices, channels]

  return {
    sections,
    nothingReadable: sections.every(
      (section) => section.state === 'unreadable',
    ),
  }
}

/** Every service across every section, for a count above the fold. */
export function allRecords(
  report: IntegrationsReport,
): readonly IntegrationRecord[] {
  return report.sections.flatMap((section) =>
    section.state === 'read' ? section.records : [],
  )
}

/* --------------------------------------------------------------- readers -- */

/**
 * Who took the money, and how much of it is unresolved.
 *
 * `status = 'unknown'` and a non-null `requires_attention` are counted
 * together, because they are the same sentence to whoever reads this: the
 * automation stopped and will not start again on its own. That is the only
 * health signal this database can actually produce about a processor, and it
 * is a real one — `payment_attempts` exists precisely so an unknown outcome is
 * recoverable rather than guessed at.
 */
async function paymentProviders(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<IntegrationSection> {
  if (!holdsGrant(actor, 'payment.view')) {
    return {
      kind: 'payment_provider',
      state: 'unreadable',
      missing: 'payment.view',
    }
  }

  const { data, error } = await db
    .from('payments')
    .select('provider, status, requires_attention, created_at')
    .eq('organization_id', organizationId)

  if (error) throw error

  return {
    kind: 'payment_provider',
    state: 'read',
    records: tally(
      'payment_provider',
      toRows(data),
      'provider',
      'created_at',
      (row) =>
        asString(row, 'status') === 'unknown' ||
        asStringOrNull(row, 'requires_attention') !== null,
    ),
  }
}

/** Who issued the documents. */
async function invoiceProviders(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<IntegrationSection> {
  if (!holdsGrant(actor, 'invoice.view')) {
    return {
      kind: 'invoice_provider',
      state: 'unreadable',
      missing: 'invoice.view',
    }
  }

  const { data, error } = await db
    .from('invoices')
    .select('provider, provider_invoice_id, created_at')
    .eq('organization_id', organizationId)

  if (error) throw error

  return {
    kind: 'invoice_provider',
    state: 'read',
    // A document with a provider and no `provider_invoice_id` was never
    // successfully filed with them — the one attention signal this table
    // supports, and it is a column rather than a guess.
    records: tally(
      'invoice_provider',
      toRows(data),
      'provider',
      'created_at',
      (row) => asStringOrNull(row, 'provider_invoice_id') === null,
    ),
  }
}

/**
 * Which channels sold the stays.
 *
 * Grouped by `source` rather than by `source_channel`: the enum is the
 * constrained column and the free-text channel beside it is a detail of one
 * source. `direct_manual` — the telephone and the front desk — is deliberately
 * included, because "most of our bookings did not come through any channel at
 * all" is the single most useful thing this section can tell an owner
 * considering what to pay for.
 */
async function bookingChannels(
  db: Db,
  actor: Actor,
  organizationId: string,
): Promise<IntegrationSection> {
  if (!holdsGrant(actor, 'booking.view')) {
    return {
      kind: 'booking_channel',
      state: 'unreadable',
      missing: 'booking.view',
    }
  }

  const { data, error } = await db
    .from('bookings')
    .select('source, source_channel, created_at')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)

  if (error) throw error

  return {
    kind: 'booking_channel',
    state: 'read',
    records: tally(
      'booking_channel',
      toRows(data),
      'source',
      'created_at',
      () => false,
    ),
  }
}

/* ------------------------------------------------------------ internals -- */

/**
 * Group rows by a column, counting them and keeping the latest timestamp.
 *
 * Rows whose grouping column is null are dropped rather than gathered under a
 * heading: a cash payment has no provider, and "null took eleven payments" is
 * not a service. The absence is the correct answer — a payment taken at the
 * front desk was not taken by an integration.
 *
 * Sorted by volume, because the question this screen answers is which services
 * the business actually depends on, and an alphabetical list buries that.
 */
function tally(
  kind: IntegrationKind,
  rows: readonly Row[],
  column: string,
  timestampColumn: string,
  needsAttention: (row: Row) => boolean,
): readonly IntegrationRecord[] {
  const totals = new Map<
    string,
    { rowCount: number; lastSeenAt: string | null; needsAttentionCount: number }
  >()

  for (const row of rows) {
    const key = asStringOrNull(row, column)
    if (key === null) continue

    const entry = totals.get(key) ?? {
      rowCount: 0,
      lastSeenAt: null,
      needsAttentionCount: 0,
    }
    entry.rowCount += 1
    if (needsAttention(row)) entry.needsAttentionCount += 1

    const seen = asTimestampOrNull(row, timestampColumn)
    if (
      seen !== null &&
      (entry.lastSeenAt === null || seen > entry.lastSeenAt)
    ) {
      entry.lastSeenAt = seen
    }

    totals.set(key, entry)
  }

  return [...totals]
    .map(([id, entry]) => ({ kind, id, ...entry }))
    .sort((a, b) => b.rowCount - a.rowCount)
}
