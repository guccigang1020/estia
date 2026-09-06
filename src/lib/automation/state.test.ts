/**
 * Laying an organization's decisions over the library.
 *
 * The assertion this file exists for is the first one: **an absent row is not a
 * disabled rule.** Five of the fourteen shipped rules are on by default — the
 * failed-payment alert, the overdue-task alert, the channel-sync alert — and
 * they are on because a business would never think to go and enable them and
 * missing one costs a double booking. A resolver that treated "no row" as
 * "off" would switch all five off for every organization that has never opened
 * the automation screen, and nothing would report it.
 *
 * Everything else here is about the other confusion the module cares about: a
 * rule set for one property and a rule set for the whole organization are
 * different facts, and a screen that showed one as the other would have a
 * manager switching something off in the wrong place.
 */

import { describe, expect, it } from 'vitest'

import { AUTOMATION_TEMPLATES, templateById } from './library'
import { effectiveRules, resolveRules, type StoredRule } from './state'

const PROPERTY = '33333333-3333-4333-8333-333333333333'
const OTHER_PROPERTY = '44444444-4444-4444-8444-444444444444'

/** A rule that ships ON: internal, and nobody has to opt into it. */
const SHIPS_ON = 'payment-failed-alert'
/** A rule that ships OFF: it speaks to a guest. */
const SHIPS_OFF = 'pre-arrival-instructions'
/** The one rule with a threshold. */
const TUNABLE = 'review-request-after-stay'

