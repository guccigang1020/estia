/**
 * EXECUTION CONTEXT — SERVER ONLY. What a person can do to an automation.
 *
 * Three operations, and the shape of the list is the argument:
 *
 *   enable         — let this rule act
 *   disable        — stop it acting
 *   setParameters  — change a threshold inside it
 *
 * **There is no create and there is no delete.** The set of rules is the
 * library in `library.ts` — a frozen catalogue whose triggers are members of a
 * frozen event catalogue — and a business chooses among them rather than
 * writing new ones. A rule builder would mean user-authored conditions over
 * user-chosen facts, which is a scripting language nobody can audit and is the
 * thing `types.ts` opens by refusing.
 *
 * There is no delete because `0067_automation_rules.sql` refuses `delete` and
 * `truncate` to every role. Switching a rule off is an UPDATE that leaves a
 * row saying who did it and when; a DELETE would erase the only record that
 * the rule was ever on, which is precisely the record somebody wants after
 * something has gone wrong. An operation added here to do it would be refused
 * by the database, which is why the rule lives there and not only in this file.
 *
 * ── WHAT ENABLING DOES TODAY, SAID PLAINLY ────────────────────────────────
 *
 * It records the decision. It does not start anything: nothing in this
 * deployment feeds `runAutomations` a live event — `(app)/_lib/events.ts`
 * publishes to webhooks and says in its own header that automations are one
 * subscribers entry away and deliberately not turned on — and no performer
 * exists for any of the eight action kinds. So an enabled rule is intent that
 * a runner will read on its first day, and the screen says exactly that in
 * Hebrew rather than letting a switch imply an engine. Storing the intent is
 * still worth doing and it is worth doing first: the alternative is a runner
 * that arrives and has no idea which rules a business wanted.
 *
 * ── The scope is a decision the caller makes, not one inferred ────────────
 *
 * `propertyId` names which state is being written: null is the organization's
 * answer for every property, a property id is that property's own. The two are
 * separate rows and the property one wins wholesale, exactly as 0034 does for
 * the guest journey. It is required to be explicit — there is no "whichever
 * the screen happens to be showing" — because a manager who thinks they are
 * switching a rule off everywhere and is switching it off at one property is
 * the failure this parameter exists to prevent.
 */

