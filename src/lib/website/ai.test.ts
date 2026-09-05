/**
 * THE AI PORT REFUSES HONESTLY, AND EVERYTHING ELSE WORKS WITHOUT IT.
 *
 * There is no model client in this codebase. What this file asserts is that
 * the absence is handled as a designed outcome rather than as a failure: the
 * null generator returns a `refused` VALUE, never throws, never waits, and
 * names itself so a request row written today is distinguishable from one
 * written after somebody wires a provider.
 *
 * It also asserts the two refusals that are NOT about configuration — no facts
 * and nothing asked for — because those are the sentences a real generator
 * would give for the same input, and wiring a provider must not change the
 * meaning of an existing message.
 */

import { describe, expect, it } from 'vitest'

import {
  fixedContentGenerator,
  nullContentGenerator,
  type GenerationRequest,
} from './ai'
import { authoredClaim, groundDraft } from './facts'

const USER = '22222222-2222-4222-8222-222222222222'

const fact = authoredClaim({
  key: 'property.name',
  text: 'אחוזת הגליל',
  authorUserId: USER,
})!

function request(
  overrides: Partial<GenerationRequest> = {},
): GenerationRequest {
  return {
    brief: {
      organizationId: 'org-1',
      siteId: 'site-1',
      pageKind: 'home',
      sectionKind: 'hero',
      wantedKeys: ['heading', 'subheading'],
      instruction: null,
      tone: 'warm',
      locale: 'he',
    },
    facts: [fact],
    ...overrides,
  }
}

describe('the null generator', () => {
  it('names itself `none`, so today is distinguishable from later', () => {
    expect(nullContentGenerator.provider).toBe('none')
  })

  it('refuses as a VALUE and never throws', async () => {
    const outcome = await nullContentGenerator.generate(request())

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.provider).toBe('none')
    // Hebrew, and it says what a person can do instead.
    expect(outcome.reason).toContain('אינה מוגדרת')
    expect(outcome.reason).toContain('ידנית')
  })

  it('gives a DIFFERENT refusal when there is nothing to write about', async () => {
    // The sentence a real generator would give for the same input. Wiring a
    // provider must not change the meaning of a message somebody has already
    // seen, which is why this branch exists in the null implementation.
    const outcome = await nullContentGenerator.generate(request({ facts: [] }))

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.reason).toContain('שייכו את המקטע')
    expect(outcome.reason).not.toContain('אינה מוגדרת')
  })

  it('refuses when nothing was asked for', async () => {
    const outcome = await nullContentGenerator.generate(
      request({
        brief: { ...request().brief, wantedKeys: [] },
      }),
    )

    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.reason).toContain('לא צוין מה לנסח')
  })
})

describe('a generator that does answer', () => {
  it('still cannot manufacture provenance', async () => {
    // The port returns drafts. Only `groundDraft` turns one into a claim, and
    // it checks the citations against the facts that were actually offered —
    // so a provider is one function and its blast radius is bounded.
    const generator = fixedContentGenerator([
      {
        key: 'heading',
        text: 'אחוזת הגליל',
        citesFactKeys: ['property.name'],
      },
      {
        key: 'subheading',
        text: 'עם בריכה מחוממת',
        citesFactKeys: ['property.heated_pool'],
      },
    ])

    const outcome = await generator.generate(request())
    expect(outcome.status).toBe('drafted')
    if (outcome.status !== 'drafted') return

    const grounded = groundDraft({
      drafts: outcome.drafts,
      offeredFacts: [fact],
      acceptedByUserId: USER,
    })

    expect(grounded.accepted.map((claim) => claim.key)).toEqual(['heading'])
    expect(grounded.rejected).toHaveLength(1)
    expect(grounded.rejected[0].draft.key).toBe('subheading')
  })
})
