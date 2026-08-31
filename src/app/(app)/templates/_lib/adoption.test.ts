/**
 * The adoption path, which is the templates screen's whole answer to "would
 * this do anything for me".
 *
 * The assertions worth having here are about wording as much as about state.
 * A `false` on the permission step under a plan lock would tell somebody to go
 * and get a grant they already hold; a `false` on the adoption step would
 * accuse them of failing a check nobody set. Both are asserted as `null`,
 * because "the product cannot answer this yet" is a third state and the screen
 * renders it as one.
 */

import { describe, expect, it } from 'vitest'

import {
  AUTOMATION_TEMPLATES,
  ruleReadiness,
  templateById,
  type AutomationTemplate,
} from '@/lib/automation'
import type { Actor } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import type { Entitlement } from '@/lib/plans/entitlements'

import { adoptionSteps } from './adoption'

const ORGANIZATION = '00000000-0000-4000-8000-000000000001'

function actor(grants: readonly Grant[], entitlements: Entitlement[]): Actor {
  return {
    userId: 'user-1',
    organizationId: ORGANIZATION,
    membershipStatus: 'active',
    grants: new Set(grants),
    scope: { kind: 'all_organization' },
    entitlements: new Set(entitlements),
  }
}

function template(id: string): AutomationTemplate {
  const found = templateById(id)
  if (!found) throw new Error(`No template '${id}'`)
  return found
}

function stepsFor(id: string, reader: Actor): ReturnType<typeof adoptionSteps> {
  const entry = template(id)
  return adoptionSteps(entry, ruleReadiness(reader, entry.rule))
}

describe('adoptionSteps', () => {
  it('always answers the same four questions in the same order', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      const steps = adoptionSteps(
        entry,
        ruleReadiness(actor(['automation.view'], ['core']), entry.rule),
      )
      expect(steps).toHaveLength(4)
      expect(steps.map((step) => step.title)).toEqual([
        'החבילה כוללת אוטומציות',
        'התפקיד שלך מרשה את הפעולות',
        'האירוע נושא את הנתונים שהתנאי בודק',
        'העתקת הכלל לארגון',
      ])
    }
  })

  it('does not ask the permission question while the package answer is no', () => {
    const steps = stepsFor(
      'confirmed-notify-and-prepare',
      // Every grant the rule needs, and no automation module.
      actor(
        ['automation.view', 'message.send', 'task.create'],
        ['core', 'operations'],
      ),
    )

    expect(steps[0].met).toBe(false)
    expect(steps[0].detail).toContain('אינה שאלה של הרשאה')
    // `null`, not `false`. The reader holds every grant; telling them a
    // permission check failed would send them to an administrator.
    expect(steps[1].met).toBeNull()
  })

  it('names the missing permissions in Hebrew once the package is right', () => {
    const steps = stepsFor(
      'confirmed-notify-and-prepare',
      actor(
        ['automation.view', 'message.send'],
        ['core', 'automation', 'operations'],
      ),
    )

    expect(steps[0].met).toBe(true)
    expect(steps[1].met).toBe(false)
    expect(steps[1].detail).toContain('פתיחת משימות')
    expect(steps[1].detail).not.toContain('task.create')
  })

  it('reads a rule with no IF clause as needing no fact', () => {
    const steps = stepsFor(
      'payment-failed-alert',
      actor(['automation.view', 'message.send'], ['core', 'automation']),
    )

    expect(steps[2].met).toBe(true)
    expect(steps[2].detail).toContain('אין תנאי מסנן')
  })

  it('names the fact a condition depends on, and does not pretend to check it', () => {
    const steps = stepsFor(
      'review-request-after-stay',
      actor(['automation.view', 'message.send'], ['core', 'automation']),
    )

    // The facts an event carries are a property of the event, not of this
    // reader, so this step is a statement rather than a verdict.
    expect(steps[2].met).toBeNull()
    expect(steps[2].detail).toContain('מספר הלילות')
  })

  it('never claims the copy step succeeded or failed, because there is no storage', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      const steps = adoptionSteps(
        entry,
        ruleReadiness(
          actor(
            [
              'automation.view',
              'message.send',
              'task.create',
              'approval.request',
              'payment.request_link',
              'invoice.issue',
              'hold.create',
            ],
            [
              'core',
              'automation',
              'operations',
              'payments',
              'invoicing',
              'approvals',
            ],
          ),
          entry.rule,
        ),
      )
      expect(steps[3].met).toBeNull()
      expect(steps[3].detail).toContain('אינה קיימת במוצר')
    }
  })
})