import { can, type Actor, type Resource } from '../authz/can'
import { BusinessRuleError, ConflictError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { templateById, type AutomationTemplate } from './library'
import { parameterIssues, parametersFor } from './parameters'
import type { StoredRule } from './state'

const TABLE = 'automation_rules'

/* --------------------------------------------------------------- input --- */

/**
 * Parameters arrive as a list of name/value pairs rather than as an object.
 *
 * `s.object` validates a shape known at definition time, and the parameters a
 * rule accepts are known only once the rule is known — which is after the
 * input has been validated. A pair list is checkable by the existing
 * vocabulary: the name has the identifier shape `0067` enforces on the jsonb
 * key, and the value is a finite number. Which names are legal, and what
 * range each one allows, is the domain law and is checked in `rule()` against
 * the template's own catalogue.
 */
const PARAMETER_LIST = s.arrayOf(
  s.object({
    name: s.string({
      label: 'שם הערך',
      min: 2,
      max: 40,
      pattern: /^[a-z][a-z0-9_]{1,39}$/,
      patternMessage: 'שם הערך אינו בפורמט שהמערכת מכירה.',
    }),
    value: s.number({ label: 'ערך' }),
  }),
  { label: 'ערכים', max: 16 },
)

const TEMPLATE_ID = s.string({
  label: 'כלל',
  min: 3,
  max: 64,
  // The same shape the database enforces on `template_id`. A caller that sends
  // something else is refused here with a sentence rather than at the
  // constraint with a name.
  pattern: /^[a-z][a-z0-9-]{2,63}$/,
  patternMessage: 'מזהה הכלל אינו בפורמט שהמערכת מכירה.',
})

/** Null is the organization, deliberately, and it must be said rather than assumed. */
const PROPERTY_ID = s.optional(s.nullable(s.uuid({ label: 'נכס' })))

const ENABLE_INPUT = s.object({
  templateId: TEMPLATE_ID,
  propertyId: PROPERTY_ID,
  parameters: s.optional(PARAMETER_LIST),
})

const DISABLE_INPUT = s.object({
  templateId: TEMPLATE_ID,
  propertyId: PROPERTY_ID,
})

const SET_PARAMETERS_INPUT = s.object({
  templateId: TEMPLATE_ID,
  propertyId: PROPERTY_ID,
  parameters: PARAMETER_LIST,
})

export interface ParameterPair {
  name: string
  value: number
}

export interface EnableInput {
  templateId: string
  propertyId?: string | null
  parameters?: ParameterPair[]
}

export interface DisableInput {
  templateId: string
  propertyId?: string | null
}

export interface SetParametersInput {
  templateId: string
  propertyId?: string | null
  parameters: ParameterPair[]
}

/* -------------------------------------------------------------- target --- */

/**
 * What the operation is about: a rule in the library, a scope, and the row
 * that exists for the pair — if one does.
 *
 * `stored` being null is not a missing resource. It is the third state
 * `state.ts` names: nobody has decided about this rule yet, and the library's
 * own `enabled` stands. The first enable creates the row; every one after it
 * updates the same one.
 */
export interface RuleTarget {
  template: AutomationTemplate
  propertyId: string | null
  stored: StoredRule | null
}

export interface AutomationWriteResult {
  /** The row that now carries this rule's state. */
  id: string
  enabled: boolean
}

export interface AutomationOperations {
  enable: Operation<EnableInput, RuleTarget, AutomationWriteResult>
  disable: Operation<DisableInput, RuleTarget, AutomationWriteResult>
  setParameters: Operation<
    SetParametersInput,
    RuleTarget,
    AutomationWriteResult
  >
}

export function defineAutomationOperations(options: {
  db: Db
  /** The stored row for one rule and one scope, or null. */
  loadRule: (
    organizationId: string,
    templateId: string,
    propertyId: string | null,
  ) => Promise<StoredRule | null>
}): AutomationOperations {
  /**
   * The library is the authority on which rules exist.
   *
   * A `templateId` the library does not carry returns null, and the pipeline
   * turns that into a 404. Not a stored row pointing at nothing: the database
   * can only check the SHAPE of a library id — it has no way to know the
   * catalogue — and this is the half of that division of labour that lives in
   * the code. See the header of 0067.
   */
  async function loadResource({
    input,
    context,
  }: {
    input: { templateId: string; propertyId?: string | null }
    context: { actor: { organizationId: string } }
  }) {
    const template = templateById(input.templateId)
    if (template === null) return null

    const propertyId = input.propertyId ?? null
    const stored = await options.loadRule(
      context.actor.organizationId,
      input.templateId,
      propertyId,
    )

    const resource: Resource = {
      organizationId: context.actor.organizationId,
    }
    // Only set when there is one. An undefined `propertyId` on the resource
    // means "the organization", and a null would be a property nobody has.
    if (propertyId !== null) resource.propertyId = propertyId

    return {
      resource,
      entity: { template, propertyId, stored } satisfies RuleTarget,
      // Undefined rather than null for a rule nobody has configured: the
      // pipeline compares `expectedVersion` against this, and a caller
      // enabling a rule for the first time has no version to send.
      version: stored?.version,
    }
  }

  /* ------------------------------------------------------------- writing -- */

  async function write(args: {
    db: Db
    actor: { organizationId: string }
    target: RuleTarget
    enabled: boolean
    parameters: Readonly<Record<string, number>>
  }): Promise<AutomationWriteResult> {
    const { db, actor, target, enabled, parameters } = args

    if (target.stored !== null) {
      const { error } = await db
        .from(TABLE)
        .update({ enabled, parameters })
        .eq('organization_id', actor.organizationId)
        .eq('id', target.stored.id)

      if (error) throw error
      return { id: target.stored.id, enabled }
    }

    const { data, error } = await db
      .from(TABLE)
      .insert({
        organization_id: actor.organizationId,
        property_id: target.propertyId,
        template_id: target.template.rule.id,
        enabled,
        parameters,
        // `enabled_at`, `enabled_by`, `created_by` and `updated_by` are the
        // trigger's, taken from the session. Sending them would be sending
        // something that is about to be overwritten, and offering a caller a
        // field that says who did this is offering them a way to say it was
        // somebody else.
      })
      .select('id')
      .single()

    if (error) {
      // 23505 on this table means one of the two partial unique indexes: a row
      // for this rule and this scope appeared between the read and the write.
      // That is somebody else switching the same rule at the same moment, and
      // it is a conflict rather than a validation failure — retrying blind
      // would overwrite whatever they just decided.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError({
          resourceType: 'automation_rule',
          resourceId: target.template.rule.id,
          userMessage:
            'מישהו אחר שינה את הכלל הזה באותו רגע. רענן את המסך כדי לראות את המצב הנוכחי ובצע את השינוי מחדש.',
          cause: error,
        })
      }
      throw error
    }

    return { id: String((data as { id: string }).id), enabled }
  }

  /**
   * The numbers this write will store: what the row already had, then what the
   * caller said.
   *
   * A caller that mentions one parameter changes one parameter. Replacing the
   * whole set would mean a screen with a single field silently resetting every
   * other threshold to its shipped value the first time somebody used it.
   */
  function merge(
    target: RuleTarget,
    pairs: readonly ParameterPair[] | undefined,
  ): Readonly<Record<string, number>> {
    const merged: Record<string, number> = {
      ...(target.stored?.parameters ?? {}),
    }
    for (const pair of pairs ?? []) merged[pair.name] = pair.value
    return merged
  }

  /**
   * The domain law for a proposed parameter set.
   *
   * Everything wrong at once, in Hebrew, naming the parameter and its bounds.
   * A rule that declares no parameters refuses any parameter at all rather
   * than storing one nothing will ever read.
   */
  function assertParameters(
    target: RuleTarget,
    pairs: readonly ParameterPair[] | undefined,
  ): void {
    if (!pairs || pairs.length === 0) return

    const templateId = target.template.rule.id
    if (parametersFor(templateId).length === 0) {
      throw new BusinessRuleError({
        code: 'automation_rule_has_no_parameters',
        message: `rule ${templateId} declares no parameters`,
        userMessage: `לכלל ״${target.template.rule.name}״ אין ערכים להתאמה — הוא פועל בכל פעם שהאירוע קורה, בלי סף.`,
      })
    }

    const values: Record<string, number> = {}
    for (const pair of pairs) values[pair.name] = pair.value

    const issues = parameterIssues(templateId, values)
    if (issues.length > 0) {
      throw new BusinessRuleError({
        code: 'automation_parameter_rejected',
        message: `rule ${templateId}: ${issues
          .map((issue) => `${issue.key} ${issue.reason}`)
          .join('; ')}`,
        userMessage: issues.map((issue) => issue.message).join(' '),
        publicDetails: { parameters: issues.map((issue) => issue.key) },
      })
    }
  }

  /** Hebrew for which scope a change was made in. Used by every audit summary. */
  function scopeLabel(target: RuleTarget): string {
    return target.propertyId === null ? 'בכל הנכסים' : 'בנכס אחד'
  }

  /* ------------------------------------------------------------ enabling -- */

  const enable = defineOperation<
    EnableInput,
    RuleTarget,
    AutomationWriteResult
  >({
    name: 'automation.enable',
    permission: 'automation.manage',
    resourceType: 'automation_rule',
    input: ENABLE_INPUT,
    loadResource,

    rule({ input, entity }) {
      assertParameters(entity, input.parameters)
    },

    async execute({ input, context, entity, tx }) {
      return write({
        db: clientFor(tx, options.db),
        actor: context.actor,
        target: entity,
        enabled: true,
        parameters: merge(entity, input.parameters),
      })
    },

    audit({ entity, result }) {
      return {
        resourceId: result.id,
        propertyId: entity.propertyId,
        // Says what the rule will now do, not that a boolean moved. The
        // manager reading this timeline in three months wants to know that
        // guests started receiving messages, and when.
        summary: `הפעיל את הכלל ״${entity.template.rule.name}״ ${scopeLabel(entity)}. מעכשיו: ${entity.template.rule.description}`,
        before: {
          enabled: entity.stored?.enabled ?? entity.template.rule.enabled,
        },
        after: { enabled: true },
      }
    },
  })

  /* ----------------------------------------------------------- disabling -- */

  const disable = defineOperation<
    DisableInput,
    RuleTarget,
    AutomationWriteResult
  >({
    name: 'automation.disable',
    permission: 'automation.manage',
    resourceType: 'automation_rule',
    input: DISABLE_INPUT,
    loadResource,

    async execute({ context, entity, tx }) {
      return write({
        db: clientFor(tx, options.db),
        actor: context.actor,
        target: entity,
        enabled: false,
        // Kept, not cleared. Somebody switching a rule off for a fortnight and
        // back on again should find their threshold where they left it.
        parameters: entity.stored?.parameters ?? {},
      })
    },

    audit({ entity, result }) {
      return {
        resourceId: result.id,
        propertyId: entity.propertyId,
        summary: `כיבה את הכלל ״${entity.template.rule.name}״ ${scopeLabel(entity)}. מעכשיו הפעולה הזאת לא תתבצע מעצמה.`,
        before: {
          enabled: entity.stored?.enabled ?? entity.template.rule.enabled,
        },
        after: { enabled: false },
      }
    },
  })

  /* ---------------------------------------------------------- parameters -- */

  const setParameters = defineOperation<
    SetParametersInput,
    RuleTarget,
    AutomationWriteResult
  >({
    name: 'automation.set_parameters',
    permission: 'automation.manage',
    resourceType: 'automation_rule',
    input: SET_PARAMETERS_INPUT,
    loadResource,

    rule({ input, entity }) {
      if (input.parameters.length === 0) {
        throw new BusinessRuleError({
          code: 'automation_parameters_empty',
          message: 'no parameters supplied',
          userMessage: 'לא נשלח שום ערך לשינוי.',
        })
      }
      assertParameters(entity, input.parameters)
    },

    async execute({ input, context, entity, tx }) {
      return write({
        db: clientFor(tx, options.db),
        actor: context.actor,
        target: entity,
        // Changing a threshold does not switch a rule on. A row that does not
        // exist yet is created carrying the library's own answer, so the
        // effective state is exactly what it was a moment ago.
        enabled: entity.stored?.enabled ?? entity.template.rule.enabled,
        parameters: merge(entity, input.parameters),
      })
    },

    audit({ input, entity, result }) {
      const changes = input.parameters
        .map((pair) => {
          const parameter = parametersFor(entity.template.rule.id).find(
            (candidate) => candidate.key === pair.name,
          )
          return `${parameter?.label ?? pair.name}: ${pair.value}${
            parameter?.unit ? ` ${parameter.unit}` : ''
          }`
        })
        .join(', ')

      return {
        resourceId: result.id,
        propertyId: entity.propertyId,
        summary: `שינה את הסף של הכלל ״${entity.template.rule.name}״ ${scopeLabel(entity)} — ${changes}.`,
        before: { parameters: entity.stored?.parameters ?? {} },
        after: { parameters: changes },
      }
    },
  })

  return { enable, disable, setParameters }
}

/**
 * May this person switch automations on at all?
 *
 * Exported so a screen can decide whether to render a control rather than
 * offering one that will be refused. It asks the same question the operations
 * ask — `assertCan` with the same grant — so the answer cannot drift from what
 * the pipeline will decide a moment later.
 */
export function mayManageAutomation(
  actor: Actor,
  propertyId: string | null,
): boolean {
  const resource: Resource = { organizationId: actor.organizationId }
  if (propertyId !== null) resource.propertyId = propertyId
  return can(actor, 'automation.manage', resource)
}
