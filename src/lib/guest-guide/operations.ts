/**
 * EXECUTION CONTEXT — SERVER ONLY. Every write this module performs.
 *
 * Each one is a `defineOperation`, so each goes through authorization →
 * validation → domain rule → transaction → audit event → idempotency in that
 * order, with no way for a caller to reorder or skip a step. An `insert` from
 * a route handler would look identical to a person and skip all six.
 *
 * The audit event matters more here than in most modules. `setEntrySecret`
 * changes a door code, and "who changed the code, when, and why the guest who
 * arrived at 22:00 could not get in" is a question somebody will ask at 22:15.
 * The operation's `after` deliberately records that a secret was set and never
 * what it was set to — an audit row is read by more people than the secret is.
 *
 * ── Which grant ──────────────────────────────────────────────────────────
 *
 * `property.update` today, from the existing catalogue, and it is the honest
 * fit: a property's guide is part of that property's configuration and the
 * person who maintains one is the person who maintains the other. The website
 * module's `site.*` family was considered and rejected — those grants are
 * about a public marketing site and are held by a copywriter, who has no
 * business holding a door code.
 *
 * `GUIDE_GRANTS` below is the one place the choice is written down, so moving
 * to the `guide.*` family this module's report asks for is a change to four
 * lines rather than a search. The report explains why the split matters:
 * `guide.reveal_sensitive` is a genuinely different amount of authority from
 * "may edit the pool hours", and it belongs in `SENSITIVE_ACTIONS`.
 *
 * ── The events ───────────────────────────────────────────────────────────
 *
 * None. `src/lib/contracts/events.ts` is frozen and carries no name for a
 * guide being published; `site.published` is the website's and would be a lie
 * in a subscriber's filter. Following the website module's own reasoning, an
 * edit to a draft is not something anything should react to and needs no
 * event — but a publish is, and that name does not exist. The gap is in the
 * report with the three names this module needs; nothing here invents one.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError, NotFoundError } from '../errors'
import { clientFor, toRow, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import type { Grant } from '../authz/permissions'
import {
  recommendationFromForm,
  type RecommendationDraft,
} from './recommendations'
import { GuestGuideRepository } from './repository'
import {
  GUIDE_ICONS,
  GUIDE_LANGUAGES,
  GUIDE_RELEASE_MODES,
  GUIDE_STAGES,
  GUIDE_TOPICS,
  MAX_RELEASE_HOURS,
  RECOMMENDATION_CATEGORIES,
  buildGuideSnapshot,
  isSafeUrl,
  type Guide,
  type GuideLanguage,
  type LocalizedText,
} from './types'

/**
 * The grants these operations check.
 *
 * One object rather than four string literals, because the report asks for a
 * dedicated family and the swap should be a diff a reviewer can read in one
 * screen. `reveal` is named separately even though it holds the same value
 * today: it is the one that will change first.
 */
export const GUIDE_GRANTS: Readonly<{
  view: Grant
  edit: Grant
  reveal: Grant
  publish: Grant
}> = Object.freeze({
  view: 'property.view',
  edit: 'property.update',
  reveal: 'property.update',
  publish: 'property.update',
})

/* ------------------------------------------------------------- schemas -- */

/**
 * Localised text as a form posts it.
 *
 * Hebrew is `min: 1` and required; every other language is optional. That is
 * `LocalizedText`'s intersection expressed at the boundary, so a submission
 * with only an English body is refused with a field issue on `he` rather than
 * being stored and discovered by a guest.
 */
const LOCALIZED = s.object({
  he: s.string({ label: 'עברית', min: 1, max: 4000 }),
  en: s.optional(s.string({ label: 'אנגלית', max: 4000 })),
  ar: s.optional(s.string({ label: 'ערבית', max: 4000 })),
  ru: s.optional(s.string({ label: 'רוסית', max: 4000 })),
  fr: s.optional(s.string({ label: 'צרפתית', max: 4000 })),
})

const URL_FIELD = s.refine(s.string({ label: 'כתובת', max: 2000 }), isSafeUrl, {
  code: 'unsafe_url',
  message:
    'כתובת חייבת להתחיל ב-https:// או להיות נתיב פנימי. כתובות javascript: ו-data: אינן מתקבלות.',
})

