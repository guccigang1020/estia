/**
 * The role catalogue read, over the demo dataset.
 *
 * `catalogue.test.ts` beside this file asserts the derivation. This one
 * asserts the two things that are genuinely rows: the Hebrew names the
 * migrations seeded, and how many memberships hold each role today. Both are
 * the kind of thing a unit test over a pure function cannot check — a renamed
 * column or an undeclared embed only shows up when the query actually runs.
 */

import { describe, expect, it } from 'vitest'

import { PLATFORM_ROLES, SYSTEM_ROLES } from '@/lib/authz/roles'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET } from '@/lib/demo/dataset'
import type { Db } from '@/lib/persistence'

import { listRoles } from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function seeded(table: string): number {
  return DEMO_DATASET.tables[table]?.length ?? 0
}

describe('the role catalogue', () => {
  it('serves every seeded role, including the two platform ones', async () => {
    const roles = await listRoles(client(), ORGANIZATION)

    expect(roles).toHaveLength(seeded('roles'))
    expect(roles).toHaveLength(SYSTEM_ROLES.length + PLATFORM_ROLES.length)

    // Dropping the platform pair would describe a database with twenty rows in
    // a table that has twenty-two.
    expect(roles.filter((role) => role.isPlatform)).toHaveLength(2)
  })

  it('reads the Hebrew name from the row, not from the code', async () => {
    for (const role of await listRoles(client(), ORGANIZATION)) {
      expect(role.name.length).toBeGreaterThan(0)
      expect(role.name).not.toBe(role.code)
      expect(role.description).not.toBeNull()
    }
  })

  it('keeps the catalogue sort order the shell already uses', async () => {
    const orders = (await listRoles(client(), ORGANIZATION)).map(
      (role) => role.sortOrder,
    )
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('counts the memberships holding each role, from the rows themselves', async () => {
    const roles = await listRoles(client(), ORGANIZATION)
    const total = roles.reduce((sum, role) => sum + role.memberCount, 0)

    // Every seeded membership carries exactly one role, so the counts must add
    // up to the roster. A stored counter could disagree with the team screen;
    // counting the rows cannot.
    expect(total).toBe(seeded('membership_roles'))
    expect(total).toBe(seeded('memberships'))
  })

  it('gives every platform role no members inside a customer organization', async () => {
    // `roles_insert` refuses any row carrying `is_platform`, so a customer
    // organization can never assign one — and the count proves the dataset
    // honours that rather than merely intending to.
    const roles = await listRoles(client(), ORGANIZATION)
    for (const role of roles.filter((entry) => entry.isPlatform)) {
      expect(role.memberCount).toBe(0)
    }
  })

  it('marks every seeded role as one whose grants are known', async () => {
    // All twenty-two are `is_system`, so their grants come from the catalogue
    // in code. `grantsKnown` is false only for a customer's own role, whose
    // grants live in `role_permissions` — a table this screen does not read,
    // and which the dataset deliberately seeds empty.
    for (const role of await listRoles(client(), ORGANIZATION)) {
      expect(role.isSystem).toBe(true)
      expect(role.grantsKnown).toBe(true)
    }
    expect(seeded('role_permissions')).toBe(0)
  })
})
