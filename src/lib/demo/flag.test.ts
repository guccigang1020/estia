/**
 * A switch that replaces the database and the signed-in person is a switch
 * worth being pedantic about. Every value that is not deliberately the demo has
 * to mean production, because the failure in that direction is a deployment
 * quietly serving fixtures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDemoMode } from './flag'

const original = process.env.NEXT_PUBLIC_ESTIA_DEMO

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_ESTIA_DEMO
  else process.env.NEXT_PUBLIC_ESTIA_DEMO = original
})

describe('isDemoMode', () => {
  it('is off when the variable is absent', () => {
    delete process.env.NEXT_PUBLIC_ESTIA_DEMO
    expect(isDemoMode()).toBe(false)
  })

  it('is on for exactly "1"', () => {
    process.env.NEXT_PUBLIC_ESTIA_DEMO = '1'
    expect(isDemoMode()).toBe(true)
  })

  it.each(['0', 'false', 'no', 'true', 'yes', ''])(
    'is off for %j, which a truthiness check would get wrong',
    (value) => {
      // `'0'` and `'false'` are what somebody writes when they mean "off", and
      // both are truthy strings. `'true'` and `'yes'` are the other half of the
      // same mistake: they read as on and are not, which is the safe direction.
      process.env.NEXT_PUBLIC_ESTIA_DEMO = value
      expect(isDemoMode()).toBe(false)
    },
  )
})

/**
 * The demo takes down the authentication wall — `proxy.ts` returns early when
 * it is on. On a laptop that is the point; on a deployment it is the whole
 * product served to anyone who knows the URL, with no runtime moment at which
 * somebody notices. So a production build has to be told twice.
 *
 * `NODE_ENV` is readonly under this tsconfig, and rightly so: production is not
 * a thing a module should be able to reassign at runtime. `vi.stubEnv` is the
 * sanctioned way to ask "what would this do in a production build?", and it
 * lifts every stub together afterwards.
 */
describe('isDemoMode in a production build', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses the demo on one variable alone', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO', '1')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION', undefined)

    // A stray value in a hosting provider's environment is not consent.
    expect(isDemoMode()).toBe(false)
  })

  it('allows a deliberately hosted showroom when told twice', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO', '1')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION', '1')

    expect(isDemoMode()).toBe(true)
  })

  it('never turns the demo on from the second variable by itself', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO', undefined)
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION', '1')

    expect(isDemoMode()).toBe(false)
  })

  it.each(['0', 'false', 'true', ''])(
    'refuses production for the permission value %j',
    (value) => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO', '1')
      vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION', value)

      expect(isDemoMode()).toBe(false)
    },
  )

  it('leaves development alone: one variable is still enough', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO', '1')
    vi.stubEnv('NEXT_PUBLIC_ESTIA_DEMO_ALLOW_PRODUCTION', undefined)

    expect(isDemoMode()).toBe(true)
  })
})
