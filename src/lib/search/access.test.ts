import { describe, expect, it } from 'vitest'

import type { Actor } from '../authz/can'
import { ENTITLEMENTS } from '../plans/entitlements'
import { PERMISSIONS, type Grant } from '../authz/permissions'

import { GRANT_FOR_KIND, KIND_LABEL, planSearch } from './access'
import { SEARCH_KINDS } from './query'

const ORG = '11111111-1111-4111-8111-111111111111'

function actorWith(grants: readonly Grant[]): Actor {
  return {
    userId: '22222222-2222-4222-8222-222222222222',
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(ENTITLEMENTS),
  }
}

describe('planSearch', () => {
  it('searches only what the actor may read', () => {
    // A cleaner searching a guest's name reaches tasks and nothing else — and
    // the guests query is never ISSUED, rather than issued and filtered.
    const plan = planSearch(actorWith(['task.view']), [...SEARCH_KINDS])

    expect(plan.searchable).toEqual(['task'])
  })

  it('names what it did not search rather than searching quietly', () => {
    // Silence here produces the failure this codebase keeps naming: somebody
    // searches a phone, finds nothing, and concludes the guest is not in the
    // system. The truth is that the system did not look.
    const plan = planSearch(actorWith(['task.view']), ['guest', 'task'])

    expect(plan.closed).toEqual(['guest'])
  })

  it('opens everything for an actor holding every grant', () => {
    const plan = planSearch(actorWith([...PERMISSIONS]), [...SEARCH_KINDS])

    expect(plan.closed).toEqual([])
    expect(plan.searchable).toEqual([...SEARCH_KINDS])
  })

  it('closes a kind whose feature the package does not include', () => {
    // `holdsGrant` asks permission and plan together, so a business without
    // the agent network gets `agent` closed for the same reason a
    // receptionist does — and the screen does not have to know which.
    const withoutPlan: Actor = {
      ...actorWith(['agent.view', 'guest.view']),
      entitlements: new Set(),
    }

    const plan = planSearch(withoutPlan, ['agent', 'guest'])

    expect(plan.searchable).not.toContain('agent')
  })

  it('preserves the order the parser ranked the kinds in', () => {
    // The parser puts the likeliest kind first — guest, for a phone number —
    // and the screen renders in that order. A gate that sorted would undo it.
    const plan = planSearch(actorWith([...PERMISSIONS]), [
      'guest',
      'agent',
      'owner',
      'booking',
    ])

    expect(plan.searchable).toEqual(['guest', 'agent', 'owner', 'booking'])
  })
})

describe('the tables that must stay total', () => {
  it('gives every kind a grant', () => {
    // A kind added without one would be a kind searched with no gate at all,
    // which is the exact hole this module exists to close.
    for (const kind of SEARCH_KINDS) {
      expect(GRANT_FOR_KIND[kind], kind).toBeDefined()
      expect(PERMISSIONS).toContain(GRANT_FOR_KIND[kind])
    }
  })

  it('gives every kind a Hebrew label', () => {
    for (const kind of SEARCH_KINDS) {
      expect(KIND_LABEL[kind], kind).toBeTruthy()
    }
  })
})
