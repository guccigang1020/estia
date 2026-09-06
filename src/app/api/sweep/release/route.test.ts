/**
 * The guard on the endpoint that sends messages with nobody signed in.
 *
 * ══ WHY THESE FOUR TESTS AND NOT A HAPPY PATH ═══════════════════════════════
 *
 * The sweep's own behaviour is tested where it lives: `release.test.ts` in both
 * modules for the decisions, and `release-store.test.ts` in both for the
 * statements. What is left here is the part that has no test anywhere else and
 * the worst consequence if it is wrong — an unauthenticated route that can
 * drain a customer's message queue.
 *
 * So the guard is held to two promises:
 *
 *   1. **Unconfigured refuses.** A deployment that has not set the secret must
 *      not fall back to open. This is the whole reason `refuseSweep` takes the
 *      secret as an argument rather than reading it: a test that had to unset
 *      an environment variable to prove it would be a test of vitest's
 *      isolation, and this one is a test of the branch.
 *   2. **A wrong credential refuses, and says no more than that.** The missing
 *      and the wrong credential answer identically, because telling a stranger
 *      whether the header shape was right is the first thing they would want.
 *
 * `parseSweepOptions` is here too, because the clamp is a safety property: a
 * `limit` from a query string with no ceiling is a request for a pass that
 * never returns.
 *
 * ── Why importing this file needs no environment ──────────────────────────
 *
 * `route.ts` reaches `@/lib/supabase/admin` — and therefore `@/lib/env`, which
 * validates at module load and throws on a missing variable — through a
 * dynamic import INSIDE the handler, after the guard. That is a security
 * property first (a refused request never constructs a service-role client)
 * and is what lets this deliberately database-free suite import the route at
 * all.
 */

import { describe, expect, it } from 'vitest'

import { parseSweepOptions, refuseSweep } from './route'

const SECRET = 'a-long-shared-secret-for-the-scheduler'

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://estia.example/api/sweep/release', {
    method: 'POST',
    headers,
  })
}

describe('refuseSweep', () => {
  it('refuses everything when no secret is configured', async () => {
    for (const secret of [undefined, '', '   ']) {
      const refusal = refuseSweep(
        request({ authorization: `Bearer ${SECRET}` }),
        secret,
      )

      // Not open. A deployment that has not been configured cannot authorise
      // a sweep, and the honest answer is that it will not run at all — even
      // for a caller presenting something that looks like a credential.
      expect(refusal).not.toBeNull()
      expect(refusal?.status).toBe(503)
      expect(await refusal?.json()).toMatchObject({
        ok: false,
        error: 'sweep_not_configured',
      })
    }
  })

  it('refuses a wrong secret', async () => {
    const refusal = refuseSweep(
      request({ authorization: 'Bearer not-the-secret' }),
      SECRET,
    )

    expect(refusal?.status).toBe(401)
    expect(await refusal?.json()).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('refuses a secret that is merely a prefix of the real one', async () => {
    // The comparison hashes both sides to a fixed 32 bytes, so a shorter
    // credential is neither an early exit nor a throw — it is one more wrong
    // answer that costs the same as any other.
    const refusal = refuseSweep(
      request({ authorization: `Bearer ${SECRET.slice(0, 10)}` }),
      SECRET,
    )

    expect(refusal?.status).toBe(401)
  })

  it('refuses a missing or malformed Authorization header, identically', async () => {
    const missing = refuseSweep(request(), SECRET)
    const malformed = refuseSweep(request({ authorization: SECRET }), SECRET)

    expect(missing?.status).toBe(401)
    expect(malformed?.status).toBe(401)
    expect(await missing?.json()).toEqual(await malformed?.json())
  })

  it('lets the right secret through, in either casing of the scheme', () => {
    expect(
      refuseSweep(request({ authorization: `Bearer ${SECRET}` }), SECRET),
    ).toBeNull()
    expect(
      refuseSweep(request({ authorization: `bearer ${SECRET}` }), SECRET),
    ).toBeNull()
  })

  it('never names the variable it wants in a 401', async () => {
    const refusal = refuseSweep(
      request({ authorization: 'Bearer wrong' }),
      SECRET,
    )
    expect(JSON.stringify(await refusal?.json())).not.toContain('SWEEP')
  })
})

describe('parseSweepOptions', () => {
  const url = (query: string) =>
    new URL(`https://estia.example/api/sweep/release${query}`)

  it('bounds a pass when the caller says nothing', () => {
    expect(parseSweepOptions(url(''))).toEqual({
      limit: 100,
      staleAfterMinutes: 720,
      organizationId: null,
    })
  })

  it('takes what the caller asks for, up to the ceiling', () => {
    expect(parseSweepOptions(url('?limit=25')).limit).toBe(25)
    // Unbounded would be a denial of service written as a URL.
    expect(parseSweepOptions(url('?limit=100000')).limit).toBe(500)
  })

  it('falls back rather than refusing the whole pass over a typo', () => {
    // A scheduler is configuration somebody edits once a year. A sweep that
    // refused the pass over a mistyped number would be a sweep that silently
    // stopped running, which is the failure this feature exists to end.
    for (const query of ['?limit=nonsense', '?limit=0', '?limit=-5']) {
      expect(parseSweepOptions(url(query)).limit).toBe(100)
    }
    expect(
      parseSweepOptions(url('?staleAfterMinutes=x')).staleAfterMinutes,
    ).toBe(720)
  })

  it('can be pointed at one tenant', () => {
    expect(parseSweepOptions(url('?organizationId=abc')).organizationId).toBe(
      'abc',
    )
  })
})
