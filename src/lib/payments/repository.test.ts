/**
 * The adapter, over a client that records instead of connecting.
 *
 * Same limitation `fake-client.ts` states plainly: this cannot prove a column
 * name is spelled right — a misspelling would be consistent here and fail on
 * the first real request. What it proves is the half a fake can prove, and it
 * is the half that matters most on these four tables: that every read is
 * filtered by `organization_id`, and that the mapping puts each column where
 * the domain expects it.
 */

import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../persistence/fake-client'

import { SupabasePaymentPolicyRepository } from './repository'

const ORG = 'org-1'

function repositoryWith(responses: Record<string, unknown>) {
  const client = new FakeSupabaseClient({
    responses: responses as never,
  })
  return { client, repo: new SupabasePaymentPolicyRepository(client.asDb()) }
}

describe('reading the organization default', () => {
  it('is scoped by organization, always', async () => {
    const { client, repo } = repositoryWith({
      payment_collection_settings: { data: null },
    })

    await repo.loadSettings(ORG)

    expect(client.queries).toHaveLength(1)
    expect(hasFilter(client.queries[0], 'eq', 'organization_id', ORG)).toBe(
      true,
    )
  })

  it('answers null for a business that never configured one', async () => {
    const { repo } = repositoryWith({
      payment_collection_settings: { data: null },
    })

    // Not a fabricated defaults row. The resolver treats null and the defaults
    // identically, and a screen that wants to know "was this ever set" can
    // still tell.
    expect(await repo.loadSettings(ORG)).toBeNull()
  })

  it('maps every column the resolver reads', async () => {
    const { repo } = repositoryWith({
      payment_collection_settings: {
        data: {
          id: 'settings-1',
          organization_id: ORG,
          policy: 'deposit',
          requirements: ['contract_signed', 'deposit_recorded'],
          deposit_percent_bps: 3000,
          deposit_fixed_agorot: null,
          balance_due_days_before: 14,
          live_payments_enabled: false,
          live_provider: null,
          guest_instructions: 'נא לשלוח אסמכתה',
          version: 3,
        },
      },
    })

    const settings = await repo.loadSettings(ORG)

    expect(settings).toEqual({
      policy: 'deposit',
      requirements: ['contract_signed', 'deposit_recorded'],
      depositPercentBps: 3000,
      depositFixedAgorot: null,
      balanceDueDaysBefore: 14,
      livePaymentsEnabled: false,
      liveProvider: null,
      guestInstructions: 'נא לשלוח אסמכתה',
    })
  })

  it('drops a requirement the frozen contract does not contain', async () => {
    const { repo } = repositoryWith({
      payment_collection_settings: {
        data: {
          id: 'settings-1',
          organization_id: ORG,
          policy: 'custom',
          // A value from a schema that has drifted ahead of this build.
          requirements: ['contract_signed', 'notarised_by_a_rabbi'],
          deposit_percent_bps: null,
          deposit_fixed_agorot: null,
          balance_due_days_before: null,
          live_payments_enabled: false,
          live_provider: null,
          guest_instructions: null,
          version: 1,
        },
      },
    })

    const settings = await repo.loadSettings(ORG)

    // Dropped rather than carried through as a string nothing can render. The
    // requirement it cannot understand is one it will report as absent, which
    // is the safe direction: a screen shows fewer gates, never an unknown one.
    expect(settings?.requirements).toEqual(['contract_signed'])
  })
})

describe('reading a booking override', () => {
  it('is scoped by organization as well as by booking', async () => {
    const { client, repo } = repositoryWith({
      payment_collection_overrides: { data: null },
    })

    await repo.loadOverride(ORG, 'booking-1')

    const query = client.queries[0]
    expect(hasFilter(query, 'eq', 'organization_id', ORG)).toBe(true)
    expect(hasFilter(query, 'eq', 'booking_id', 'booking-1')).toBe(true)
  })

  it('carries the reason and who set it', async () => {
    const { repo } = repositoryWith({
      payment_collection_overrides: {
        data: {
          id: 'override-1',
          organization_id: ORG,
          property_id: 'property-1',
          booking_id: 'booking-1',
          policy: 'none',
          requirements: [],
          deposit_percent_bps: null,
          deposit_fixed_agorot: null,
          balance_due_days_before: null,
          reason: 'לקוח חוזר',
          set_by: 'user-9',
          set_at: '2026-03-01T08:00:00.000Z',
          version: 2,
        },
      },
    })

    const override = await repo.loadOverride(ORG, 'booking-1')

    expect(override?.reason).toBe('לקוח חוזר')
    expect(override?.setByUserId).toBe('user-9')
    expect(override?.version).toBe(2)
  })
})

describe('a proof recorded through PostgREST', () => {
  it('is always written as staff-submitted', async () => {
    const { client, repo } = repositoryWith({
      payment_proofs: {
        data: {
          id: 'proof-1',
          organization_id: ORG,
          property_id: 'property-1',
          booking_id: 'booking-1',
          storage_key: 'proofs/a',
          file_name: 'a.pdf',
          content_type: 'application/pdf',
          byte_size: 100,
          checksum_sha256: null,
          submitted_by_guest: false,
          submitted_by: 'user-1',
          submitted_at: '2026-03-01T08:00:00.000Z',
          note: null,
          review: 'pending',
          reviewed_at: null,
          reviewed_by: null,
          review_note: null,
          payment_id: null,
        },
      },
    })

    await repo.insertProof(
      ORG,
      {
        bookingId: 'booking-1',
        propertyId: 'property-1',
        storageKey: 'proofs/a',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        byteSize: 100,
        checksumSha256: null,
        note: null,
      },
      'user-1',
    )

    const payload = client.queries[0].payload as Record<string, unknown>
    // The policy refuses anything else, and the adapter must not be the thing
    // that tries. A guest's upload has one path and it is not this one.
    expect(payload.submitted_by_guest).toBe(false)
    expect(payload.submitted_by).toBe('user-1')
  })
})

describe('listing the channels', () => {
  it('reads only this organization', async () => {
    const { client, repo } = repositoryWith({
      payment_manual_channels: { data: [] },
    })

    await repo.listChannels(ORG)

    expect(hasFilter(client.queries[0], 'eq', 'organization_id', ORG)).toBe(
      true,
    )
  })
})
