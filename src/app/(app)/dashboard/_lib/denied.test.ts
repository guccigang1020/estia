/**
 * The refusal banner, checked against the routes that actually produce it.
 *
 * The interesting test here is not that a known grant maps to a sentence — it
 * is that the map has not fallen behind the product. Every route gate in the
 * application names a grant and redirects to `/dashboard?denied=<grant>`, so
 * this suite reads those call sites out of the source tree and asserts each
 * one has Hebrew wording. A screen added next month with
 * `requireGrant('review.view')` fails here rather than shipping a monospace
 * `review.view` at the person it refused.
 *
 * The rest of it is the property that matters most and is easiest to lose: no
 * output of `refusalCopy` ever contains a latin letter.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PERMISSIONS, FIELD_PERMISSIONS } from '@/lib/authz/permissions'

import { GRANT_CAPABILITY, refusalCopy } from './denied'

/* ------------------------------------------------------- the call sites -- */

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts')
    ) {
      found.push(path)
    }
  }
  return found
}

/**
 * Every grant a route gate names as a literal.
 *
 * Matches `requireGrant('x')` and the four screen-specific wrappers built on
 * the same redirect — `requireDistributionGrant`, `requireAnyGrant` and
 * friends all end in `/dashboard?denied=`. A gate that computes its grant
 * dynamically is not caught, which is why the fallback in `denied.ts` is a
 * Hebrew sentence rather than the raw value.
 */
function gateGrants(): string[] {
  const pattern = /require[A-Za-z]*Grant\(\s*'([a-z_.]+)'/g
  const grants = new Set<string>()

  for (const file of sourceFiles(APP_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) grants.add(match[1])
  }

  return [...grants].sort()
}

describe('every route gate has Hebrew wording for its refusal', () => {
  const grants = gateGrants()

  it('found the gates at all', () => {
    // A regex that silently stops matching would make this whole suite pass
    // by testing nothing. Twenty is comfortably under the real number and
    // comfortably over zero.
    expect(grants.length).toBeGreaterThan(20)
  })

  it.each(gateGrants().map((grant) => [grant] as const))('%s', (grant) => {
    expect(
      GRANT_CAPABILITY[grant as keyof typeof GRANT_CAPABILITY],
      `${grant} is named by a route gate and has no Hebrew wording in GRANT_CAPABILITY`,
    ).toBeTruthy()
  })
})

/* ------------------------------------------------------------- the copy -- */

const HEBREW = /[֐-׿]/
const LATIN = /[A-Za-z]/

describe('nothing latin reaches the reader', () => {
  it.each(Object.entries(GRANT_CAPABILITY))(
    '%s reads as Hebrew',
    (_grant, label) => {
      expect(label).toMatch(HEBREW)
      expect(label).not.toMatch(LATIN)
    },
  )

  it.each([...PERMISSIONS, ...FIELD_PERMISSIONS].map((g) => [g] as const))(
    'refusing %s produces no code on screen',
    (grant) => {
      for (const reason of [
        'missing_permission',
        'plan_does_not_include',
        'out_of_scope',
        'membership_not_active',
        null,
        'nonsense',
      ]) {
        const copy = refusalCopy(grant, reason)
        expect(copy).not.toBeNull()
        expect(`${copy!.message} ${copy!.remedy}`).not.toMatch(LATIN)
      }
    },
  )

  it('never echoes a hand-edited query parameter back at the reader', () => {
    const copy = refusalCopy('<img src=x onerror=alert(1)>', null)
    expect(copy).not.toBeNull()
    expect(copy!.message).not.toContain('img')
    expect(copy!.message).not.toMatch(LATIN)
  })
})

/* ---------------------------------------------------------- the reasons -- */

describe('the three refusals are three different sentences', () => {
  it('says nothing at all when nothing was refused', () => {
    expect(refusalCopy(null, null)).toBeNull()
    expect(refusalCopy('', 'missing_permission')).toBeNull()
  })

  it('names the capability rather than the permission string', () => {
    const copy = refusalCopy('guest.view', 'missing_permission')
    expect(copy!.message).toContain('כרטיסי האורחים')
    expect(copy!.message).not.toContain('guest')
    expect(copy!.isPlanRefusal).toBe(false)
  })

  it('separates a package refusal from a permission refusal', () => {
    const permission = refusalCopy('agent.view', 'missing_permission')
    const plan = refusalCopy('agent.view', 'plan_does_not_include')

    expect(plan!.isPlanRefusal).toBe(true)
    expect(plan!.message).not.toBe(permission!.message)
    // The remedy is the point of the distinction: one is a role change, the
    // other is an upgrade, and different people perform them.
    expect(plan!.remedy).toContain('שדרוג')
    expect(permission!.remedy).toContain('תפקיד')
  })

  it('separates being out of scope from not holding the right', () => {
    const scope = refusalCopy('booking.view', 'out_of_scope')
    expect(scope!.message).toContain('מחוץ לטווח')
    expect(scope!.isPlanRefusal).toBe(false)
  })

  it('treats an unknown reason as a permission refusal', () => {
    const copy = refusalCopy('task.view', 'something_new')
    expect(copy!.remedy).toContain('תפקיד')
  })
})
