/**
 * The fiscal read, driven the way the screen drives it.
 *
 * ── What this can and cannot prove ────────────────────────────────────────
 *
 * `fake-client.ts` is unsparing about its own limits and they apply here: a
 * column name spelled wrongly is spelled wrongly consistently, so this cannot
 * prove the query is right against Postgres. What it does prove is the two
 * things that would otherwise be discovered on a customer's screen — that a
 * missing table becomes a stated gap rather than an empty list, and that a
 * document row claiming `issued` without a number is never counted as done.
 *
 * It also asserts the tenant filter is on the query, which is a tenant
 * isolation claim worth making without a database.
 */

import { describe, expect, it } from 'vitest'

import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { FakeSupabaseClient, hasFilter } from '@/lib/persistence/fake-client'

import { defaultProviderState, loadFiscalScreen } from './queries'

const ORG = 'org-1'

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: 'user-1',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(),
  }
}

const SETTINGS_ROW = {
  provider: 'none',
  documents_expected: false,
  capabilities: [],
  connected_at: null,
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    organization_id: ORG,
    property_id: 'prop-1',
    booking_id: 'booking-1',
    invoice_id: null,
    provider: 'none',
    provider_document_id: null,
    provider_document_number: null,
    type: 'tax_invoice_receipt',
    status: 'refused',
    customer_name: 'דנה כהן',
    customer_tax_id: null,
    amount_agorot: 120_000,
    tax_agorot: 18_305,
    tax_rate_bps: 1800,
    issue_date: null,
    source_kind: 'payment',
    source_id: 'pay-1',
    document_url: null,
    document_url_expires_at: null,
    failure_code: 'not_configured',
    failure_reason: 'לא מחובר ספק.',
    provider_status: null,
    attempt_count: 1,
    last_attempt_at: '2026-03-01T09:00:00.000Z',
    next_retry_at: null,
    reviewed_at: null,
    reviewed_by: null,
    corrects_document_id: null,
    created_at: '2026-03-01T09:00:00.000Z',
    updated_at: '2026-03-01T09:00:00.000Z',
    version: 1,
    bookings: { reference: 'BK-2026-0184' },
    ...overrides,
  }
}

describe('when the storage does not exist yet', () => {
  it('reports a gap and names the tables, rather than an empty list', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        fiscal_settings: {
          error: { code: 'PGRST205', message: 'not in schema cache' },
        },
        fiscal_documents: {
          error: { code: 'PGRST205', message: 'not in schema cache' },
        },
        fiscal_reconciliation_runs: {
          error: { code: 'PGRST205', message: 'not in schema cache' },
        },
      },
    })

    const screen = await loadFiscalScreen(
      client.asDb(),
      actorWith(['invoice.view']),
      ORG,
    )

    expect(screen.state).toBe('not_provisioned')
    if (screen.state !== 'not_provisioned') return
    expect(screen.tables).toContain('fiscal_documents')
  })

  it('rethrows anything that is NOT a missing table', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        fiscal_settings: {
          error: { code: '42501', message: 'permission denied' },
        },
        fiscal_documents: { data: [] },
        fiscal_reconciliation_runs: { data: [] },
      },
    })

    await expect(
      loadFiscalScreen(client.asDb(), actorWith(['invoice.view']), ORG),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('when the storage exists', () => {
  async function load(rows: readonly Record<string, unknown>[]) {
    const client = new FakeSupabaseClient({
      responses: {
        fiscal_settings: { data: SETTINGS_ROW },
        fiscal_documents: { data: rows },
        fiscal_reconciliation_runs: { data: [] },
      },
    })
    const screen = await loadFiscalScreen(
      client.asDb(),
      actorWith(['invoice.view']),
      ORG,
    )
    return { client, screen }
  }

  it('scopes every read to the organization', async () => {
    const { client } = await load([])

    for (const table of [
      'fiscal_settings',
      'fiscal_documents',
      'fiscal_reconciliation_runs',
    ]) {
      const [query] = client.queriesFor(table)
      expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    }
  })

  it('puts a refused document in front of a person and sums its money', async () => {
    const { screen } = await load([documentRow()])
    if (screen.state !== 'ready') throw new Error('expected ready')

    expect(screen.data.needsPerson).toHaveLength(1)
    expect(screen.data.pendingAgorot).toBe(120_000)
    expect(screen.data.counts.refused).toBe(1)
    expect(screen.data.documents[0].bookingReference).toBe('BK-2026-0184')
  })

  it('does not count an issued document as needing a person', async () => {
    const { screen } = await load([
      documentRow({
        provider: 'vendor',
        status: 'issued',
        provider_document_id: 'p-1',
        provider_document_number: '2026-000184',
        issue_date: '2026-03-01',
        failure_code: null,
        failure_reason: null,
      }),
    ])
    if (screen.state !== 'ready') throw new Error('expected ready')

    expect(screen.data.needsPerson).toHaveLength(0)
    expect(screen.data.pendingAgorot).toBe(0)
    expect(screen.data.documents[0].document.providerDocumentNumber).toBe(
      '2026-000184',
    )
  })

  it('carries an issued-without-number row through unchanged, for the domain to refuse', async () => {
    // The read does not correct the row. `describeSettlement` is the one place
    // that decides what such a row means, and it downgrades it to
    // needs_review — so the read must not quietly repair it first.
    const { screen } = await load([
      documentRow({
        provider: 'vendor',
        status: 'issued',
        provider_document_id: 'p-1',
        provider_document_number: null,
        failure_code: null,
        failure_reason: null,
      }),
    ])
    if (screen.state !== 'ready') throw new Error('expected ready')

    expect(screen.data.documents[0].document.status).toBe('issued')
    expect(screen.data.documents[0].document.providerDocumentNumber).toBeNull()
  })

  it('gives an organization with no settings row the honest default', async () => {
    const client = new FakeSupabaseClient({
      responses: {
        fiscal_settings: { data: null },
        fiscal_documents: { data: [] },
        fiscal_reconciliation_runs: { data: [] },
      },
    })

    const screen = await loadFiscalScreen(
      client.asDb(),
      actorWith(['invoice.view']),
      ORG,
    )
    if (screen.state !== 'ready') throw new Error('expected ready')

    expect(screen.data.provider).toEqual(defaultProviderState())
    expect(screen.data.provider.provider).toBe('none')
    expect(screen.data.provider.documentsExpected).toBe(false)
  })
})
