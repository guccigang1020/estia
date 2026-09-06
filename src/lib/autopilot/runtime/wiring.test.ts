/**
 * The composition root, with the Supabase client replaced and nothing else.
 *
 * The claim under test is the uncomfortable one: with `DATABASE_URL` unset the
 * writes are NOT one transaction, and the wiring says so rather than pretending
 * otherwise. `atomic: false` is what a caller reads; the warning is what a
 * person reads. Both are asserted, because a fallback nobody is told about is
 * indistinguishable from a guarantee that is being quietly broken.
 *
 * `createClient` is mocked so the suite stays database-free and never loads
 * `@/lib/env`, which validates at module load and would demand three secrets.
 * Everything else — the persistence layer, the registry, the handler map — is
 * the real thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabaseClient } from '../../persistence/fake-client'
import type { Actor } from '../../authz/can'
import { PERMISSIONS, type Grant } from '../../authz/permissions'
import { ENTITLEMENTS } from '../../plans/entitlements'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => new FakeSupabaseClient().asDb(),
}))

const ORG = '11111111-1111-4111-8111-111111111111'
const OWNER = '44444444-4444-4444-8444-444444444444'

function actor(): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(PERMISSIONS),
    scope: { kind: 'all_organization' },
    entitlements: new Set(ENTITLEMENTS),
  }
}

let databaseUrl: string | undefined

beforeEach(() => {
  databaseUrl = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  vi.resetModules()
})

afterEach(() => {
  if (databaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = databaseUrl
  vi.restoreAllMocks()
})

describe('the unit of work', () => {
  it('reports the sequential fallback rather than hiding it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { autopilotWiring } = await import('./wiring')

    const wiring = await autopilotWiring({
      actor: actor(),
      correlationId: 'pass-1',
    })

    expect(wiring.atomic).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('DATABASE_URL')
  })

  it('warns once per process rather than once per pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { autopilotWiring } = await import('./wiring')

    await autopilotWiring({ actor: actor(), correlationId: 'pass-1' })
    await autopilotWiring({ actor: actor(), correlationId: 'pass-2' })

    // A message per action would train everybody to scroll past it.
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('what the wiring hands the executor', () => {
  it('builds a registry over the real handler map', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { autopilotWiring } = await import('./wiring')

    const wiring = await autopilotWiring({
      actor: actor(),
      correlationId: 'pass-1',
    })

    expect(wiring.execution.registry.resolve('tasks.assignTask').status).toBe(
      'available',
    )
    // Unwired for want of a port, and honestly reported as such rather than
    // resolving to something that returns success.
    expect(
      wiring.execution.registry.resolve('payments.requestPayment').status,
    ).toBe('unavailable')
  })

  it('is built per call, so one session is never two callers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { autopilotWiring } = await import('./wiring')

    const first = await autopilotWiring({
      actor: actor(),
      correlationId: 'pass-1',
    })
    const second = await autopilotWiring({
      actor: actor(),
      correlationId: 'pass-2',
    })

    expect(first.db).not.toBe(second.db)
    expect(first.execution.repository).not.toBe(second.execution.repository)
  })
})