const ENTRY_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  entryId: s.nullable(s.uuid({ label: 'ערך קיים' })),
  stage: s.enumOf(GUIDE_STAGES, { label: 'שלב' }),
  topic: s.enumOf(GUIDE_TOPICS, { label: 'נושא' }),
  title: LOCALIZED,
  body: s.nullable(LOCALIZED),
  icon: s.nullable(s.enumOf(GUIDE_ICONS, { label: 'אייקון' })),
  linkUrl: s.nullable(URL_FIELD),
  linkLabel: s.nullable(LOCALIZED),
  sortOrder: s.number({ label: 'סדר', integer: true, min: 0, max: 999 }),
  isActive: s.boolean({ label: 'פעיל' }),
  /** Declares that a secret belongs here. Does not carry one. */
  hasSecret: s.boolean({ label: 'מכיל קוד או סוד' }),
  releaseMode: s.enumOf(GUIDE_RELEASE_MODES, { label: 'מתי נחשף' }),
  releaseHours: s.number({
    label: 'שעות לפני הכניסה',
    integer: true,
    min: 0,
    max: MAX_RELEASE_HOURS,
  }),
})

/**
 * The secret's own input, and it is its own operation.
 *
 * Separate from `ENTRY_INPUT` on purpose. If a door code were one field on the
 * entry form, every ordinary edit to the pool hours would carry the code
 * through the request, through validation, into an audit diff and into
 * whatever logs the request. It is a different form, a different grant and a
 * different audit line.
 */
const SECRET_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  entryId: s.uuid({ label: 'ערך' }),
  /** `null` clears it. There is no "leave unchanged" — that is not editing. */
  value: s.nullable(LOCALIZED),
})

const RECOMMENDATION_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  category: s.enumOf(RECOMMENDATION_CATEGORIES, { label: 'קטגוריה' }),
  name: LOCALIZED,
  description: s.nullable(LOCALIZED),
  address: s.nullable(LOCALIZED),
  phone: s.nullable(s.string({ label: 'טלפון', max: 40 })),
  url: s.nullable(URL_FIELD),
  minutesAway: s.nullable(
    s.number({ label: 'דקות נסיעה', integer: true, min: 0, max: 600 }),
  ),
  /**
   * WHERE THIS CAME FROM. §44, at the boundary.
   *
   * `named` demands a name; `business` is stamped with the actor's own user id
   * in `execute` and the client cannot choose whose recommendation it is.
   * There is no third member, so a form cannot post one.
   */
  sourceKind: s.enumOf(['business', 'named'] as const, { label: 'מקור' }),
  sourceName: s.nullable(s.string({ label: 'שם המקור', max: 200 })),
  sourceUrl: s.nullable(URL_FIELD),
  sortOrder: s.number({ label: 'סדר', integer: true, min: 0, max: 999 }),
})

const PUBLISH_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  label: s.nullable(s.string({ label: 'שם הגרסה', max: 60 })),
  languages: s.arrayOf(s.enumOf(GUIDE_LANGUAGES, { label: 'שפה' }), {
    label: 'שפות',
    min: 1,
    max: GUIDE_LANGUAGES.length,
  }),
})

/* --------------------------------------------------------------- types -- */

export type EntryDraft = {
  propertyId: string
  entryId: string | null
  stage: (typeof GUIDE_STAGES)[number]
  topic: (typeof GUIDE_TOPICS)[number]
  title: LocalizedText
  body: LocalizedText | null
  icon: (typeof GUIDE_ICONS)[number] | null
  linkUrl: string | null
  linkLabel: LocalizedText | null
  sortOrder: number
  isActive: boolean
  hasSecret: boolean
  releaseMode: (typeof GUIDE_RELEASE_MODES)[number]
  releaseHours: number
}

export type SecretDraft = {
  propertyId: string
  entryId: string
  value: LocalizedText | null
}

export type RecommendationInput = {
  propertyId: string
  category: (typeof RECOMMENDATION_CATEGORIES)[number]
  name: LocalizedText
  description: LocalizedText | null
  address: LocalizedText | null
  phone: string | null
  url: string | null
  minutesAway: number | null
  sourceKind: 'business' | 'named'
  sourceName: string | null
  sourceUrl: string | null
  sortOrder: number
}

export type PublishInput = {
  propertyId: string
  label: string | null
  languages: readonly (typeof GUIDE_LANGUAGES)[number][]
}

export type PublishedGuide = {
  guideId: string
  versionId: string
  versionNumber: number
  entryCount: number
  recommendationCount: number
}

export interface GuestGuideOperations {
  saveEntry: Operation<EntryDraft, null, { id: string; topic: string }>
  setEntrySecret: Operation<
    SecretDraft,
    null,
    { entryId: string; set: boolean }
  >
  addRecommendation: Operation<RecommendationInput, null, { id: string }>
  publishGuide: Operation<PublishInput, Guide, PublishedGuide>
}

/* ---------------------------------------------------------- operations -- */

