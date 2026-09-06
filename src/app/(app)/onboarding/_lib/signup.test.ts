/**
 * The rule these tests exist for: **a refusal is never retried.**
 *
 * `createWorkspace` has a fallback. That is useful and it is also the most
 * dangerous shape of code in this file, because a fallback that triggers on
 * the wrong error turns "the database said no" into "try again with a
 * credential that bypasses row level security". The guards inside
 * `create_first_workspace` are the ONLY tenant boundary that write has, so
 * going around one of them is going around all of them.
 *
 * So the tests below are mostly about which errors do NOT fall through. Only
 * `PGRST202` and `42883` — the two ways a database says the function is not
 * here — may reach the privileged paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER = '44444444-4444-4444-8444-444444444444'
const ORG = '11111111-1111-4111-8111-111111111111'

type RpcResult = { data: unknown; error: unknown }

const state: {
  rpc: (name: string, args: Record<string, unknown>) => RpcResult
  sessionUserId: string | null
  calls: string[]
} = { rpc: () => ({ data: null, error: null }), sessionUserId: USER, calls: [] }

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: {
          user: state.sessionUserId ? { id: state.sessionUserId } : null,
        },
        error: null,
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push(name)
      return state.rpc(name, args)
    },
  }),
}))

// The privileged paths must be observable without being reachable by accident:
// any test that ends up here has proved the fallback fired when it should not.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    state.calls.push('admin-client')
    throw new Error('the compensated path was taken')
  },
}))

vi.mock('@/lib/persistence', () => ({
  postgresPool: () => {
    state.calls.push('postgres-pool')
    throw new Error('the atomic path was taken')
  },
}))

// `src/lib/env.ts` validates on import, and signup.ts pulls it in. These two
// are the only variables it insists on, and the values are never used: every
// client this file would build is mocked above.
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'publishable-test-key')
vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')

const { SlugTakenError, createWorkspace, isSlugAvailable, strategy } =
  await import('./signup')

const seed = {
  name: 'אחוזת הגליל',
  slug: 'galil',
  businessType: 'villa' as const,
  timezone: 'Asia/Jerusalem',
}

beforeEach(() => {
  state.calls = []
  state.sessionUserId = USER
  state.rpc = () => ({ data: ORG, error: null })
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the path taken', () => {
  it('is the RPC, with no environment variable set at all', async () => {
    expect(strategy()).toBe('rpc')

    const created = await createWorkspace(USER, seed)

    expect(created.organizationId).toBe(ORG)
    expect(state.calls).toEqual(['create_first_workspace'])
  })

  it('reports itself atomic, because one function call is one transaction', async () => {
    const created = await createWorkspace(USER, seed)
    expect(created.atomic).toBe(true)
  })
})

describe('what must never fall through to a privileged path', () => {
  it('a guard that fired — the refusal stands', async () => {
    // `insufficient_privilege` is what the cap and the session check raise.
    state.rpc = () => ({
      data: null,
      error: {
        code: '42501',
        message: 'this account already owns 3 workspaces',
      },
    })

    await expect(createWorkspace(USER, seed)).rejects.toMatchObject({
      code: '42501',
    })
    expect(state.calls).toEqual(['create_first_workspace'])
  })

  it('an unknown timezone', async () => {
    state.rpc = () => ({
      data: null,
      error: { code: '22023', message: 'unknown timezone Asia/Jerusalm' },
    })

    await expect(createWorkspace(USER, seed)).rejects.toMatchObject({
      code: '22023',
    })
    expect(state.calls).not.toContain('admin-client')
    expect(state.calls).not.toContain('postgres-pool')
  })

  it("somebody else's slug, which becomes a field error and not a retry", async () => {
    // The caller's OWN replay is answered inside the function, so a unique
    // violation out here can only mean the slug belongs to another business.
    state.rpc = () => ({ data: null, error: { code: '23505' } })

    await expect(createWorkspace(USER, seed)).rejects.toBeInstanceOf(
      SlugTakenError,
    )
    expect(state.calls).toEqual(['create_first_workspace'])
  })
})

describe('what the caller and the database must agree about', () => {
  it('refuses when the session belongs to somebody else', async () => {
    // The database writes the membership for ITS caller. If that is not the
    // person the screen is talking to, a business would be created for the
    // wrong human — and nothing downstream would notice.
    state.sessionUserId = '99999999-9999-4999-8999-999999999999'

    await expect(createWorkspace(USER, seed)).rejects.toThrow(/session/)
    expect(state.calls).toEqual([])
  })

  it('refuses when there is no session at all', async () => {
    state.sessionUserId = null
    await expect(createWorkspace(USER, seed)).rejects.toThrow(/nobody/)
    expect(state.calls).toEqual([])
  })
})

describe('the slug question', () => {
  it('is asked of the database with no secret', async () => {
    state.rpc = () => ({ data: true, error: null })
    await expect(isSlugAvailable('galil')).resolves.toBe(true)
    expect(state.calls).toEqual(['workspace_slug_available'])
  })

  it('treats anything but an explicit true as taken', async () => {
    state.rpc = () => ({ data: null, error: null })
    await expect(isSlugAvailable('galil')).resolves.toBe(false)
  })
})

describe('the only two errors that mean "the function is not here"', () => {
  it('PGRST202 reaches the fallback, and with nothing configured it refuses', async () => {
    state.rpc = () => ({ data: null, error: { code: 'PGRST202' } })

    await expect(createWorkspace(USER, seed)).rejects.toMatchObject({
      code: 'workspace_creation_unavailable',
    })
  })

  it('42883 does the same', async () => {
    state.rpc = () => ({ data: null, error: { code: '42883' } })

    await expect(createWorkspace(USER, seed)).rejects.toMatchObject({
      code: 'workspace_creation_unavailable',
    })
  })
})
