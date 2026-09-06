import { describe, expect, it } from 'vitest'

import { rule } from './rule'
import {
  buildDispositions,
  buildPolicyContext,
  buildSafetyCeiling,
  buildSafetyCeilingByAction,
  resolveLevel,
  settingsOrDefaults,
  type AutopilotPolicyRecord,
  type AutopilotSafetyRuleRecord,
  type AutopilotSettingsRecord,
} from './context'

const NOW = new Date('2026-09-06T09:00:00.000Z')

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '22222222-2222-4222-8222-222222222222'
const BOOKING = '33333333-3333-4333-8333-333333333333'

function settings(
  overrides: Partial<AutopilotSettingsRecord> = {},
): AutopilotSettingsRecord {
  return {
    organizationId: ORG,
    level: 'autopilot',
    runMode: 'live',
    enabled: true,
    pausedUntil: null,
    pausedReason: null,
    lookaheadHours: 72,
    ...overrides,
  }
}

function policy(
  overrides: Partial<AutopilotPolicyRecord> & {
    actionKind: AutopilotPolicyRecord['actionKind']
  },
): AutopilotPolicyRecord {
  return {
    id: `policy-${overrides.actionKind}-${overrides.propertyId ?? 'org'}`,
    organizationId: ORG,
    propertyId: null,
    disposition: 'suggest',
    ...overrides,
  }
}

/** The two rows 0046 seeds, as records. */
const SHIPPED_RULES: AutopilotSafetyRuleRecord[] = [
  {
    id: 'rule-money',
    actionKind: null,
    maxSafetyLevel: 'money_access_cancellation',
    maxDisposition: 'ask_approval',
    reason:
      'Money, guest access and the loss of a booking are never automatic.',
  },
  {
    id: 'rule-business',
    actionKind: null,
    maxSafetyLevel: 'business_impact',
    maxDisposition: 'ask_approval',
    reason: 'Changing a price is a commercial decision.',
  },
]

describe('settings that were never saved', () => {
  it('are off and simulating rather than absent', () => {
    const resolved = settingsOrDefaults(ORG, null)

    // A customer whose entitlement was granted this morning must not wake up
    // to messages having been sent overnight.
    expect(resolved.level).toBe('off')
    expect(resolved.runMode).toBe('simulation')
    expect(resolved.enabled).toBe(true)
    expect(resolved.pausedUntil).toBeNull()
  })

  it('are not substituted for a row that exists', () => {
    expect(settingsOrDefaults(ORG, settings()).level).toBe('autopilot')
  })
})

describe('resolveLevel', () => {
  it('takes the lower of the two', () => {
    expect(resolveLevel('autopilot', 'advisory')).toBe('advisory')
    expect(resolveLevel('assisted', 'advisory')).toBe('advisory')
  })

  it('refuses to let a property sit higher than its organization', () => {
    expect(resolveLevel('advisory', 'autopilot')).toBe('advisory')
    expect(resolveLevel('assisted', 'autopilot')).toBe('assisted')
  })

  it('leaves the organization alone when the property says nothing', () => {
    expect(resolveLevel('autopilot', null)).toBe('autopilot')
    expect(resolveLevel('custom', null)).toBe('custom')
  })

  it('lets nothing start an organization that is off', () => {
    expect(resolveLevel('off', 'autopilot')).toBe('off')
    expect(resolveLevel('off', 'assisted')).toBe('off')
  })

  it('treats a property row under a custom organization as subtraction', () => {
    // `custom` is off the ladder, so it cannot be compared — but the matrix is
    // consulted either way one floor further down, so the property's rung is
    // pure narrowing.
    expect(resolveLevel('custom', 'advisory')).toBe('advisory')
    expect(resolveLevel('custom', 'assisted')).toBe('assisted')
  })

  it('does not honour a custom property level, which 0046 forbids', () => {
    // A row that says `custom` at property level bypassed a CHECK. It is not
    // trusted as a second matrix, and it does not blind the business either.
    expect(resolveLevel('autopilot', 'custom')).toBe('advisory')
    expect(resolveLevel('off', 'custom')).toBe('off')
  })
})

