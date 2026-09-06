import { describe, expect, it } from 'vitest'

import type {
  ActionSafetyLevel,
  AutopilotDisposition,
} from '../../contracts/states'
import type { Entitlement } from '../../plans/entitlements'
import { AUTOPILOT_ACTIONS, type AutopilotActionKind } from '../actions'
import type { PolicyContext } from '../types'

import { dispositionOf, rule } from './rule'

const NOW = new Date('2026-09-06T09:00:00.000Z')

/**
 * A permissive context, so that every test below is a statement about ONE
 * floor. A fixture that started refused would let a test pass because of a
 * layer it was not written about.
 */
function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    organizationId: 'org-1',
    propertyId: null,
    bookingId: null,
    level: 'autopilot',
    runMode: 'live',
    enabled: true,
    pausedUntil: null,
    bookingHandling: 'normal',
    dispositions: {},
    safetyCeiling: {},
    safetyCeilingByAction: {},
    entitlements: [
      'core',
      'operations',
      'payments',
      'laundry',
      'commerce',
      'agent_network',
      'dynamic_pricing',
    ] satisfies Entitlement[],
    holdsGrant: () => true,
    inQuietHours: false,
    now: NOW,
    ...overrides,
  }
}

/** The platform floor 0046 actually seeds, as the engine reads it. */
const SHIPPED_CEILING: Partial<
  Record<ActionSafetyLevel, AutopilotDisposition>
> = {
  business_impact: 'ask_approval',
  money_access_cancellation: 'ask_approval',
}

function allowedDisposition(ruling: ReturnType<typeof rule>): string {
  return dispositionOf(ruling)
}

