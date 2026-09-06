/**
 * The tunable half of the library.
 *
 * The assertions that matter most are the two that hold **for every template**,
 * because a parameter catalogue drifts from the rules it describes silently:
 *
 *   · every declared parameter points at a condition that is really in its
 *     rule — a parameter aimed at a condition nobody wrote is a field on a
 *     screen that changes nothing, and it looks identical to one that works;
 *   · every numeric condition in the library has a parameter — a threshold
 *     hard-coded in a template is a number the customer must live with, and
 *     the whole reason this file exists is that "two nights" is right for one
 *     business and wrong for the next.
 *
 * Both are written as loops over `AUTOMATION_TEMPLATES` rather than as fixtures
 * about the one rule that has a parameter today, so the fifteenth template gets
 * the same treatment as the first without anybody remembering to come back.
 */

import { describe, expect, it } from 'vitest'

import { AUTOMATION_TEMPLATES, templateById } from './library'
import {
  RULE_PARAMETERS,
  applyParameters,
  isNumericCondition,
  parameterIssues,
  parametersFor,
  shippedParameters,
  tunableTemplateIds,
} from './parameters'

/* --------------------------------------- the catalogue matches the rules -- */

describe('every parameter points at a condition that exists', () => {
  it('finds exactly one condition per declared parameter', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const parameter of parametersFor(template.rule.id)) {
        const matches = template.rule.conditions.filter(
          (condition) =>
            condition.field === parameter.appliesTo.field &&
            condition.kind === parameter.appliesTo.kind,
        )
        expect(
          matches.length,
          `${template.rule.id}.${parameter.key} matches ${matches.length} conditions`,
        ).toBe(1)
      }
    }
  })

  it('declares no parameter for a rule the library does not carry', () => {
    for (const templateId of Object.keys(RULE_PARAMETERS)) {
      expect(templateById(templateId), templateId).not.toBeNull()
    }
  })

  it('leaves no numeric threshold in the library hard-coded', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const numeric = template.rule.conditions.filter(isNumericCondition)
      expect(
        parametersFor(template.rule.id).length,
        `${template.rule.id} has ${numeric.length} numeric conditions`,
      ).toBe(numeric.length)
    }
  })

  it('ships the number the rule actually carries', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const parameter of parametersFor(template.rule.id)) {
        const condition = template.rule.conditions.find(
          (candidate) =>
            candidate.field === parameter.appliesTo.field &&
            candidate.kind === parameter.appliesTo.kind,
        )
        expect(
          condition && 'value' in condition ? condition.value : null,
          `${template.rule.id}.${parameter.key}`,
        ).toBe(parameter.shipped)
      }
    }
  })

  it('keeps every shipped value inside its own bounds', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const parameter of parametersFor(template.rule.id)) {
        expect(parameter.shipped).toBeGreaterThanOrEqual(parameter.min)
        expect(parameter.shipped).toBeLessThanOrEqual(parameter.max)
        expect(parameter.min).toBeLessThan(parameter.max)
      }
    }
  })

  it('uses only keys the database will accept', () => {
    // The identifier shape `0067_automation_rules.sql` enforces on every jsonb
    // key. A parameter declared here with a key the column refuses would fail
    // at the constraint, in production, on somebody's first attempt to save.
    for (const template of AUTOMATION_TEMPLATES) {
      for (const parameter of parametersFor(template.rule.id)) {
        expect(parameter.key, parameter.key).toMatch(/^[a-z][a-z0-9_]{1,39}$/)
      }
    }
  })

  it('writes every label and explanation in Hebrew', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const parameter of parametersFor(template.rule.id)) {
        expect(parameter.label).toMatch(/[֐-׿]/)
        expect(parameter.help.length).toBeGreaterThan(20)
      }
    }
  })
})

/* ------------------------------------------------------ what is tunable -- */

describe('what has something to tune, and what has nothing', () => {
  it('names the review request, which is the one rule with a threshold', () => {
    expect(tunableTemplateIds()).toEqual(['review-request-after-stay'])
  })

  it('answers with an empty list for a rule with no conditions', () => {
    // Thirteen of fourteen rules are "when this happens, tell somebody", and
    // there is genuinely nothing to adjust. The screen says so; it does not
    // render an empty box.
    expect(parametersFor('payment-failed-alert')).toEqual([])
  })

  it('answers with an empty list for a rule nobody defined', () => {
    expect(parametersFor('no-such-rule')).toEqual([])
    expect(shippedParameters('no-such-rule')).toEqual({})
  })
})

/* -------------------------------------------------------------- refusals -- */