describe('the matrix, assembled', () => {
  it('reads the organization s cells', () => {
    const matrix = buildDispositions(
      [policy({ actionKind: 'task.create', disposition: 'auto' })],
      null,
    )
    expect(matrix['task.create']).toBe('auto')
  })

  it('lays the property s cells over them', () => {
    const matrix = buildDispositions(
      [
        policy({ actionKind: 'task.create', disposition: 'auto' }),
        policy({
          actionKind: 'task.create',
          propertyId: PROPERTY,
          disposition: 'suggest',
        }),
      ],
      PROPERTY,
    )
    expect(matrix['task.create']).toBe('suggest')
  })

  it('ignores another property s cells', () => {
    const matrix = buildDispositions(
      [
        policy({ actionKind: 'task.create', disposition: 'auto' }),
        policy({
          actionKind: 'task.create',
          propertyId: BOOKING,
          disposition: 'off',
        }),
      ],
      PROPERTY,
    )
    expect(matrix['task.create']).toBe('auto')
  })

  it('is empty when nothing was configured', () => {
    expect(Object.keys(buildDispositions([], null))).toEqual([])
  })
})

describe('the platform ceiling, expanded', () => {
  it('climbs from the level a blanket rule names', () => {
    const ceiling = buildSafetyCeiling(SHIPPED_RULES)

    // One row capping business_impact caps money_access_cancellation too,
    // which is the whole reason the column is called `max_safety_level`.
    expect(ceiling.business_impact).toBe('ask_approval')
    expect(ceiling.money_access_cancellation).toBe('ask_approval')
  })

  it('leaves the levels below it alone', () => {
    const ceiling = buildSafetyCeiling(SHIPPED_RULES)
    expect(ceiling.information).toBeUndefined()
    expect(ceiling.safe_internal).toBeUndefined()
    expect(ceiling.external_communication).toBeUndefined()
  })

  it('keeps the stricter of two rules that reach the same level', () => {
    const ceiling = buildSafetyCeiling([
      ...SHIPPED_RULES,
      {
        id: 'rule-strict',
        actionKind: null,
        maxSafetyLevel: 'business_impact',
        maxDisposition: 'suggest',
        reason: 'Stricter.',
      },
    ])
    expect(ceiling.business_impact).toBe('suggest')
  })

  it('never lets an action-specific rule reach the level map at all', () => {
    // It used to be folded in here, given the action being ruled on. That is
    // right for a context built to answer one question and wrong for the one
    // this codebase builds — gathered per organization, ruled on for many
    // actions — where it made every sibling at the level inherit a cap that
    // was never about them.
    const rules: AutopilotSafetyRuleRecord[] = [
      {
        id: 'rule-one-action',
        actionKind: 'guest.send_reminder',
        maxSafetyLevel: 'external_communication',
        maxDisposition: 'suggest',
        reason: 'One action only.',
      },
    ]

    expect(buildSafetyCeiling(rules).external_communication).toBeUndefined()
    expect(Object.keys(buildSafetyCeiling(rules))).toEqual([])
  })
})

describe('the platform ceiling for one named action', () => {
  it('keys a rule by the action it names', () => {
    const ceiling = buildSafetyCeilingByAction([
      {
        id: 'rule-one-action',
        actionKind: 'guest.send_reminder',
        maxSafetyLevel: 'external_communication',
        maxDisposition: 'suggest',
        reason: 'One action only.',
      },
    ])

    expect(ceiling['guest.send_reminder']).toBe('suggest')
    // The sibling at the same safety level is untouched, which is the whole
    // reason `action_kind` is nullable rather than absent.
    expect(ceiling['cleaner.notify']).toBeUndefined()
  })

  it('ignores the blanket rules, which the level map already carries', () => {
    expect(Object.keys(buildSafetyCeilingByAction(SHIPPED_RULES))).toEqual([])
  })

  it('keeps the stricter of two rules naming the same action', () => {
    const ceiling = buildSafetyCeilingByAction([
      {
        id: 'rule-a',
        actionKind: 'upsell.offer',
        maxSafetyLevel: 'business_impact',
        maxDisposition: 'ask_approval',
        reason: 'Prepared, never made.',
      },
      {
        id: 'rule-b',
        actionKind: 'upsell.offer',
        maxSafetyLevel: 'business_impact',
        maxDisposition: 'off',
        reason: 'After the incident.',
      },
    ])

    expect(ceiling['upsell.offer']).toBe('off')
  })

  it('is empty when no rule names an action', () => {
    expect(Object.keys(buildSafetyCeilingByAction([]))).toEqual([])
  })
})

