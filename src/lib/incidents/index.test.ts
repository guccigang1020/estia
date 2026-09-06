/**
 * What the barrel promises, checked rather than trusted.
 *
 * Two claims, and the first has taken this product down three times in one day
 * for three different workers:
 *
 *   1. **The barrel is safe for a Client Component.** It must not re-export
 *      `repository.ts` (which reaches the `postgres` driver) or
 *      `operations.ts` (which imports the repository). `scripts/
 *      client-bundle.mjs` walks the real import graph and is the enforcement;
 *      this is the cheap check that fails in the suite rather than in a build.
 *
 *   2. **No door out of this module takes money.** Applying a deposit is
 *      `money_access_cancellation` and belongs to `src/lib/payments`.
 */

import { describe, expect, it } from 'vitest'

import * as incidents from './index'

describe('the barrel', () => {
  it('exports the domain and none of the persistence', () => {
    const names = Object.keys(incidents)

    expect(names).toContain('checkTransition')
    expect(names).toContain('evaluateLiability')
    expect(names).toContain('compareInspections')
    expect(names).toContain('checkEvidence')

    // The two files that reach Postgres, by every name they export.
    for (const forbidden of [
      'SupabaseIncidentRepository',
      'InMemoryIncidentRepository',
      'readIncidents',
      'INCIDENT_TABLES',
      'defineIncidentOperations',
      'defineOpenCase',
      'defineDecideLiability',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('offers no way to move money', () => {
    for (const name of Object.keys(incidents)) {
      expect(name).not.toMatch(/^(capture|charge|collect|refund|takePayment)/i)
    }
  })

  it('offers no way to derive a verdict from a comparison', () => {
    // The rule, stated as an absence. A function named `inferLiability` would
    // be the bypass; there is nothing here that could be mistaken for one.
    for (const name of Object.keys(incidents)) {
      expect(name).not.toMatch(/^(infer|autoDecide|liabilityFrom|decideFrom)/)
    }
  })

  it('re-exports no frozen contract under a second name', () => {
    // `Agorot`, `Grant` and `DomainEventName` belong to other modules. A second
    // import path for a frozen contract is how two modules come to believe
    // they are reading different vocabularies.
    const names = Object.keys(incidents)
    expect(names).not.toContain('DOMAIN_EVENTS')
    expect(names).not.toContain('PERMISSIONS')
    expect(names).not.toContain('TASK_STATUSES')
  })
})