describe('parameterIssues', () => {
  const RULE = 'review-request-after-stay'

  it('accepts a number inside the bounds', () => {
    expect(parameterIssues(RULE, { minimum_nights: 5 })).toEqual([])
  })

  it('accepts the two ends of the range', () => {
    expect(parameterIssues(RULE, { minimum_nights: 1 })).toEqual([])
    expect(parameterIssues(RULE, { minimum_nights: 30 })).toEqual([])
  })

  it('refuses a threshold that no stay could satisfy', () => {
    const issues = parameterIssues(RULE, { minimum_nights: 400 })
    expect(issues.map((issue) => issue.reason)).toEqual(['out_of_range'])
    // The sentence names the bounds, so somebody can fix it without guessing.
    expect(issues[0]?.message).toContain('30')
  })

  it('refuses a threshold of zero, which is not a threshold', () => {
    expect(
      parameterIssues(RULE, { minimum_nights: 0 }).map((issue) => issue.reason),
    ).toEqual(['out_of_range'])
  })

  it('refuses a parameter the rule does not have', () => {
    const issues = parameterIssues(RULE, { quiet_hours: 8 })
    expect(issues.map((issue) => issue.reason)).toEqual(['unknown'])
  })

  it('refuses every parameter for a rule that declares none', () => {
    expect(
      parameterIssues('payment-failed-alert', { minimum_nights: 2 }).map(
        (issue) => issue.reason,
      ),
    ).toEqual(['unknown'])
  })

  it('reports every problem at once rather than the first', () => {
    const issues = parameterIssues(RULE, {
      minimum_nights: 400,
      quiet_hours: 8,
    })
    expect(issues).toHaveLength(2)
  })

  it('refuses a value that is not a number the database could store', () => {
    expect(
      parameterIssues(RULE, {
        minimum_nights: Number.POSITIVE_INFINITY,
      }).map((issue) => issue.reason),
    ).toEqual(['not_finite'])
    expect(
      parameterIssues(RULE, { minimum_nights: Number.NaN }).map(
        (issue) => issue.reason,
      ),
    ).toEqual(['not_finite'])
  })

  it('says nothing about a parameter nobody mentioned', () => {
    expect(parameterIssues(RULE, {})).toEqual([])
  })
})

/* -------------------------------------------------------------- applying -- */

describe('applyParameters', () => {
  const review = templateById('review-request-after-stay')!

  it('replaces the number in the condition it names', () => {
    const tuned = applyParameters(review.rule, { minimum_nights: 5 })
    expect(tuned.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 5 },
    ])
  })

  it('changes nothing else about the rule', () => {
    const tuned = applyParameters(review.rule, { minimum_nights: 5 })
    expect(tuned.when).toBe(review.rule.when)
    expect(tuned.actions).toEqual(review.rule.actions)
    expect(tuned.enabled).toBe(review.rule.enabled)
  })

  it('does not mutate the library, which every request shares', () => {
    applyParameters(review.rule, { minimum_nights: 9 })
    expect(templateById('review-request-after-stay')!.rule.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 2 },
    ])
  })

  it('keeps the shipped number when the stored value is out of bounds', () => {
    // A row written before the bounds narrowed, or by something that reached
    // past the operation. Falling back to the shipped number is visible on the
    // screen as a threshold that did not move; obeying it would be a rule
    // silently matching nothing.
    const tuned = applyParameters(review.rule, { minimum_nights: 900 })
    expect(tuned.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 2 },
    ])
  })

  it('keeps the shipped number for a value that is not a number', () => {
    const tuned = applyParameters(review.rule, {
      minimum_nights: Number.NaN,
    })
    expect(tuned.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 2 },
    ])
  })

  it('ignores a stored key the rule does not declare', () => {
    const tuned = applyParameters(review.rule, {
      minimum_nights: 4,
      renamed_last_year: 11,
    })
    expect(tuned.conditions).toEqual([
      { kind: 'at_least', field: 'nights', value: 4 },
    ])
  })

  it('returns the rule untouched when it has nothing to tune', () => {
    const alert = templateById('payment-failed-alert')!.rule
    expect(applyParameters(alert, { minimum_nights: 5 })).toBe(alert)
  })
})

describe('shippedParameters', () => {
  it('is the library’s own answer for every tunable rule', () => {
    expect(shippedParameters('review-request-after-stay')).toEqual({
      minimum_nights: 2,
    })
  })

  it('is empty for a rule with no thresholds', () => {
    expect(shippedParameters('task-overdue-alert')).toEqual({})
  })
})
