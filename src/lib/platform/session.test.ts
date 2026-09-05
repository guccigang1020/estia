import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeSupabaseClient } from '@/lib/persistence/fake-client'

import { resolvePlatformSession } from './session'

/**
 * The resolver fails closed, and this is where that is proven rather than
 * asserted in a comment.
 *
 * Four ways it can fail — not on the roster, revoked, the read refused, the
 * table absent — and all four must produce `null`, because `null` is what the
 * guard refuses. The last one is not hypothetical: 0041 has to be applied, and
 * until it is, this query raises. A resolver that treated a failed read as
 * anything but "no session" would open the console during exactly the window
 * in which the database cannot enforce anything about it.
 */

const USER_ID = '22222222-2222-4222-8222-222222222222'

function client(responses: Record<string, unknown>) {
  return new FakeSupabaseClient({ responses: responses as never }).asDb()
}

beforeEach(() => {
  // The resolver logs every refusal on purpose — "nobody is on the roster" and
  // "the roster could not be read" look identical from the browser and must
  // not from the operations desk. Silenced here so the suite stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolvePlatformSession', () => {
  it('returns null when the person is not on the roster', async () => {
    const db = client({ platform_staff: { data: null } })
    expect(await resolvePlatformSession(db, USER_ID)).toBeNull()
  })

  it('returns null when the read is refused', async () => {
    const db = client({
      platform_staff: {
        error: { code: '42501', message: 'permission denied for table' },
      },
    })

    expect(await resolvePlatformSession(db, USER_ID)).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })

  it('returns null when the table does not exist in this deployment', async () => {
    // The fake raises for an unseeded table, which is exactly what happens
    // before 0041 is applied and exactly what the in-memory demo database does
    // for a table its dataset does not carry.
    const db = client({})
    expect(await resolvePlatformSession(db, USER_ID)).toBeNull()
  })

  it('filters the query to an ACTIVE roster row', async () => {
    const fake = new FakeSupabaseClient({
      responses: { platform_staff: { data: null } },
    })

    await resolvePlatformSession(fake.asDb(), USER_ID)

    const [query] = fake.queriesFor('platform_staff')
    // A revoked colleague is refused by the query itself rather than by a
    // check further down that somebody could forget to write.
    expect(query.filters).toContainEqual({
      op: 'eq',
      column: 'status',
      value: 'active',
    })
    expect(query.filters).toContainEqual({
      op: 'eq',
      column: 'user_id',
      value: USER_ID,
    })
  })

  it('returns null when the row names a role that is not a platform role', async () => {
    // `tg_platform_staff_role_is_platform` should make this impossible. It is
    // still refused here, because "impossible" plus "unchecked" is how a
    // customer role would have handed its holder every grant it carries.
    const db = client({
      platform_staff: {
        data: {
          id: 'staff-1',
          user_id: USER_ID,
          role_id: 'role-1',
          roles: { code: 'organization_owner', name: 'בעלים' },
        },
      },
    })

    expect(await resolvePlatformSession(db, USER_ID)).toBeNull()
  })

  it('builds a session, narrowed to platform grants', async () => {
    const db = client({
      platform_staff: {
        data: {
          id: 'staff-1',
          user_id: USER_ID,
          role_id: 'role-1',
          roles: { code: 'platform_super_admin', name: 'מנהל-על ESTIA' },
        },
      },
      role_permissions: {
        data: [
          { permission_code: 'platform.organization.view' },
          { permission_code: 'platform.organization.manage' },
          // Cannot be stored — two triggers refuse it — and is dropped anyway.
          { permission_code: 'booking.delete' },
        ],
      },
      user_profiles: { data: { full_name: 'דנה כהן' } },
    })

    const session = await resolvePlatformSession(db, USER_ID)

    expect(session).not.toBeNull()
    expect(session?.role).toBe('platform_super_admin')
    expect(session?.displayName).toBe('דנה כהן')
    expect([...(session?.grants ?? [])].sort()).toEqual([
      'platform.organization.manage',
      'platform.organization.view',
    ])
  })

  it('falls back to the role name rather than inventing a person', async () => {
    const db = client({
      platform_staff: {
        data: {
          id: 'staff-1',
          user_id: USER_ID,
          role_id: 'role-1',
          roles: { code: 'platform_support', name: 'תמיכת ESTIA' },
        },
      },
      role_permissions: {
        data: [{ permission_code: 'platform.organization.view' }],
      },
      // No profile row. A colleague who has not filled one in is not an error,
      // and the audit label must not be guessed.
      user_profiles: { data: null },
    })

    const session = await resolvePlatformSession(db, USER_ID)
    expect(session?.displayName).toBeNull()
    expect(session?.roleName).toBe('תמיכת ESTIA')
  })

  it('produces an empty grant set when the role carries nothing', async () => {
    const db = client({
      platform_staff: {
        data: {
          id: 'staff-1',
          user_id: USER_ID,
          role_id: 'role-1',
          roles: { code: 'platform_support', name: 'תמיכת ESTIA' },
        },
      },
      role_permissions: {
        error: { code: '42501', message: 'permission denied' },
      },
      user_profiles: { data: null },
    })

    // A session with no grants is refused by every guarded route, which is the
    // right outcome for a roster row whose grants could not be read.
    const session = await resolvePlatformSession(db, USER_ID)
    expect(session?.grants.size).toBe(0)
  })
})