export function defineGuestGuideOperations(options: {
  db: Db
}): GuestGuideOperations {
  const repository = new GuestGuideRepository(options.db)

  /**
   * The guide row for a property, created on first write.
   *
   * A property acquires a guide the first time somebody writes an entry into
   * it, which is why this is here rather than being a `createGuide` operation
   * an operator has to find. It runs inside the caller's transaction, so a
   * failed entry write does not leave an empty guide behind.
   */
  async function guideIdFor(
    db: Db,
    organizationId: string,
    propertyId: string,
    userId: string | null,
  ): Promise<string> {
    // Read through the transaction's client rather than the repository's, so
    // two concurrent first writes see each other. The unique index on
    // `(organization_id, property_id)` is the floor beneath this.
    const { data: found, error: findError } = await db
      .from('property_guides')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (findError) throw findError
    if (found !== null) return asId(found)

    const { data, error } = await db
      .from('property_guides')
      .insert({
        organization_id: organizationId,
        property_id: propertyId,
        status: 'draft',
        languages: ['he'],
        published_version_id: null,
        published_at: null,
        published_by: null,
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select('id')
      .single()

    if (error) throw error
    return asId(data)
  }

  /* ------------------------------------------------------------ entry -- */

  const saveEntry = defineOperation<
    EntryDraft,
    null,
    { id: string; topic: string }
  >({
    name: 'guide.entry.save',
    permission: GUIDE_GRANTS.edit,
    resourceType: 'guide_entry',
    input: ENTRY_INPUT,

    rule({ input, context }) {
      // The property, not just the organization. A manager scoped to the
      // Carmel flat may not write the Galilee villa's door instructions.
      assertCan(context.actor, GUIDE_GRANTS.edit, {
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId,
      })

      // A link with no label is a link a guest is asked to trust blind.
      if (input.linkUrl !== null && input.linkLabel === null) {
        throw new BusinessRuleError({
          code: 'guide_link_unlabelled',
          userMessage: 'לקישור חיצוני צריך גם טקסט שמסביר לאן הוא מוביל.',
        })
      }
      if (input.linkUrl === null && input.linkLabel !== null) {
        throw new BusinessRuleError({
          code: 'guide_link_missing_url',
          userMessage: 'יש טקסט לקישור אבל אין כתובת.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId
      const guideId = await guideIdFor(
        db,
        organizationId,
        input.propertyId,
        context.actor.userId,
      )

      const row = {
        organization_id: organizationId,
        guide_id: guideId,
        property_id: input.propertyId,
        stage: input.stage,
        topic: input.topic,
        title: input.title,
        body: input.body,
        icon: input.icon,
        link_url: input.linkUrl,
        link_label: input.linkLabel,
        sort_order: input.sortOrder,
        is_active: input.isActive,
        has_secret: input.hasSecret,
        release_mode: input.releaseMode,
        release_hours: input.releaseHours,
        updated_by: context.actor.userId,
      }

      if (input.entryId === null) {
        const { data, error } = await db
          .from('guide_entries')
          .insert({ ...row, version: 1, created_by: context.actor.userId })
          .select('id, topic')
          .single()

        if (error) throw error
        return { id: asId(data), topic: input.topic }
      }

      const { data, error } = await db
        .from('guide_entries')
        .update(row)
        .eq('id', input.entryId)
        .eq('organization_id', organizationId)
        .select('id, topic')
        .single()

      if (error) throw error
      if (data === null) {
        throw new NotFoundError('guide_entry', input.entryId)
      }
      return { id: asId(data), topic: input.topic }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        propertyId: input.propertyId,
        summary:
          `${input.entryId === null ? 'הוסיף' : 'עדכן'} ערך במדריך הנכס ` +
          `בנושא ${input.topic}, שלב ${input.stage}.`,
        after: {
          topic: input.topic,
          stage: input.stage,
          isActive: input.isActive,
          hasSecret: input.hasSecret,
          releaseMode: input.releaseMode,
        },
      }
    },
  })

  /* ----------------------------------------------------------- secret -- */

  const setEntrySecret = defineOperation<
    SecretDraft,
    null,
    { entryId: string; set: boolean }
  >({
    name: 'guide.secret.set',
    permission: GUIDE_GRANTS.reveal,
    resourceType: 'guide_entry_secret',
    input: SECRET_INPUT,

    rule({ input, context }) {
      assertCan(context.actor, GUIDE_GRANTS.reveal, {
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId,
      })
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      if (input.value === null) {
        const { error } = await db
          .from('guide_entry_secrets')
          .delete()
          .eq('organization_id', organizationId)
          .eq('entry_id', input.entryId)

        if (error) throw error
        return { entryId: input.entryId, set: false }
      }

      const { error } = await db.from('guide_entry_secrets').upsert(
        {
          organization_id: organizationId,
          property_id: input.propertyId,
          entry_id: input.entryId,
          value: input.value,
          version: 1,
          updated_by: context.actor.userId,
          created_by: context.actor.userId,
        },
        { onConflict: 'entry_id' },
      )

      if (error) throw error
      return { entryId: input.entryId, set: true }
    },

    audit({ input, result }) {
      // WHAT is never recorded. The audit trail says a code changed and who
      // changed it, which is the whole of what anybody needs from it, and a
      // trail that carried the value would be a second place the code lives.
      return {
        resourceId: input.entryId,
        propertyId: input.propertyId,
        summary: result.set
          ? 'עדכן קוד או סוד בערך במדריך הנכס. הערך עצמו אינו נרשם ביומן.'
          : 'מחק קוד או סוד מערך במדריך הנכס.',
        after: { secretPresent: result.set },
      }
    },
  })

  /* --------------------------------------------------- recommendation -- */

  const addRecommendation = defineOperation<
    RecommendationInput,
    null,
    { id: string }
  >({
    name: 'guide.recommendation.add',
    permission: GUIDE_GRANTS.edit,
    resourceType: 'guide_recommendation',
    input: RECOMMENDATION_INPUT,

    rule({ input, context }) {
      assertCan(context.actor, GUIDE_GRANTS.edit, {
        organizationId: context.actor.organizationId,
        propertyId: input.propertyId,
      })

      // §44, refused before anything is written. A named source with no name
      // is an unsourced recommendation with a label on it.
      if (
        input.sourceKind === 'named' &&
        (input.sourceName === null || input.sourceName.trim().length === 0)
      ) {
        throw new BusinessRuleError({
          code: 'recommendation_source_unnamed',
          userMessage:
            'המלצה שמסתמכת על גורם חיצוני חייבת לנקוב בשמו. אורח צריך לדעת מי ממליץ.',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const draft: RecommendationDraft = {
        organizationId,
        propertyId: input.propertyId,
        category: input.category,
        name: input.name,
        description: input.description,
        address: input.address,
        phone: input.phone,
        url: input.url,
        minutesAway: input.minutesAway,
        sortOrder: input.sortOrder,
      }

      // The domain constructor, not a hand-built row. `recommendationFromForm`
      // is the only thing that makes a `GuideRecommendation`, and it refuses
      // without a source — so this operation cannot write one either.
      const built = recommendationFromForm(
        'pending',
        draft,
        input.sourceKind === 'business'
          ? { kind: 'business', enteredByUserId: context.actor.userId }
          : {
              kind: 'named',
              // `rule` has already refused a blank name. The coalesce makes
              // that refusal legible to the compiler rather than leaving a
              // second, silent chance to write an unsourced row — and if it
              // ever were reached, `readSource` refuses an empty name too.
              name: input.sourceName ?? '',
              url: input.sourceUrl,
            },
      )

      if (!built.ok) {
        throw new BusinessRuleError({
          code: `recommendation_${built.refusal}`,
          userMessage: REFUSAL_MESSAGE[built.refusal],
        })
      }

      const item = built.recommendation
      const guideId = await guideIdFor(
        db,
        organizationId,
        input.propertyId,
        context.actor.userId,
      )

      const { data, error } = await db
        .from('guide_recommendations')
        .insert({
          organization_id: organizationId,
          guide_id: guideId,
          property_id: item.propertyId,
          category: item.category,
          name: item.name,
          description: item.description,
          address: item.address,
          phone: item.phone,
          url: item.url,
          minutes_away: item.minutesAway,
          source_kind: item.source.kind,
          source_user_id:
            item.source.kind === 'business'
              ? item.source.enteredByUserId
              : null,
          source_name: item.source.kind === 'named' ? item.source.name : null,
          source_url: item.source.kind === 'named' ? item.source.url : null,
          sort_order: item.sortOrder,
          is_active: true,
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) throw error
      return { id: asId(data) }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        propertyId: input.propertyId,
        summary:
          `הוסיף המלצה מקומית בקטגוריה ${input.category}, ` +
          `מקור: ${input.sourceKind === 'business' ? 'בית האירוח' : input.sourceName}.`,
        after: { category: input.category, sourceKind: input.sourceKind },
      }
    },
  })

  /* ---------------------------------------------------------- publish -- */

  const publishGuide = defineOperation<PublishInput, Guide, PublishedGuide>({
    name: 'guide.publish',
    permission: GUIDE_GRANTS.publish,
    resourceType: 'property_guide',
    input: PUBLISH_INPUT,
    requiresVersion: true,

    async loadResource({ input, context }) {
      const guide = await repository.guide(
        context.actor.organizationId,
        input.propertyId,
      )
      if (guide === null) return null

      return {
        resource: {
          organizationId: guide.organizationId,
          propertyId: guide.propertyId,
        },
        entity: guide,
        version: guide.version,
      }
    },

    // No `rule`. `loadResource` returning null makes the pipeline raise
    // `NotFoundError` before this point, so a guide that does not exist is
    // already refused and a rule re-checking it would be dead code.
    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const [entries, recommendations, propertyName] = await Promise.all([
        repository.entries(organizationId, input.propertyId),
        repository.recommendations(organizationId, input.propertyId),
        repository.propertyName(organizationId, input.propertyId),
      ])

      // Hebrew is never dropped. Every entry carries it — `LocalizedText`
      // guarantees that — so a guide declaring only English would render
      // Hebrew paragraphs under English headings.
      const languages: GuideLanguage[] = input.languages.includes('he')
        ? [...input.languages]
        : ['he', ...input.languages]

      // The snapshot takes entries and nothing else. A secret cannot be in it
      // — see `buildGuideSnapshot` and the note on `GuideSnapshot`.
      const snapshot = buildGuideSnapshot({
        guide: { ...entity, languages },
        propertyName: propertyName ?? '',
        entries,
        recommendations,
        builtAt: now,
      })

      const versionNumber = await nextVersionNumber(
        db,
        organizationId,
        entity.id,
      )

      const { data, error } = await db
        .from('guide_versions')
        .insert({
          organization_id: organizationId,
          guide_id: entity.id,
          version_number: versionNumber,
          label: input.label,
          snapshot,
          entry_count: snapshot.entries.length,
          published_at: now.toISOString(),
          published_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) throw error
      const versionId = asId(data)

      const { error: pointerError } = await db
        .from('property_guides')
        .update({
          status: 'published',
          languages,
          published_version_id: versionId,
          published_at: now.toISOString(),
          published_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)
        .eq('organization_id', organizationId)

      if (pointerError) throw pointerError

      return {
        guideId: entity.id,
        versionId,
        versionNumber,
        entryCount: snapshot.entries.length,
        recommendationCount: snapshot.recommendations.length,
      }
    },

    audit({ input, result }) {
      return {
        resourceId: result.guideId,
        propertyId: input.propertyId,
        summary:
          `פרסם את מדריך הנכס, גרסה ${result.versionNumber}, ` +
          `${result.entryCount} ערכים ו-${result.recommendationCount} המלצות.`,
        after: {
          versionNumber: result.versionNumber,
          entryCount: result.entryCount,
        },
      }
    },
  })

  return { saveEntry, setEntrySecret, addRecommendation, publishGuide }
}

/* ------------------------------------------------------------- helpers -- */

const REFUSAL_MESSAGE: Readonly<Record<string, string>> = Object.freeze({
  no_source:
    'המלצה חייבת מקור: או שבית האירוח מזין אותה, או שהיא מצטטת גורם ששמו נכתב.',
  no_name: 'להמלצה צריך שם בעברית.',
  unsafe_url:
    'כתובת חייבת להתחיל ב-https:// או להיות נתיב פנימי. כתובות javascript: ו-data: אינן מתקבלות.',
  unknown_category: 'הקטגוריה שנבחרה אינה מוכרת.',
  implausible_distance: 'מספר הדקות אינו סביר.',
})

/**
 * The next version number, read rather than counted.
 *
 * `max(version_number) + 1` inside the transaction. The unique index on
 * `(guide_id, version_number)` is what actually prevents two publishes racing
 * to the same number; this is the ordinary path and the index is the floor.
 */
async function nextVersionNumber(
  db: Db,
  organizationId: string,
  guideId: string,
): Promise<number> {
  const { data, error } = await db
    .from('guide_versions')
    .select('version_number')
    .eq('organization_id', organizationId)
    .eq('guide_id', guideId)
    .order('version_number', { ascending: false })
    .limit(1)

  if (error) throw error
  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) return 1

  const row = toRow(rows[0])
  const current = row.version_number
  return typeof current === 'number' ? current + 1 : 1
}

/** The `id` an insert returned, or a failure that says so. */
function asId(data: unknown): string {
  const row = toRow(data)
  const id = row.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new BusinessRuleError({
      code: 'guide_write_returned_no_id',
      userMessage: 'השמירה לא הושלמה. נסה שוב.',
    })
  }
  return id
}