describe('the context, gathered', () => {
  it('carries the narrowed level rather than the organization s', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: null,
      settings: settings({ level: 'autopilot' }),
      propertyLevel: {
        propertyId: PROPERTY,
        organizationId: ORG,
        level: 'assisted',
      },
      bookingOverride: null,
      policies: [],
      safetyRules: SHIPPED_RULES,
      entitlements: ['core', 'operations'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.level).toBe('assisted')
    expect(rule('task.create', built, 'high')).toMatchObject({
      allowed: true,
      disposition: 'ask_approval',
    })
  })

  it('carries both platform ceilings, and one context serves many actions', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: null,
      bookingId: null,
      settings: settings(),
      propertyLevel: null,
      bookingOverride: null,
      policies: [],
      safetyRules: [
        ...SHIPPED_RULES,
        {
          id: 'rule-after-the-incident',
          actionKind: 'guest.request_review',
          maxSafetyLevel: 'external_communication',
          maxDisposition: 'suggest',
          reason: 'One action only, after an incident with that one thing.',
        },
      ],
      entitlements: ['core', 'operations'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.safetyCeiling.business_impact).toBe('ask_approval')
    expect(built.safetyCeilingByAction?.['guest.request_review']).toBe(
      'suggest',
    )

    // The same context, ruled on twice. The named action is capped and its
    // safety-level sibling is not — which is what the old fold could not do,
    // because a context built for one action was the only shape it was right
    // for.
    expect(rule('guest.request_review', built, 'high')).toMatchObject({
      allowed: true,
      disposition: 'suggest',
    })
    expect(rule('cleaner.escalate', built, 'high')).toMatchObject({
      allowed: true,
      disposition: 'auto',
    })
  })

  it('ignores a property row belonging to another organization', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: PROPERTY,
      bookingId: null,
      settings: settings(),
      propertyLevel: {
        propertyId: PROPERTY,
        organizationId: BOOKING,
        level: 'off',
      },
      bookingOverride: null,
      policies: [],
      safetyRules: [],
      entitlements: ['core', 'operations'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.level).toBe('autopilot')
  })

  it('ignores a booking override belonging to another organization', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: null,
      bookingId: BOOKING,
      settings: settings(),
      propertyLevel: null,
      bookingOverride: {
        bookingId: BOOKING,
        organizationId: PROPERTY,
        handling: 'manual_only',
      },
      policies: [],
      safetyRules: [],
      entitlements: ['core', 'operations'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.bookingHandling).toBe('normal')
  })

  it('applies a booking override that is genuinely this organization s', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: null,
      bookingId: BOOKING,
      settings: settings(),
      propertyLevel: null,
      bookingOverride: {
        bookingId: BOOKING,
        organizationId: ORG,
        handling: 'manual_only',
      },
      policies: [],
      safetyRules: [],
      entitlements: ['core', 'operations'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.bookingHandling).toBe('manual_only')
    expect(rule('task.create', built, 'high')).toMatchObject({
      allowed: true,
      disposition: 'suggest',
    })
  })

  it('falls back to off and simulation when nothing was ever saved', () => {
    const built = buildPolicyContext({
      organizationId: ORG,
      propertyId: null,
      bookingId: null,
      settings: null,
      propertyLevel: null,
      bookingOverride: null,
      policies: [],
      safetyRules: [],
      entitlements: ['core'],
      holdsGrant: () => true,
      inQuietHours: false,
      now: NOW,
    })

    expect(built.level).toBe('off')
    expect(built.runMode).toBe('simulation')
    expect(rule('exception.raise', built, 'high')).toMatchObject({
      allowed: false,
      reason: 'level_too_low',
    })
  })
})
