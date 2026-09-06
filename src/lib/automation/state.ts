/**
 * Which rules this organization actually has, once its own decisions are laid
 * over the ones ESTIA ships.
 *
 * ── THREE STATES, NOT TWO ─────────────────────────────────────────────────
 *
 * The single most important thing in this file is that **an absent row is not
 * a disabled rule**. There are three answers to "is this on":
 *
 *   · no row        — nobody has decided; the library's own `enabled` stands
 *   · a row, off    — somebody switched it off, and the row says who and when
 *   · a row, on     — somebody switched it on, and the row says who and when
 *
 * Collapsing the first into the second would switch off the five rules the
 * library ships ON — the failed-payment alert, the overdue-task alert, the
 * channel-sync alert — for every organization that has never opened the
 * automation screen. Those are exactly the rules a business would never think
 * to go and enable, and they are on by default because being wrong about them
 * costs nothing while missing them costs a double booking.
 *
 * ── The property row wins, wholesale ──────────────────────────────────────
 *
 * A rule may be configured for the organization and again for one property.
 * The property row REPLACES the organization row rather than merging with it,
 * for the reason `guest_journey_settings` gives in 0034: a half-inherited
 * policy is one nobody can predict from the screen. `RuleSource` says which of
 * the three answered, so a card can state it in words instead of leaving a
 * manager to guess why the same rule reads differently on two properties.
 *
 * PURE. Rows in, rules out. The reads live in `repository.ts`.
 */

import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './library'
import { applyParameters, shippedParameters } from './parameters'
import type { AutomationRule } from './types'

/** One row of `automation_rules`, as the application reads it. */
export interface StoredRule {
  id: string
  templateId: string
  /** Null is the organization-wide state, not a missing value. */
  propertyId: string | null
  enabled: boolean
  parameters: Readonly<Record<string, number>>
  enabledAt: string | null
  enabledBy: string | null
  disabledAt: string | null
  updatedAt: string
  version: number
}

export type RuleSource =
  /** No row. The library's decision, unchanged. */
  | 'shipped'
  /** The organization decided, for every property. */
  | 'organization'
  /** This property decided for itself, overriding the organization. */
  | 'property'

export interface ResolvedRule {
  template: AutomationTemplate
  /** The rule as it would run here: parameters applied, `enabled` resolved. */
  rule: AutomationRule
  source: RuleSource
  /** The row that decided it, or null when the library did. */
  stored: StoredRule | null
  /** The effective numbers, whatever decided them. */
  parameters: Readonly<Record<string, number>>
  /**
   * Properties that have overridden this rule for themselves.
   *
   * Carried even when the screen is looking at one property, because "this is
   * set differently at three of your properties" is the sentence that stops
   * somebody switching a rule off at the organization level and wondering why
   * two properties kept sending messages.
   */
  overriddenAtProperties: readonly string[]
}

/**
 * Lay the stored rows over the library.
 *
 * `propertyId` is what the reader is looking at: a property, or null for the
 * organization-wide view. In the organization view, property rows are not
 * applied — they are reported through `overriddenAtProperties` — because
 * showing one property's override as though it were the organization's answer
 * would be the same lie in the other direction.
 */
export function resolveRules(
  stored: readonly StoredRule[],
  propertyId: string | null,
): readonly ResolvedRule[] {
  const organizationRows = new Map<string, StoredRule>()
  const propertyRows = new Map<string, StoredRule>()
  const overrides = new Map<string, string[]>()

  for (const row of stored) {
    if (row.propertyId === null) {
      organizationRows.set(row.templateId, row)
      continue
    }

    const seen = overrides.get(row.templateId)
    if (seen) seen.push(row.propertyId)
    else overrides.set(row.templateId, [row.propertyId])

    if (row.propertyId === propertyId) propertyRows.set(row.templateId, row)
  }

  return AUTOMATION_TEMPLATES.map((template) =>
    resolveOne(
      template,
      propertyRows.get(template.rule.id) ?? null,
      organizationRows.get(template.rule.id) ?? null,
      overrides.get(template.rule.id) ?? [],
    ),
  )
}

function resolveOne(
  template: AutomationTemplate,
  propertyRow: StoredRule | null,
  organizationRow: StoredRule | null,
  overriddenAtProperties: readonly string[],
): ResolvedRule {
  const decided = propertyRow ?? organizationRow
  const source: RuleSource = propertyRow
    ? 'property'
    : organizationRow
      ? 'organization'
      : 'shipped'

  // The shipped numbers are the base even when a row exists: a row written
  // before a parameter was added carries nothing for it, and falling back to
  // the library is the difference between "the new threshold is its default"
  // and "the new threshold is zero".
  const parameters = {
    ...shippedParameters(template.rule.id),
    ...(decided?.parameters ?? {}),
  }

  const rule = applyParameters(
    decided === null
      ? template.rule
      : { ...template.rule, enabled: decided.enabled },
    parameters,
  )

  return {
    template,
    rule,
    source,
    stored: decided,
    parameters,
    overriddenAtProperties,
  }
}

/** The rules that would run here, for the engine and the dry run. */
export function effectiveRules(
  resolved: readonly ResolvedRule[],
): readonly AutomationRule[] {
  return resolved.map((entry) => entry.rule)
}

/**
 * Hebrew for where a rule's state came from.
 *
 * Written as a full clause rather than a badge word, because "ברירת מחדל" on
 * its own reads as "nothing has been configured" for both `shipped` and a row
 * that happens to match the shipped value, and those are different facts.
 */
export const RULE_SOURCE_LABEL: Record<RuleSource, string> = {
  shipped: 'כפי שהמערכת מגיעה — איש עדיין לא שינה את הכלל הזה',
  organization: 'הוגדר בארגון, לכל הנכסים',
  property: 'הוגדר לנכס הזה בנפרד, ומחליף את ההגדרה של הארגון',
}
