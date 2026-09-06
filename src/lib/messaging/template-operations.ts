/**
 * EXECUTION CONTEXT — SERVER ONLY. Saving and removing a business's wording.
 *
 * ══ VALIDATION RUNS HERE, ON THE SERVER, ALWAYS ═════════════════════════════
 *
 * `validateTemplate` also runs in the editor so somebody sees a red line while
 * they are still typing. That is a courtesy. **This is the check that counts**,
 * because the editor can be bypassed and the database cannot enforce the rule:
 * the list of placeholders is a property of `compose.ts`, and a CHECK
 * constraint copying it would go stale the first time a placeholder is added.
 *
 * `0071_message_templates.sql` says so in its own header rather than leaving a
 * reader to assume the database is guarding this. It guards what a constraint
 * can hold honestly — not blank, not longer than SMS billing makes reasonable,
 * a guest channel or none — and no more.
 *
 * ══ DELETE IS THE CORRECT AFFORDANCE HERE, AND ONLY HERE ════════════════════
 *
 * `guest_reviews` and `conversation_messages` refuse `delete` to every role,
 * because they are records of what happened. A template is a SETTING. Removing
 * one restores the built-in Hebrew — so deletion is safe, reversible in
 * effect, and the honest thing to offer. A business that had to keep every
 * draft it ever wrote would end up with a screen it cannot read.
 */

import { BusinessRuleError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { validateTemplate, type TemplateProblem } from './templates'
import type { MessageTemplate } from './template-repository'
import { GUEST_MESSAGE_KINDS, GUEST_CHANNELS } from './types'

const TABLE = 'message_templates'

const SAVE_INPUT = s.object({
  kind: s.enumOf(GUEST_MESSAGE_KINDS, { label: 'סוג ההודעה' }),
  channel: s.nullable(s.enumOf(GUEST_CHANNELS, { label: 'ערוץ' })),
  subject: s.nullable(s.string({ label: 'נושא', max: 200 })),
  body: s.string({ label: 'הנוסח', min: 1, max: 1500 }),
  isActive: s.boolean({ label: 'פעיל' }),
})

const REMOVE_INPUT = s.object({ templateId: s.uuid({ label: 'תבנית' }) })

/** The refusal a person reads, with the offending token named. */
function problemMessage(problems: readonly TemplateProblem[]): string {
  const first = problems[0]
  if (first === undefined) return 'הנוסח אינו תקין.'

  if (first.kind === 'unknown_placeholder') {
    return `אין במוצר שדה בשם {{${first.token}}}. אורח שיקבל את ההודעה יראה את הסוגריים כפי שהם — לכן זה נדחה עכשיו ולא בזמן השליחה.`
  }
  if (first.kind === 'wrong_kind') {
    return `השדה {{${first.token}}} אינו זמין בסוג ההודעה הזה.`
  }
  if (first.kind === 'too_long') {
    return `הנוסח ארוך מדי (${first.length} תווים). SMS מחויב לפי 70 תווים בעברית.`
  }
  return 'הנוסח ריק.'
}

export interface MessageTemplateOperations {
  save: Operation<
    {
      kind: (typeof GUEST_MESSAGE_KINDS)[number]
      channel: (typeof GUEST_CHANNELS)[number] | null
      subject: string | null
      body: string
      isActive: boolean
    },
    null,
    { id: string }
  >
  remove: Operation<{ templateId: string }, MessageTemplate, { id: string }>
}

export function defineMessageTemplateOperations(options: {
  db: Db
  loadTemplate: (
    organizationId: string,
    id: string,
  ) => Promise<MessageTemplate | null>
}): MessageTemplateOperations {
  const save = defineOperation<
    {
      kind: (typeof GUEST_MESSAGE_KINDS)[number]
      channel: (typeof GUEST_CHANNELS)[number] | null
      subject: string | null
      body: string
      isActive: boolean
    },
    null,
    { id: string }
  >({
    name: 'message_template.save',
    permission: 'template.manage',
    resourceType: 'message_template',
    input: SAVE_INPUT,

    rule({ input }) {
      const problems = validateTemplate(input.kind, input.body)
      if (problems.length > 0) {
        throw new BusinessRuleError({
          code: 'template_invalid',
          message: `template for ${input.kind} is invalid: ${problems
            .map((p) => p.kind)
            .join(', ')}`,
          userMessage: problemMessage(problems),
        })
      }

      // A subject is only ever rendered for email. Storing one on a WhatsApp
      // template would put a field in the screen that never reaches anybody.
      if (
        input.subject !== null &&
        input.channel !== null &&
        input.channel !== 'email'
      ) {
        throw new BusinessRuleError({
          code: 'template_subject_not_used',
          message: `a subject was given for channel ${input.channel}`,
          userMessage:
            'שורת נושא נשלחת רק בדוא״ל. בערוץ הזה היא לא תגיע לאף אחד — השאירו אותה ריקה.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      // Upsert on the same key the unique index uses, so saving twice edits
      // one row rather than colliding. `NULLS NOT DISTINCT` on that index is
      // what makes the "all channels" row addressable at all.
      const { data, error } = await db
        .from(TABLE)
        .upsert(
          {
            organization_id: context.actor.organizationId,
            kind: input.kind,
            channel: input.channel,
            subject: input.subject,
            body: input.body,
            is_active: input.isActive,
            updated_by: context.actor.userId,
            created_by: context.actor.userId,
          },
          { onConflict: 'organization_id,kind,channel' },
        )
        .select('id')
        .single()

      if (error) throw error
      return { id: String((data as { id: string }).id) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary: `שמר נוסח הודעה מסוג ${input.kind}${
          input.channel === null ? ' לכל הערוצים' : ` לערוץ ${input.channel}`
        }.`,
        // The body is the change, and it is a business's own words about its
        // own guests — not a secret, and worth being able to see who changed.
        after: { body: input.body, isActive: input.isActive },
      }
    },
  })

  const remove = defineOperation<
    { templateId: string },
    MessageTemplate,
    { id: string }
  >({
    name: 'message_template.remove',
    permission: 'template.manage',
    resourceType: 'message_template',
    input: REMOVE_INPUT,

    async loadResource({ input, context }) {
      const template = await options.loadTemplate(
        context.actor.organizationId,
        input.templateId,
      )
      if (template === null) return null
      return {
        resource: { organizationId: context.actor.organizationId },
        entity: template,
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const { error } = await db
        .from(TABLE)
        .delete()
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.templateId)

      if (error) throw error
      return { id: input.templateId }
    },

    audit({ entity }) {
      return {
        resourceId: entity.id,
        summary: `מחק נוסח הודעה מסוג ${entity.kind}. ההודעות חוזרות לנוסח ברירת המחדל.`,
        before: { body: entity.body },
      }
    },
  })

  return { save, remove }
}