describe('the kill switch', () => {
  it('stops everything, including reading out a suggestion', () => {
    const ruling = rule('exception.raise', context({ enabled: false }), 'high')

    expect(ruling.allowed).toBe(false)
    if (ruling.allowed) return
    expect(ruling.reason).toBe('kill_switch')
    expect(ruling.explanation.length).toBeGreaterThan(0)
  })

  it('is checked before anything else, so no later floor can excuse it', () => {
    // Level `off` would also refuse. The kill switch is what must be reported,
    // because it is the one a person can undo in a second.
    const ruling = rule(
      'task.create',
      context({ enabled: false, level: 'off' }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('kill_switch')
  })
})

describe('a pause', () => {
  it('stops the action while it is running', () => {
    const ruling = rule(
      'task.create',
      context({ pausedUntil: '2026-09-06T18:00:00.000Z' }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('paused')
  })

  it('means NOTHING once it has run out', () => {
    // The failure this guards against is a business that paused for an hour
    // during an incident and is still switched off months later.
    const ruling = rule(
      'task.create',
      context({ pausedUntil: '2026-09-06T08:00:00.000Z' }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
    expect(allowedDisposition(ruling)).toBe('auto')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain('pause:expired')
  })

  it('treats the exact instant it expires as expired', () => {
    const ruling = rule(
      'task.create',
      context({ pausedUntil: NOW.toISOString() }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
  })

  it('ignores a pause timestamp it cannot read', () => {
    const ruling = rule(
      'task.create',
      context({ pausedUntil: 'yesterday' }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
  })
})

describe('the module and the grant', () => {
  it('never plans an action from a module the package lacks', () => {
    const ruling = rule(
      'laundry.draft_order',
      context({ entitlements: ['core', 'operations'] }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('missing_entitlement')
  })

  it('allows a core action for a package that has bought nothing else', () => {
    const ruling = rule(
      'exception.raise',
      context({ entitlements: ['core'] }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
  })

  it('asks the grant exactly as a click would', () => {
    const asked: string[] = []
    const ruling = rule(
      'task.create',
      context({
        holdsGrant: (grant) => {
          asked.push(grant)
          return false
        },
      }),
      'high',
    )

    expect(asked).toEqual([AUTOPILOT_ACTIONS['task.create'].grant])
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('missing_permission')
  })
})

describe('a booking somebody has marked', () => {
  it('manual_only leaves the watching on and caps at a suggestion', () => {
    const ruling = rule(
      'task.create',
      context({ bookingHandling: 'manual_only' }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
    expect(allowedDisposition(ruling)).toBe('suggest')
  })

  it('high_attention still lets internal work happen', () => {
    const ruling = rule(
      'task.create',
      context({ bookingHandling: 'high_attention' }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('auto')
  })

  it('high_attention stops anything that leaves the building', () => {
    const ruling = rule(
      'guest.send_reminder',
      context({ bookingHandling: 'high_attention' }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('ask_approval')
  })
})

describe('the level the customer chose', () => {
  it('off refuses, and says which floor refused', () => {
    const ruling = rule('exception.raise', context({ level: 'off' }), 'high')
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('level_too_low')
  })

  it('advisory recommends and never acts', () => {
    const ruling = rule('task.create', context({ level: 'advisory' }), 'high')
    expect(allowedDisposition(ruling)).toBe('suggest')
  })

  it('assisted prepares and waits for a person', () => {
    const ruling = rule('task.create', context({ level: 'assisted' }), 'high')
    expect(allowedDisposition(ruling)).toBe('ask_approval')
  })

  it('autopilot performs safe work', () => {
    const ruling = rule('task.create', context({ level: 'autopilot' }), 'high')
    expect(allowedDisposition(ruling)).toBe('auto')
  })

  it('custom imposes nothing of its own — the matrix decides', () => {
    const withCell = rule(
      'task.create',
      context({ level: 'custom', dispositions: { 'task.create': 'auto' } }),
      'high',
    )
    expect(allowedDisposition(withCell)).toBe('auto')
  })

  it('custom with an empty matrix has authorised nothing', () => {
    const ruling = rule('task.create', context({ level: 'custom' }), 'high')
    expect(allowedDisposition(ruling)).toBe('suggest')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain(
      'matrix:unset_under_custom:capped_at_suggest',
    )
  })
})

describe('the matrix', () => {
  it('off is a refusal with its own reason', () => {
    const ruling = rule(
      'task.create',
      context({ dispositions: { 'task.create': 'off' } }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('policy_off')
  })

  it('narrows what the level allowed', () => {
    const ruling = rule(
      'task.create',
      context({ dispositions: { 'task.create': 'suggest' } }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('suggest')
  })

  it('cannot widen what the level allowed', () => {
    const ruling = rule(
      'task.create',
      context({
        level: 'advisory',
        dispositions: { 'task.create': 'auto' },
      }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('suggest')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain('level:advisory:capped_at_suggest')
    // The matrix was consulted and did not move anything, and the record says
    // exactly that rather than pretending it was never read.
    expect(ruling.appliedFloors).toContain('matrix:auto')
  })

  it('an unset cell falls back to the level rather than to off', () => {
    const ruling = rule('task.create', context(), 'high')
    expect(allowedDisposition(ruling)).toBe('auto')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain('matrix:unset')
  })
})

describe('the platform floor, which is the last word', () => {
  it('a refund the customer set to auto is still only ask_approval', () => {
    const ruling = rule(
      'payment.refund',
      context({
        level: 'autopilot',
        dispositions: { 'payment.refund': 'auto' },
        safetyCeiling: SHIPPED_CEILING,
      }),
      'high',
    )

    expect(ruling.allowed).toBe(true)
    expect(allowedDisposition(ruling)).toBe('ask_approval')

    if (!ruling.allowed) return
    // The point of the assertion: it is the PLATFORM that stopped it, and not
    // the level, the matrix, the confidence or the quiet window. A test that
    // only checked the disposition would pass if any of those had done it,
    // which is the failure this whole file exists to catch.
    expect(ruling.appliedFloors).toContain(
      'platform_ceiling:money_access_cancellation:capped_at_ask_approval',
    )
    expect(ruling.appliedFloors).toContain('level:autopilot')
    expect(ruling.appliedFloors).toContain('matrix:auto')
    expect(ruling.appliedFloors).toContain('confidence:high')
    expect(ruling.appliedFloors).toContain('quiet_hours:outside')
  })

  it('caps a cancellation the same way', () => {
    const ruling = rule(
      'booking.cancel',
      context({
        dispositions: { 'booking.cancel': 'auto' },
        safetyCeiling: SHIPPED_CEILING,
      }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('ask_approval')
  })

  it('caps a price suggestion the same way', () => {
    const ruling = rule(
      'price.suggest',
      context({
        dispositions: { 'price.suggest': 'auto' },
        safetyCeiling: SHIPPED_CEILING,
      }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('ask_approval')
  })

  it('leaves safe internal work alone under the shipped floor', () => {
    const ruling = rule(
      'task.create',
      context({ safetyCeiling: SHIPPED_CEILING }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('auto')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain('platform_ceiling:none')
  })

  it('forbids entirely when the ceiling is off, and names the platform', () => {
    const ruling = rule(
      'payment.refund',
      context({ safetyCeiling: { money_access_cancellation: 'off' } }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('platform_rule')
  })

  it('never raises what the customer already lowered', () => {
    const ruling = rule(
      'payment.refund',
      context({
        dispositions: { 'payment.refund': 'suggest' },
        safetyCeiling: SHIPPED_CEILING,
      }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('suggest')
  })
})

describe('a platform rule aimed at one named action', () => {
  it('caps that action and leaves its safety-level siblings alone', () => {
    // `guest.request_review` and `cleaner.escalate` are both
    // `external_communication`. A rule written after an incident with review
    // requests must not quietly hold back the escalation that tells a manager
    // their cleaner has not turned up — which is exactly what folding the rule
    // in at its safety level used to do.
    const scoped = context({
      safetyCeilingByAction: { 'guest.request_review': 'suggest' },
    })

    const named = rule('guest.request_review', scoped, 'high')
    expect(allowedDisposition(named)).toBe('suggest')
    if (!named.allowed) throw new Error('expected an allowance')
    expect(named.appliedFloors).toContain(
      'platform_ceiling:guest.request_review:capped_at_suggest',
    )

    const sibling = rule('cleaner.escalate', scoped, 'high')
    expect(allowedDisposition(sibling)).toBe('auto')
    if (!sibling.allowed) throw new Error('expected an allowance')
    expect(sibling.appliedFloors).toContain('platform_ceiling:none')
  })

  it('is applied alongside the blanket rule, and the stricter one wins', () => {
    const ruling = rule(
      'payment.refund',
      context({
        dispositions: { 'payment.refund': 'auto' },
        safetyCeiling: SHIPPED_CEILING,
        safetyCeilingByAction: { 'payment.refund': 'suggest' },
      }),
      'high',
    )

    expect(allowedDisposition(ruling)).toBe('suggest')
    if (!ruling.allowed) throw new Error('expected an allowance')
    // The entry names the action rather than the safety level, so a person
    // asking why knows which of the two rules to go and read.
    expect(ruling.appliedFloors).toContain(
      'platform_ceiling:payment.refund:capped_at_suggest',
    )
  })

  it('does not loosen the blanket rule when it is the weaker of the two', () => {
    const ruling = rule(
      'payment.refund',
      context({
        dispositions: { 'payment.refund': 'auto' },
        safetyCeiling: { money_access_cancellation: 'suggest' },
        safetyCeilingByAction: { 'payment.refund': 'auto' },
      }),
      'high',
    )

    expect(allowedDisposition(ruling)).toBe('suggest')
    if (!ruling.allowed) throw new Error('expected an allowance')
    expect(ruling.appliedFloors).toContain(
      'platform_ceiling:money_access_cancellation:capped_at_suggest',
    )
  })

  it('forbids entirely when the action-specific ceiling is off', () => {
    const ruling = rule(
      'guest.request_review',
      context({ safetyCeilingByAction: { 'guest.request_review': 'off' } }),
      'high',
    )
    if (ruling.allowed) throw new Error('expected a refusal')
    expect(ruling.reason).toBe('platform_rule')
    expect(ruling.explanation.length).toBeGreaterThan(0)
  })
})

describe('confidence', () => {
  it('a low-confidence guess may be prepared and never performed', () => {
    const ruling = rule('guest.send_reminder', context(), 'low')
    expect(allowedDisposition(ruling)).toBe('ask_approval')
    if (!ruling.allowed) return
    expect(ruling.appliedFloors).toContain(
      'confidence:low:capped_at_ask_approval',
    )
  })

  it('leaves internal work alone, so approval fatigue is not manufactured', () => {
    const ruling = rule('task.create', context(), 'low')
    expect(allowedDisposition(ruling)).toBe('auto')
  })

  it('defaults to low when the caller states no judgment', () => {
    // Fail closed: an action nobody was willing to put a confidence on is not
    // an action that should run unattended.
    const stated = rule('guest.send_reminder', context(), 'high')
    const unstated = rule('guest.send_reminder', context())

    expect(allowedDisposition(stated)).toBe('auto')
    expect(allowedDisposition(unstated)).toBe('ask_approval')
  })
})

describe('quiet hours', () => {
  it('hold back what somebody would have to read at three in the morning', () => {
    const ruling = rule(
      'guest.send_reminder',
      context({ inQuietHours: true }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('ask_approval')
  })

  it('never stop internal work, because that is not what they are for', () => {
    const ruling = rule('task.create', context({ inQuietHours: true }), 'high')
    expect(allowedDisposition(ruling)).toBe('auto')
  })

  it('never suppress — a held action is not a cancelled one', () => {
    const ruling = rule(
      'laundry.send_order',
      context({ inQuietHours: true }),
      'high',
    )
    expect(ruling.allowed).toBe(true)
  })
})

describe('simulation', () => {
  it('records rather than suppresses', () => {
    const ruling = rule(
      'guest.send_reminder',
      context({ runMode: 'simulation' }),
      'high',
    )

    // A fortnight of "suppressed: simulation" would tell a business nothing
    // about what ESTIA would have done, which is the only reason the mode
    // exists.
    expect(ruling.allowed).toBe(true)
  })

  it('rules auto when every other floor permits auto, and caps nothing', () => {
    // DO NOT "fix" this back to a cap at ask_approval. The run mode is not
    // part of the question `rule()` answers, and two other floors — not this
    // one — are what stop a simulation:
    //
    //   · the executor reads `runMode` first and records the action with
    //     outcome `simulated` without dispatching anything;
    //   · `autopilot_actions_simulation_never_executes` in 0046 makes a
    //     simulated run structurally incapable of recording an execution.
    //
    // A cap here would also be a lie in the other direction: the review screen
    // exists to say "ESTIA would have sent 14 reminders automatically", and
    // `ask_approval` is a real instruction an executor would honour by raising
    // genuine approval requests during a simulation.
    const ruling = rule(
      'task.create',
      context({ runMode: 'simulation' }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('auto')
    if (!ruling.allowed) throw new Error('expected an allowance')

    // The mode is still recorded, so a reader can tell a simulated ruling from
    // a live one rather than wondering whether anybody looked.
    expect(ruling.appliedFloors).toContain('run_mode:simulation')
    expect(
      ruling.appliedFloors.filter((entry) => entry.startsWith('run_mode:')),
    ).toEqual(['run_mode:simulation'])
  })

  it('narrows nothing that the live ruling did not narrow', () => {
    const simulated = rule(
      'guest.send_reminder',
      context({ runMode: 'simulation', inQuietHours: true }),
      'high',
    )
    const live = rule(
      'guest.send_reminder',
      context({ runMode: 'live', inQuietHours: true }),
      'high',
    )

    expect(allowedDisposition(simulated)).toBe(allowedDisposition(live))
    expect(allowedDisposition(simulated)).toBe('ask_approval')
    if (!simulated.allowed) throw new Error('expected an allowance')
    // Quiet hours did it. Simulation was consulted and changed nothing.
    expect(
      simulated.appliedFloors.filter((entry) => entry.includes(':capped_at_')),
    ).toEqual(['quiet_hours:inside:capped_at_ask_approval'])
  })

  it('leaves a suggestion a suggestion', () => {
    const ruling = rule(
      'task.create',
      context({ runMode: 'simulation', level: 'advisory' }),
      'high',
    )
    expect(allowedDisposition(ruling)).toBe('suggest')
  })
})

describe('the record of what was consulted', () => {
  it('names every layer, in the order they were applied', () => {
    const ruling = rule('task.create', context(), 'high')
    if (!ruling.allowed) throw new Error('expected an allowance')

    expect(ruling.appliedFloors.map((entry) => entry.split(':')[0])).toEqual([
      'kill_switch',
      'pause',
      'entitlement',
      'grant',
      'booking_handling',
      'level',
      'matrix',
      'platform_ceiling',
      'confidence',
      'quiet_hours',
      'run_mode',
    ])
  })

  it('answers "why is this only a suggestion" without a database', () => {
    const ruling = rule(
      'guest.send_reminder',
      context({ level: 'advisory', inQuietHours: true }),
      'low',
    )
    if (!ruling.allowed) throw new Error('expected an allowance')

    const capped = ruling.appliedFloors.filter((entry) =>
      entry.includes(':capped_at_'),
    )
    // The level is what made it a suggestion; the other two floors would have
    // stopped short of it and are recorded as having been consulted.
    expect(capped).toEqual(['level:advisory:capped_at_suggest'])
  })
})

describe('every action in the catalogue', () => {
  const kinds = Object.keys(AUTOPILOT_ACTIONS) as AutopilotActionKind[]

  it('is rulable, and never refused without a reason', () => {
    for (const kind of kinds) {
      const ruling = rule(kind, context({ safetyCeiling: SHIPPED_CEILING }))
      if (ruling.allowed) {
        expect(ruling.disposition).not.toBe('off')
        expect(ruling.appliedFloors.length).toBe(11)
      } else {
        expect(ruling.reason.length).toBeGreaterThan(0)
        expect(ruling.explanation.length).toBeGreaterThan(0)
      }
    }
  })

  it('is never automatic above safe_internal under the shipped floor', () => {
    // Every cell set to `auto` on purpose. Nothing above safe_internal may
    // come back as `auto`, and no ordering of the floors can change that.
    const dispositions = Object.fromEntries(
      kinds.map((kind) => [kind, 'auto']),
    ) as Partial<Record<AutopilotActionKind, AutopilotDisposition>>

    for (const kind of kinds) {
      const spec = AUTOPILOT_ACTIONS[kind]
      const ruling = rule(
        kind,
        context({ dispositions, safetyCeiling: SHIPPED_CEILING }),
        'high',
      )

      if (spec.safety === 'business_impact') {
        expect(allowedDisposition(ruling)).toBe('ask_approval')
      }
      if (spec.safety === 'money_access_cancellation') {
        expect(allowedDisposition(ruling)).toBe('ask_approval')
      }
    }
  })
})