function row(
  overrides: Partial<StoredRule> & { templateId: string },
): StoredRule {
  return {
    id: `row-${overrides.templateId}-${overrides.propertyId ?? 'org'}`,
    propertyId: null,
    enabled: false,
    parameters: {},
    enabledAt: null,
    enabledBy: null,
    disabledAt: null,
    updatedAt: '2026-09-01T09:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

function ruleNamed(resolved: ReturnType<typeof resolveRules>, id: string) {
  const found = resolved.find((entry) => entry.rule.id === id)
  if (!found) throw new Error(`No rule '${id}' in the resolution`)
  return found
}

/* ------------------------------------------------------- the three states -- */

describe('an absent row is not a disabled rule', () => {
  it('leaves every rule exactly as the library ships it', () => {
    const resolved = resolveRules([], null)

    expect(resolved).toHaveLength(AUTOMATION_TEMPLATES.length)
    for (const entry of resolved) {
      const shipped = templateById(entry.rule.id)!
      expect(entry.rule.enabled, entry.rule.id).toBe(shipped.rule.enabled)
      expect(entry.source, entry.rule.id).toBe('shipped')
      expect(entry.stored, entry.rule.id).toBeNull()
    }
  })

  it('keeps the internal alerts on for a business that never opened the screen', () => {
    const resolved = resolveRules([], null)
    expect(ruleNamed(resolved, SHIPS_ON).rule.enabled).toBe(true)
  })

  it('tells a row that says off from no row at all', () => {
    const resolved = resolveRules(
      [row({ templateId: SHIPS_ON, enabled: false })],
      null,
    )
    const decided = ruleNamed(resolved, SHIPS_ON)

    expect(decided.rule.enabled).toBe(false)
    expect(decided.source).toBe('organization')
    expect(decided.stored).not.toBeNull()
  })

  it('lets a business switch on a rule that ships off', () => {
    const resolved = resolveRules(
      [row({ templateId: SHIPS_OFF, enabled: true })],
      null,
    )
    expect(ruleNamed(resolved, SHIPS_OFF).rule.enabled).toBe(true)
  })
})

/* ------------------------------------------------------------ the scopes -- */

describe('the property row wins, wholesale', () => {
  const stored = [
    row({ templateId: SHIPS_OFF, enabled: true }),
    row({ templateId: SHIPS_OFF, propertyId: PROPERTY, enabled: false }),
  ]

  it('gives the property its own answer when looking at that property', () => {
    const decided = ruleNamed(resolveRules(stored, PROPERTY), SHIPS_OFF)
    expect(decided.rule.enabled).toBe(false)
    expect(decided.source).toBe('property')
  })

  it('gives the organization answer when looking at another property', () => {
    const decided = ruleNamed(resolveRules(stored, OTHER_PROPERTY), SHIPS_OFF)
    expect(decided.rule.enabled).toBe(true)
    expect(decided.source).toBe('organization')
  })

  it('never lets one property answer for the organization view', () => {
    // The failure this prevents: a manager on the all-properties view seeing
    // one property's override and believing it is the organization's setting.
    const decided = ruleNamed(resolveRules(stored, null), SHIPS_OFF)
    expect(decided.rule.enabled).toBe(true)
    expect(decided.source).toBe('organization')
  })

  it('reports which properties have overridden it, in every view', () => {
    for (const view of [null, PROPERTY, OTHER_PROPERTY]) {
      expect(
        ruleNamed(resolveRules(stored, view), SHIPS_OFF).overriddenAtProperties,
      ).toEqual([PROPERTY])
    }
  })

  it('reports no overrides for a rule nobody has scoped', () => {
    expect(
      ruleNamed(resolveRules(stored, null), SHIPS_ON).overriddenAtProperties,
    ).toEqual([])
  })
})

/* -------------------------------------------------------- the parameters -- */

describe('the thresholds a business chose', () => {
  it('applies a stored threshold to the rule that would run', () => {
    const resolved = resolveRules(
      [
        row({
          templateId: TUNABLE,
          enabled: true,
          parameters: { minimum_nights: 4 },
        }),
      ],
      null,
    )
    expect(ruleNamed(resolved, TUNABLE).rule.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 4 },
    ])
    expect(ruleNamed(resolved, TUNABLE).parameters).toEqual({
      minimum_nights: 4,
    })
  })

  it('falls back to the shipped number for a parameter the row predates', () => {
    // A row written before a parameter existed carries nothing for it. The
    // library's own number is the honest answer; zero would be a rule silently
    // retuned to match everything.
    const resolved = resolveRules(
      [row({ templateId: TUNABLE, enabled: true, parameters: {} })],
      null,
    )
    expect(ruleNamed(resolved, TUNABLE).parameters).toEqual({
      minimum_nights: 2,
    })
  })

  it('takes the property row’s threshold over the organization’s', () => {
    const resolved = resolveRules(
      [
        row({
          templateId: TUNABLE,
          enabled: true,
          parameters: { minimum_nights: 4 },
        }),
        row({
          templateId: TUNABLE,
          propertyId: PROPERTY,
          enabled: true,
          parameters: { minimum_nights: 1 },
        }),
      ],
      PROPERTY,
    )
    expect(ruleNamed(resolved, TUNABLE).rule.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 1 },
    ])
  })
})

/* ----------------------------------------------------- what the engine gets -- */

describe('effectiveRules', () => {
  it('hands the engine one rule per template, in library order', () => {
    const rules = effectiveRules(resolveRules([], null))
    expect(rules.map((rule) => rule.id)).toEqual(
      AUTOMATION_TEMPLATES.map((template) => template.rule.id),
    )
  })

  it('hands it the configured state, not the shipped one', () => {
    const rules = effectiveRules(
      resolveRules([row({ templateId: SHIPS_ON, enabled: false })], null),
    )
    expect(rules.find((rule) => rule.id === SHIPS_ON)?.enabled).toBe(false)
  })

  it('ignores a row naming a rule the library no longer carries', () => {
    // A template removed from the library leaves rows behind — 0067 refuses
    // DELETE, deliberately. They must not appear as rules; the library is the
    // only list of what exists.
    const rules = effectiveRules(
      resolveRules([row({ templateId: 'retired-rule', enabled: true })], null),
    )
    expect(rules).toHaveLength(AUTOMATION_TEMPLATES.length)
    expect(rules.some((rule) => rule.id === 'retired-rule')).toBe(false)
  })
})
