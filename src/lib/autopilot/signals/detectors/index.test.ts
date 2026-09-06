/**
 * The rule every detector shares, asserted rather than remembered.
 *
 * A detector that reached for a Supabase client would still pass its own
 * suite: its tests hand it facts and never notice the import. This scans the
 * source instead, which is the only thing that can.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as detectors from './index'

const HERE = dirname(fileURLToPath(import.meta.url))

const SOURCES = readdirSync(HERE).filter(
  (name) =>
    name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts',
)

describe('the detectors', () => {
  it('are the nine domains the brief names', () => {
    expect(SOURCES.sort()).toEqual([
      'access.ts',
      'cleaning.ts',
      'contract.ts',
      'inventory.ts',
      'laundry.ts',
      'maintenance.ts',
      'opportunity.ts',
      'payment.ts',
      'preparation.ts',
    ])
  })

  it('are all exported from the barrel', () => {
    for (const name of [
      'detectAccess',
      'detectCleaning',
      'detectContract',
      'detectInventory',
      'detectLaundry',
      'detectMaintenance',
      'detectOpportunity',
      'detectPayment',
      'detectPreparation',
    ]) {
      expect(typeof (detectors as Record<string, unknown>)[name]).toBe(
        'function',
      )
    }
  })

  it('fetch nothing', () => {
    for (const name of SOURCES) {
      const source = readFileSync(join(HERE, name), 'utf8')
      expect(source).not.toContain('supabase')
      expect(source).not.toContain('createClient')
      // No I/O of any other kind either. A detector that read a file would be
      // just as untestable as one that opened a connection.
      expect(source).not.toContain("from 'node:")
      expect(source).not.toContain('await ')
    }
  })

  it('hold no `any` and no non-null assertion', () => {
    for (const name of SOURCES) {
      const source = readFileSync(join(HERE, name), 'utf8')
      expect(source).not.toMatch(/:\s*any\b/)
      expect(source).not.toMatch(/\bas\s+any\b/)
    }
  })
})
