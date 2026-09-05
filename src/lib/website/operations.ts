/**
 * EXECUTION CONTEXT — SERVER ONLY. Every write the website module performs.
 *
 * Each one is a `defineOperation`, which means each goes through
 * authorization → validation → domain rule → transaction → audit event →
 * idempotency, in that order, with no way for a caller to reorder or skip a
 * step. An `insert` from a route handler would look identical to a person and
 * skip all six; the one that matters most here is the audit event, because a
 * page that changed with no row in `audit_events` is the argument nobody can
 * settle after a guest quotes a price the site no longer shows.
 *
 * ── The events these emit ─────────────────────────────────────────────────
 *
 * All three from `DOMAIN_EVENTS` in the frozen catalogue: `site.generated`,
 * `site.published`, `site.rolled_back`. Nothing here invents a name.
 *
 * There is deliberately no event for editing a page or a section. The
 * catalogue has none, and it is right not to: a draft edit is not a thing
 * anything else in the product should react to. What a person did is in
 * `audit_events`; what the product reacts to is a publish.
 *
 * ── Why `sites` UPDATE is guarded here rather than at the policy ──────────
 *
 * Four grants write different columns of one row — `site.edit_content`
 * renames, `site.edit_design` writes `design`, `site.publish` and
 * `site.rollback` move `published_version_id` — and Postgres column privileges
 * do not compose with RLS in a way anybody can read six months later. 0042's
 * `sites_update` policy therefore admits any of the four and each operation
 * below asserts exactly the one it needs, which is the same choice 0032
 * documents for `product.price_manage`.
 */

import { assertCan } from '../authz/can'
import { BusinessRuleError, NotFoundError } from '../errors'
import { clientFor, toRow, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import {
  nullContentGenerator,
  type ContentGenerator,
  type GenerationOutcome,
} from './ai'
import { groundDraft, type GeneratedDraft, type SiteClaim } from './facts'
import { buildSnapshot } from './snapshot'
import {
  assertTransition,
  nextVersionNumber,
  SiteClaimsUnsourcedError,
} from './publish'
import { WebsiteRepository } from './repository'
import {
  DEFAULT_SITE_DESIGN,
  SITE_PAGE_KINDS,
  SITE_SECTION_KINDS,
  type Site,
  type SiteDesign,
} from './types'

/* ------------------------------------------------------------ the schemas -- */

const SLUG = /^[a-z0-9][a-z0-9-]*$/

const SITE_INPUT = s.object({
  name: s.string({ label: 'שם האתר', min: 2, max: 200 }),
  slug: s.string({
    label: 'כתובת',
    min: 3,
    max: 64,
    pattern: SLUG,
    patternMessage:
      'הכתובת מורכבת מאותיות לטיניות קטנות, ספרות ומקפים, ומתחילה באות או בספרה.',
  }),
  propertyId: s.nullable(s.uuid({ label: 'נכס' })),
})

const PAGE_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  slug: s.string({ label: 'כתובת העמוד', max: 64 }),
  kind: s.enumOf(SITE_PAGE_KINDS, { label: 'סוג העמוד' }),
  title: s.string({ label: 'כותרת', min: 2, max: 200 }),
  navLabel: s.nullable(s.string({ label: 'תווית בתפריט', max: 60 })),
  showInNav: s.boolean({ label: 'הצגה בתפריט' }),
  sortOrder: s.number({ label: 'סדר', integer: true, min: 0, max: 999 }),
})

const CLAIM_INPUT = s.object({
  key: s.string({ label: 'מזהה טענה', min: 1, max: 120 }),
  text: s.string({ label: 'טקסט', min: 1, max: 5000 }),
})

const SECTION_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  pageId: s.uuid({ label: 'עמוד' }),
  kind: s.enumOf(SITE_SECTION_KINDS, { label: 'סוג המקטע' }),
  sortOrder: s.number({ label: 'סדר', integer: true, min: 0, max: 999 }),
  /** A property, unit, amenity or media row. Anything else is refused. */
  boundSource: s.nullable(
    s.enumOf(['property', 'unit', 'amenity', 'media'] as const, {
      label: 'מקור',
    }),
  ),
  boundId: s.nullable(s.uuid({ label: 'שורת מקור' })),
  /**
   * Authored text only. Canonical claims are NOT accepted from a caller —
   * they are read from the rows by `content.ts`, which is the whole point.
   * A form that could post `{source: 'property'}` would be a form that could
   * post a fabricated fact.
   */
  authoredClaims: s.arrayOf(CLAIM_INPUT, { label: 'טקסטים', max: 40 }),
})

const DESIGN_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  palette: s.enumOf(['sand', 'olive', 'sea', 'stone', 'night'] as const, {
    label: 'ערכת צבעים',
  }),
  headingFont: s.enumOf(['system', 'serif', 'display'] as const, {
    label: 'גופן כותרות',
  }),
  radius: s.enumOf(['sharp', 'soft', 'round'] as const, { label: 'פינות' }),
  density: s.enumOf(['comfortable', 'compact'] as const, { label: 'צפיפות' }),
  logoMediaId: s.nullable(s.uuid({ label: 'לוגו' })),
})

const SEO_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  pageId: s.uuid({ label: 'עמוד' }),
  metaTitle: s.nullable(s.string({ label: 'כותרת חיפוש', max: 200 })),
  metaDescription: s.nullable(s.string({ label: 'תיאור חיפוש', max: 500 })),
  canonicalUrl: s.nullable(s.string({ label: 'כתובת קנונית', max: 500 })),
  indexable: s.boolean({ label: 'ניתן לאינדוקס' }),
})

const PUBLISH_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  label: s.nullable(s.string({ label: 'שם הגרסה', max: 60 })),
})

const ROLLBACK_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  versionId: s.uuid({ label: 'גרסה' }),
})

const DOMAIN_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  hostname: s.string({ label: 'דומיין', min: 4, max: 253 }),
})

const GENERATE_INPUT = s.object({
  siteId: s.uuid({ label: 'אתר' }),
  sectionId: s.uuid({ label: 'מקטע' }),
  instruction: s.nullable(s.string({ label: 'הנחיה', max: 1000 })),
  tone: s.enumOf(['warm', 'plain', 'upscale', 'family'] as const, {
    label: 'סגנון',
  }),
})

/* -------------------------------------------------------------- the types -- */

export type SiteDraft = {
  name: string
  slug: string
  propertyId: string | null
}

export type CreatedSite = { id: string; slug: string; name: string }

export type PageDraft = {
  siteId: string
  slug: string
  kind: (typeof SITE_PAGE_KINDS)[number]
  title: string
  navLabel: string | null
  showInNav: boolean
  sortOrder: number
}

export type SectionDraft = {
  siteId: string
  pageId: string
  kind: (typeof SITE_SECTION_KINDS)[number]
  sortOrder: number
  boundSource: 'property' | 'unit' | 'amenity' | 'media' | null
  boundId: string | null
  authoredClaims: { key: string; text: string }[]
}

export type PublishedSite = {
  siteId: string
  versionId: string
  versionNumber: number
  claimCount: number
  pageCount: number
}

export type RolledBackSite = PublishedSite & {
  restoredFromVersionNumber: number
}

export type GenerationResult = {
  requestId: string
  status: GenerationOutcome['status']
  provider: string
  refusalReason: string | null
  drafts: readonly GeneratedDraft[]
}

export interface WebsiteOperations {
  createSite: Operation<SiteDraft, null, CreatedSite>
  savePage: Operation<PageDraft, null, { id: string; title: string }>
  saveSection: Operation<SectionDraft, null, { id: string; claimCount: number }>
  saveDesign: Operation<
    SiteDesign & { siteId: string },
    Site,
    { siteId: string }
  >
  saveSeo: Operation<
    {
      siteId: string
      pageId: string
      metaTitle: string | null
      metaDescription: string | null
      canonicalUrl: string | null
      indexable: boolean
    },
    null,
    { pageId: string }
  >
  publish: Operation<
    { siteId: string; label: string | null },
    Site,
    PublishedSite
  >
  unpublish: Operation<
    { siteId: string; label: string | null },
    Site,
    { siteId: string }
  >
  rollback: Operation<
    { siteId: string; versionId: string },
    Site,
    RolledBackSite
  >
  addDomain: Operation<
    { siteId: string; hostname: string },
    null,
    { id: string; hostname: string; verificationToken: string }
  >
  generate: Operation<
    {
      siteId: string
      sectionId: string
      instruction: string | null
      tone: 'warm' | 'plain' | 'upscale' | 'family'
    },
    null,
    GenerationResult
  >
}

/* ------------------------------------------------------- the operations -- */

export function defineWebsiteOperations(options: {
  db: Db
  /**
   * The content generator. Defaults to the null one, which refuses honestly.
   *
   * Injected rather than imported so a real provider is one wiring change and
   * so the tests can exercise grounding with a fixture. See `ai.ts`.
   */
  generator?: ContentGenerator
}): WebsiteOperations {
  const repository = new WebsiteRepository(options.db)
  const generator = options.generator ?? nullContentGenerator

  /* ---------------------------------------------------------------- site -- */

  const createSite = defineOperation<SiteDraft, null, CreatedSite>({
    name: 'site.create',
    permission: 'site.edit_content',
    resourceType: 'site',
    input: SITE_INPUT,

    rule({ input, context }) {
      // A site narrowed to a property must be a property this actor may act
      // in. A manager scoped to the Carmel flat may not publish a website for
      // the Galilee villa.
      if (input.propertyId) {
        assertCan(context.actor, 'site.edit_content', {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('sites')
        .insert({
          organization_id: context.actor.organizationId,
          property_id: input.propertyId,
          slug: input.slug,
          name: input.name,
          // Born a draft, and with no version pointer —
          // `sites_draft_has_no_version` in 0042 refuses anything else. A site
          // that arrives published is a site nobody chose to publish.
          status: 'draft',
          published_version_id: null,
          published_at: null,
          published_by: null,
          locale: 'he',
          design: DEFAULT_SITE_DESIGN,
          // Every remaining NOT NULL column stated rather than defaulted: the
          // demo database applies no defaults, and a row read back with
          // `metadata` absent throws in the mapper on the very next render.
          metadata: {},
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, slug, name')
        .single()

      if (error) {
        // The global unique index on `slug`. Translated here so a person reads
        // a sentence about their form rather than a constraint name.
        if (String(error.code) === '23505') {
          throw new BusinessRuleError({
            code: 'site_slug_taken',
            userMessage:
              'הכתובת הזו כבר תפוסה. בחרו כתובת אחרת — היא חייבת להיות ייחודית בכל המערכת, כי זו הכתובת הפומבית של האתר.',
            message: 'site slug already in use',
          })
        }
        throw error
      }

      const row = toRow(data)
      return {
        id: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
      }
    },

    audit({ result, input, context }) {
      return {
        resourceId: result.id,
        propertyId: input.propertyId,
        after: { name: result.name, slug: result.slug, status: 'draft' },
        summary: `${context.auditActor.label} יצרה את האתר ${result.name} בכתובת /${result.slug}, במצב טיוטה`,
      }
    },
  })

  /* --------------------------------------------------------------- pages -- */

  const savePage = defineOperation<
    PageDraft,
    null,
    { id: string; title: string }
  >({
    name: 'site.page.save',
    permission: 'site.edit_content',
    resourceType: 'site_page',
    input: PAGE_INPUT,

    rule({ input }) {
      // ── THE SLUGS THE ROUTER ALREADY OWNS ────────────────────────────
      //
      // `/s/[slug]/book` is a static segment and Next.js prefers it over the
      // `[pageSlug]` dynamic one. A page saved with the slug `book` would be
      // accepted by the database, appear in the studio, appear in the site's
      // navigation, and 404 for every visitor who clicked it — the worst
      // shape of failure, because everything except the visitor's experience
      // says it worked.
      //
      // Refused here rather than in the database: the reserved list is a
      // property of the route tree in `src/app/s/`, not of the schema, and a
      // CHECK constraint naming it would go stale the day a route is added.
      if (RESERVED_PAGE_SLUGS.includes(input.slug.trim().toLowerCase())) {
        throw new BusinessRuleError({
          code: 'site_page_slug_reserved',
          userMessage: `הכתובת ״${input.slug}״ שמורה למערכת ולכן עמוד בכתובת הזו לא היה נפתח למבקרים. בחרו כתובת אחרת.`,
          message: `page slug is reserved by the route tree: ${input.slug}`,
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { data, error } = await db
        .from('site_pages')
        .insert({
          organization_id: context.actor.organizationId,
          site_id: input.siteId,
          slug: input.slug,
          kind: input.kind,
          title: input.title,
          nav_label: input.navLabel,
          show_in_nav: input.showInNav,
          sort_order: input.sortOrder,
          is_active: true,
          metadata: {},
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, title')
        .single()

      if (error) {
        if (String(error.code) === '23505') {
          throw new BusinessRuleError({
            code: 'site_page_slug_taken',
            userMessage:
              input.slug === ''
                ? 'כבר קיים עמוד בית לאתר הזה.'
                : `כבר קיים עמוד בכתובת /${input.slug}.`,
            message: 'site page slug already in use',
          })
        }
        throw error
      }

      const row = toRow(data)
      return { id: String(row.id), title: String(row.title) }
    },

    audit({ result, input, context }) {
      return {
        resourceId: result.id,
        after: { title: result.title, slug: input.slug, kind: input.kind },
        summary: `${context.auditActor.label} הוסיפה לאתר את העמוד ״${result.title}״`,
      }
    },
  })

  /* ------------------------------------------------------------ sections -- */

  /**
   * Save a block, with its facts read from the rows.
   *
   * ── THE OPERATION THE MODULE'S RULE LIVES IN ─────────────────────────────
   *
   * The caller supplies AUTHORED text and a BINDING. It does not supply
   * canonical claims and there is no field in the schema for one: the property
   * and unit facts are read here, from the rows, through `content.ts`. A form
   * post claiming "the villa has a heated pool, source: property" has nowhere
   * to arrive.
   *
   * The binding is read under the actor's own row level security, so a
   * property this person cannot see produces no facts — and a section bound to
   * a row that does not exist is refused rather than saved empty.
   */
  const saveSection = defineOperation<
    SectionDraft,
    null,
    { id: string; claimCount: number }
  >({
    name: 'site.section.save',
    permission: 'site.edit_content',
    resourceType: 'site_section',
    input: SECTION_INPUT,

    rule({ input }) {
      // Half a binding is a section that believes it is showing a property and
      // cannot say which. 0042 refuses it too; this is the sentence a person
      // reads instead of a constraint name.
      if ((input.boundSource === null) !== (input.boundId === null)) {
        throw new BusinessRuleError({
          code: 'site_binding_incomplete',
          userMessage:
            'בחרו גם סוג מקור וגם את השורה עצמה, או השאירו את שניהם ריקים.',
          message: 'section binding is half specified',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const claims: SiteClaim[] = []

      // ── The canonical half, read from the rows ────────────────────────
      if (input.boundSource === 'property' && input.boundId) {
        const properties = await repository.properties(
          organizationId,
          input.boundId,
        )
        if (properties.length === 0) {
          throw new NotFoundError('property', input.boundId, {
            userMessage:
              'הנכס שבחרתם אינו קיים או שאין לכם גישה אליו. בחרו נכס אחר.',
          })
        }

        const { propertyClaims } = await import('./content')
        claims.push(...propertyClaims(properties[0]))
      }

      if (input.boundSource === 'unit' && input.boundId) {
        const units = await repository.units(organizationId, null)
        const unit = units.find((row) => String(row.id) === input.boundId)
        if (!unit) {
          throw new NotFoundError('unit', input.boundId, {
            userMessage:
              'היחידה שבחרתם אינה קיימת או שאין לכם גישה אליה. בחרו יחידה אחרת.',
          })
        }

        const { unitClaims } = await import('./content')
        claims.push(...unitClaims(unit))
      }

      // ── The authored half, signed by the person saving it ─────────────
      const { authoredClaim } = await import('./facts')
      for (const draft of input.authoredClaims) {
        const claim = authoredClaim({
          key: draft.key,
          text: draft.text,
          authorUserId: context.actor.userId,
        })
        if (claim) claims.push(claim)
      }

      const { data, error } = await db
        .from('site_sections')
        .insert({
          organization_id: organizationId,
          site_id: input.siteId,
          page_id: input.pageId,
          kind: input.kind,
          sort_order: input.sortOrder,
          is_active: true,
          bound_source: input.boundSource,
          bound_id: input.boundId,
          claims,
          layout: {},
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) throw error

      return { id: String(toRow(data).id), claimCount: claims.length }
    },

    audit({ result, input, context }) {
      return {
        resourceId: result.id,
        after: {
          kind: input.kind,
          boundSource: input.boundSource,
          boundId: input.boundId,
          claimCount: result.claimCount,
          // Every canonical claim's provenance, in the audit row. What an
          // auditor reads to answer "on what basis did the page say that?".
          authoredClaims: input.authoredClaims.length,
        },
        summary:
          `${context.auditActor.label} הוסיפה מקטע מסוג ${input.kind} ` +
          `עם ${result.claimCount} טענות, ` +
          (input.boundSource
            ? `משויך ל${input.boundSource === 'property' ? 'נכס' : 'יחידה'}`
            : 'ללא שיוך לנתוני המערכת'),
      }
    },
  })

  /* -------------------------------------------------------------- design -- */

  const saveDesign = defineOperation<
    SiteDesign & { siteId: string },
    Site,
    { siteId: string }
  >({
    name: 'site.design.save',
    // A DIFFERENT GRANT FROM CONTENT, ON PURPOSE. A designer changes the
    // palette and may not rewrite the cancellation paragraph; a copywriter
    // writes the paragraph and may not change the palette.
    permission: 'site.edit_design',
    resourceType: 'site',
    input: DESIGN_INPUT,
    requiresVersion: false,

    async loadResource({ input, context }) {
      const site = await repository.siteById(
        context.actor.organizationId,
        input.siteId,
      )
      if (!site) return null
      return {
        resource: {
          organizationId: site.organizationId,
          propertyId: site.propertyId ?? undefined,
        },
        entity: site,
        version: site.version,
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { error } = await db
        .from('sites')
        .update({
          design: {
            palette: input.palette,
            headingFont: input.headingFont,
            radius: input.radius,
            density: input.density,
            logoMediaId: input.logoMediaId,
          },
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.siteId)

      if (error) throw error
      return { siteId: input.siteId }
    },

    audit({ entity, input, context }) {
      return {
        resourceId: input.siteId,
        before: { design: entity?.design ?? null },
        after: { palette: input.palette, headingFont: input.headingFont },
        summary: `${context.auditActor.label} שינתה את עיצוב האתר לערכת ${input.palette}`,
      }
    },
  })

  /* ----------------------------------------------------------------- seo -- */

  const saveSeo = defineOperation<
    {
      siteId: string
      pageId: string
      metaTitle: string | null
      metaDescription: string | null
      canonicalUrl: string | null
      indexable: boolean
    },
    null,
    { pageId: string }
  >({
    name: 'site.seo.save',
    // Again a different grant. Writing a paragraph and deciding whether the
    // page may be indexed are different jobs done by different people.
    permission: 'site.manage_seo',
    resourceType: 'site_seo',
    input: SEO_INPUT,

    rule({ input }) {
      // `site_seo_canonical_absolute` in 0042. Checked here so the person
      // reads a sentence about their field.
      if (
        input.canonicalUrl !== null &&
        !/^https:\/\/[a-z0-9.-]+(\/|$)/.test(input.canonicalUrl)
      ) {
        throw new BusinessRuleError({
          code: 'site_canonical_invalid',
          userMessage:
            'כתובת קנונית חייבת להיות כתובת מלאה שמתחילה ב־https://. כתובת יחסית תתעלם ממנה על ידי מנועי החיפוש.',
          message: 'canonical url is not an absolute https url',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      const { error } = await db.from('site_seo').upsert(
        {
          page_id: input.pageId,
          organization_id: context.actor.organizationId,
          site_id: input.siteId,
          meta_title: input.metaTitle,
          meta_description: input.metaDescription,
          canonical_url: input.canonicalUrl,
          og_media_id: null,
          indexable: input.indexable,
          keywords: [],
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        },
        { onConflict: 'page_id' },
      )

      if (error) throw error
      return { pageId: input.pageId }
    },

    audit({ input, context }) {
      return {
        resourceId: input.pageId,
        after: {
          metaTitle: input.metaTitle,
          indexable: input.indexable,
        },
        summary:
          `${context.auditActor.label} עדכנה את נתוני החיפוש של העמוד` +
          (input.indexable ? '' : ', והוציאה אותו מהאינדוקס'),
      }
    },
  })

  /* ------------------------------------------------------------- publish -- */

  /**
   * PUT IT IN FRONT OF CUSTOMERS.
   *
   * The one operation that changes what a stranger sees, and the only place
   * `buildSnapshot`'s refusal becomes a refusal a person reads. Every claim on
   * every active section of every active page must be traceable, or the
   * publish does not happen and each offending claim is named.
   */
  const publish = defineOperation<
    { siteId: string; label: string | null },
    Site,
    PublishedSite
  >({
    name: 'site.publish',
    permission: 'site.publish',
    resourceType: 'site',
    input: PUBLISH_INPUT,

    async loadResource({ input, context }) {
      const site = await repository.siteById(
        context.actor.organizationId,
        input.siteId,
      )
      if (!site) return null
      return {
        resource: {
          organizationId: site.organizationId,
          propertyId: site.propertyId ?? undefined,
        },
        entity: site,
        version: site.version,
      }
    },

    rule({ entity, input }) {
      if (!entity) {
        throw new NotFoundError('site', input.siteId, {
          userMessage: 'האתר לא נמצא.',
        })
      }
      assertTransition('publish', entity)
    },

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const site = entity as Site
      const organizationId = context.actor.organizationId

      const [pages, sections, media, versions, organizationName] =
        await Promise.all([
          repository.pages(organizationId, site.id),
          repository.sections(organizationId, site.id),
          repository.media(organizationId, site.id),
          repository.versions(organizationId, site.id),
          repository.organizationName(organizationId),
        ])

      const properties = await repository.properties(
        organizationId,
        site.propertyId,
      )
      const units = await repository.units(
        organizationId,
        properties.map((row) => String(row.id)),
      )

      const built = buildSnapshot({
        site,
        organizationName: organizationName ?? site.name,
        pages,
        sections,
        media,
        units: units.map((row) => ({
          id: String(row.id),
          propertyId: String(row.property_id),
          status: String(row.status),
        })),
        now,
      })

      // THE GATE. Not a warning — the publish does not happen.
      if (!built.ok) throw new SiteClaimsUnsourcedError(built.blockers)

      const versionNumber = nextVersionNumber(versions)

      const { data, error } = await db
        .from('site_versions')
        .insert({
          organization_id: organizationId,
          site_id: site.id,
          version_number: versionNumber,
          label: input.label,
          snapshot: built.snapshot,
          fact_manifest: built.snapshot.factManifest,
          published_at: now.toISOString(),
          published_by: context.actor.userId,
          restored_from_version_id: null,
        })
        .select('id')
        .single()

      if (error) throw error
      const versionId = String(toRow(data).id)

      const { error: pointerError } = await db
        .from('sites')
        .update({
          status: 'published',
          published_version_id: versionId,
          published_at: now.toISOString(),
          published_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', organizationId)
        .eq('id', site.id)

      if (pointerError) throw pointerError

      return {
        siteId: site.id,
        versionId,
        versionNumber,
        claimCount: built.snapshot.factManifest.length,
        pageCount: built.snapshot.pages.length,
      }
    },

    audit({ result, entity, context }) {
      return {
        resourceId: result.siteId,
        propertyId: entity?.propertyId ?? null,
        before: { status: entity?.status, version: entity?.publishedVersionId },
        after: { status: 'published', version: result.versionId },
        summary:
          `${context.auditActor.label} פרסמה את האתר בגרסה ${result.versionNumber} — ` +
          `${result.pageCount} עמודים, ${result.claimCount} טענות, כולן מאומתות מול הנתונים`,
      }
    },

    events({ result, entity }) {
      return [
        {
          name: 'site.published',
          propertyId: entity?.propertyId ?? null,
          payload: {
            siteId: result.siteId,
            versionId: result.versionId,
            versionNumber: result.versionNumber,
            pageCount: result.pageCount,
          },
        },
      ]
    },
  })

  /* ----------------------------------------------------------- unpublish -- */

  const unpublish = defineOperation<
    { siteId: string; label: string | null },
    Site,
    { siteId: string }
  >({
    name: 'site.unpublish',
    permission: 'site.publish',
    resourceType: 'site',
    input: PUBLISH_INPUT,

    async loadResource({ input, context }) {
      const site = await repository.siteById(
        context.actor.organizationId,
        input.siteId,
      )
      if (!site) return null
      return {
        resource: {
          organizationId: site.organizationId,
          propertyId: site.propertyId ?? undefined,
        },
        entity: site,
        version: site.version,
      }
    },

    rule({ entity, input }) {
      if (!entity) {
        throw new NotFoundError('site', input.siteId, {
          userMessage: 'האתר לא נמצא.',
        })
      }
      assertTransition('unpublish', entity)
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)

      // The pointer is cleared and EVERY VERSION STAYS. `unpublished` is a
      // distinct status from `draft` for exactly this reason: a business that
      // took its site down has not lost its work and can put it back.
      const { error } = await db
        .from('sites')
        .update({
          status: 'unpublished',
          published_version_id: null,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', input.siteId)

      if (error) throw error
      return { siteId: input.siteId }
    },

    audit({ entity, input, context }) {
      return {
        resourceId: input.siteId,
        before: { status: entity?.status },
        after: { status: 'unpublished' },
        summary: `${context.auditActor.label} הורידה את האתר מהאוויר. כל הגרסאות נשמרו וניתן להעלות אותו שוב`,
      }
    },
  })

  /* ------------------------------------------------------------ rollback -- */

  /**
   * GO BACK TO v3, WHICH CREATES v7.
   *
   * It does not delete v4, v5 or v6 — `tg_site_versions_immutable` in 0042
   * would refuse if it tried. A business that rolls back at 21:00 because a
   * price was wrong must be able to roll forward at 09:00 once it is fixed.
   *
   * A separate grant from `site.publish` because it is a separate act with a
   * separate blast radius: publishing puts a reviewed draft live, rolling back
   * replaces what is live with something older, at speed, usually because
   * something is wrong.
   */
  const rollback = defineOperation<
    { siteId: string; versionId: string },
    Site,
    RolledBackSite
  >({
    name: 'site.rollback',
    permission: 'site.rollback',
    resourceType: 'site',
    input: ROLLBACK_INPUT,

    async loadResource({ input, context }) {
      const site = await repository.siteById(
        context.actor.organizationId,
        input.siteId,
      )
      if (!site) return null
      return {
        resource: {
          organizationId: site.organizationId,
          propertyId: site.propertyId ?? undefined,
        },
        entity: site,
        version: site.version,
      }
    },

    rule({ entity, input }) {
      if (!entity) {
        throw new NotFoundError('site', input.siteId, {
          userMessage: 'האתר לא נמצא.',
        })
      }
      assertTransition('rollback', entity)
    },

    async execute({ input, entity, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const site = entity as Site
      const organizationId = context.actor.organizationId

      const target = await repository.version(organizationId, input.versionId)
      if (!target || target.siteId !== site.id) {
        throw new NotFoundError('site_version', input.versionId, {
          userMessage: 'הגרסה שביקשתם אינה שייכת לאתר הזה.',
        })
      }

      const versions = await repository.versions(organizationId, site.id)
      const versionNumber = nextVersionNumber(versions)

      // A NEW version carrying the OLD snapshot. Not an edit of the old one —
      // that is refused by trigger — and not a deletion of anything after it.
      const { data, error } = await db
        .from('site_versions')
        .insert({
          organization_id: organizationId,
          site_id: site.id,
          version_number: versionNumber,
          label: `שחזור גרסה ${target.versionNumber}`,
          snapshot: target.snapshot,
          fact_manifest: target.snapshot.factManifest ?? [],
          published_at: now.toISOString(),
          published_by: context.actor.userId,
          restored_from_version_id: target.id,
        })
        .select('id')
        .single()

      if (error) throw error
      const versionId = String(toRow(data).id)

      const { error: pointerError } = await db
        .from('sites')
        .update({
          status: 'published',
          published_version_id: versionId,
          published_at: now.toISOString(),
          published_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .eq('organization_id', organizationId)
        .eq('id', site.id)

      if (pointerError) throw pointerError

      return {
        siteId: site.id,
        versionId,
        versionNumber,
        restoredFromVersionNumber: target.versionNumber,
        claimCount: (target.snapshot.factManifest ?? []).length,
        pageCount: (target.snapshot.pages ?? []).length,
      }
    },

    audit({ result, entity, context }) {
      return {
        resourceId: result.siteId,
        propertyId: entity?.propertyId ?? null,
        before: { version: entity?.publishedVersionId },
        after: { version: result.versionId },
        summary:
          `${context.auditActor.label} החזירה את האתר לגרסה ${result.restoredFromVersionNumber}, ` +
          `שנשמרה כגרסה ${result.versionNumber}. הגרסאות שביניהן לא נמחקו`,
      }
    },

    events({ result, entity }) {
      return [
        {
          name: 'site.rolled_back',
          propertyId: entity?.propertyId ?? null,
          payload: {
            siteId: result.siteId,
            versionId: result.versionId,
            restoredFrom: result.restoredFromVersionNumber,
          },
        },
      ]
    },
  })

  /* -------------------------------------------------------------- domain -- */

  const addDomain = defineOperation<
    { siteId: string; hostname: string },
    null,
    { id: string; hostname: string; verificationToken: string }
  >({
    name: 'site.domain.add',
    // Carries the `custom_domain` entitlement rather than `website`. A
    // customer can hold a website on the system's own address without paying
    // for a domain, and `ENTITLEMENT_FOR_GRANT` already says so.
    permission: 'site.manage_domain',
    resourceType: 'site_domain',
    input: DOMAIN_INPUT,

    rule({ input }) {
      const hostname = input.hostname.trim().toLowerCase()
      if (
        !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          hostname,
        )
      ) {
        throw new BusinessRuleError({
          code: 'site_hostname_invalid',
          userMessage:
            'כתבו שם דומיין בלבד, למשל villa.co.il — בלי https:// ובלי נתיב אחריו.',
          message: 'hostname is not a bare domain',
        })
      }
    },

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const hostname = input.hostname.trim().toLowerCase()

      const { data, error } = await db
        .from('site_domains')
        .insert({
          organization_id: context.actor.organizationId,
          site_id: input.siteId,
          hostname,
          // Born pending. It becomes `verified` only when a DNS record
          // answers, and only a verified domain resolves on the public path —
          // 0042's `site_public_snapshot` joins on `status = 'verified'`.
          status: 'pending',
          verified_at: null,
          failure_reason: null,
          is_primary: false,
          version: 1,
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id, hostname, verification_token')
        .single()

      if (error) {
        if (String(error.code) === '23505') {
          throw new BusinessRuleError({
            code: 'site_hostname_taken',
            userMessage:
              'הדומיין הזה כבר רשום במערכת. אם הוא שלכם, פנו לתמיכה כדי להעביר אותו.',
            message: 'hostname already claimed',
          })
        }
        throw error
      }

      const row = toRow(data)
      return {
        id: String(row.id),
        hostname: String(row.hostname),
        verificationToken: String(row.verification_token),
      }
    },

    audit({ result, context }) {
      return {
        resourceId: result.id,
        // The token is a credential — anybody holding it can prove control of
        // a hostname to this system — and it is deliberately NOT in the audit
        // payload. The hostname is what happened; the token is how it is
        // proved, and an audit row outlives the verification.
        after: { hostname: result.hostname, status: 'pending' },
        summary: `${context.auditActor.label} רשמה את הדומיין ${result.hostname}, ממתין לאימות`,
      }
    },
  })

  /* ------------------------------------------------------------ generate -- */

  /**
   * ASK FOR A DRAFT, AND RECORD WHAT CAME BACK.
   *
   * ── What this operation does NOT do ──────────────────────────────────────
   *
   * It does not write a claim. A model's output is a proposal; it becomes a
   * sentence when a person accepts it through `saveSection`, which signs it to
   * them. So this operation writes exactly one row — the request, with what
   * was asked, the facts that were offered and what came back — and returns
   * the drafts for a person to look at.
   *
   * ── The closed world ─────────────────────────────────────────────────────
   *
   * `factsForSection` reads the bound rows and produces the ONLY facts the
   * generator sees. A model cannot be told about a heated pool unless a column
   * says there is one, and `groundDraft` drops any draft citing a key that was
   * never offered — recorded in `rejected_drafts`, because "the model invented
   * a fact" is worth knowing.
   *
   * With the null generator this returns `refused`, honestly and immediately,
   * and every other screen in the module works exactly as before.
   */
  const generate = defineOperation<
    {
      siteId: string
      sectionId: string
      instruction: string | null
      tone: 'warm' | 'plain' | 'upscale' | 'family'
    },
    null,
    GenerationResult
  >({
    name: 'site.generate',
    permission: 'site.ai_generate',
    resourceType: 'site_generation_request',
    input: GENERATE_INPUT,

    async execute({ input, context, tx, now }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      const sections = await repository.sections(organizationId, input.siteId)
      const section = sections.find((entry) => entry.id === input.sectionId)

      if (!section) {
        throw new NotFoundError('site_section', input.sectionId, {
          userMessage: 'המקטע לא נמצא.',
        })
      }

      const pages = await repository.pages(organizationId, input.siteId)
      const page = pages.find((entry) => entry.id === section.pageId)

      // THE CLOSED WORLD, read from the rows.
      const { factsForSection } = await import('./content')
      const boundPropertyId =
        section.boundTo?.source === 'property' ? section.boundTo.id : null

      const properties = boundPropertyId
        ? await repository.properties(organizationId, boundPropertyId)
        : []
      const units =
        section.kind === 'unit_grid' || section.kind === 'booking_widget'
          ? await repository.units(
              organizationId,
              properties.map((row) => String(row.id)),
            )
          : []
      const amenities =
        section.kind === 'amenity_list' && boundPropertyId
          ? await repository.propertyAmenities(organizationId, boundPropertyId)
          : []

      const facts = factsForSection({
        kind: section.kind,
        property: properties[0] ?? null,
        units,
        amenities,
        organizationName: await repository.organizationName(organizationId),
        organizationId,
      })

      const outcome = await generator.generate({
        brief: {
          organizationId,
          siteId: input.siteId,
          pageKind: page?.kind ?? 'custom',
          sectionKind: section.kind,
          wantedKeys: WANTED_KEYS[section.kind],
          instruction: input.instruction,
          tone: input.tone,
          locale: 'he',
        },
        facts,
      })

      // Grounding, even before a person sees the drafts. A draft citing a fact
      // that was never offered is not shown as a suggestion — it is recorded
      // as rejected, because offering it invites somebody to accept it.
      const grounded =
        outcome.status === 'drafted'
          ? groundDraft({
              drafts: outcome.drafts,
              offeredFacts: facts,
              acceptedByUserId: context.actor.userId,
            })
          : { accepted: [], rejected: [] }

      const survived =
        outcome.status === 'drafted'
          ? outcome.drafts.filter(
              (draft) =>
                !grounded.rejected.some(
                  (entry) => entry.draft.key === draft.key,
                ),
            )
          : []

      const { data, error } = await db
        .from('site_generation_requests')
        .insert({
          organization_id: organizationId,
          site_id: input.siteId,
          section_id: input.sectionId,
          status: outcome.status === 'drafted' ? 'drafted' : 'refused',
          provider: outcome.provider,
          instruction: input.instruction,
          tone: input.tone,
          offered_facts: facts,
          drafts: survived,
          refusal_reason: outcome.status === 'refused' ? outcome.reason : null,
          rejected_drafts: grounded.rejected,
          requested_at: now.toISOString(),
          requested_by: context.actor.userId,
          resolved_at: now.toISOString(),
        })
        .select('id')
        .single()

      if (error) throw error

      return {
        requestId: String(toRow(data).id),
        status: outcome.status,
        provider: outcome.provider,
        refusalReason: outcome.status === 'refused' ? outcome.reason : null,
        drafts: survived,
      }
    },

    audit({ result, input, context }) {
      return {
        resourceId: result.requestId,
        after: {
          sectionId: input.sectionId,
          provider: result.provider,
          status: result.status,
          draftCount: result.drafts.length,
        },
        summary:
          result.status === 'refused'
            ? `${context.auditActor.label} ביקשה ניסוח אוטומטי והמנוע סירב: ${result.refusalReason}`
            : `${context.auditActor.label} ביקשה ניסוח אוטומטי וקיבלה ${result.drafts.length} טיוטות מ־${result.provider}`,
      }
    },

    events({ result, input }) {
      // A refusal is not a generation. Firing `site.generated` for a request
      // that produced nothing would tell every subscriber something happened
      // when nothing did.
      if (result.status !== 'drafted') return []
      return [
        {
          name: 'site.generated',
          payload: {
            siteId: input.siteId,
            sectionId: input.sectionId,
            requestId: result.requestId,
            provider: result.provider,
            draftCount: result.drafts.length,
          },
        },
      ]
    },
  })

  return {
    createSite,
    savePage,
    saveSection,
    saveDesign,
    saveSeo,
    publish,
    unpublish,
    rollback,
    addDomain,
    generate,
  }
}

/**
 * Which claim keys each kind of section wants written.
 *
 * A closed list, per kind, so a generator is never asked to produce an
 * arbitrary field. A `gallery` wants nothing in prose and its entry is empty,
 * which is why the null generator refuses a generation request for one before
 * it says anything about configuration.
 */
const WANTED_KEYS: Readonly<
  Record<(typeof SITE_SECTION_KINDS)[number], readonly string[]>
> = Object.freeze({
  hero: ['heading', 'subheading'],
  rich_text: ['heading', 'body'],
  property_intro: ['heading', 'body'],
  unit_grid: ['heading'],
  amenity_list: ['heading'],
  gallery: [],
  location_map: ['heading', 'body'],
  contact_details: ['heading'],
  booking_widget: ['heading'],
  faq: ['heading', 'body'],
  cta: ['heading', 'cta'],
})

/**
 * Page slugs the route tree already owns.
 *
 * `src/app/s/[slug]/book` is a static segment and Next.js prefers it over the
 * `[pageSlug]` dynamic one, so a page saved with this slug is unreachable —
 * silently, and only for visitors. Kept beside the operation that refuses it
 * and exported so a route added under `src/app/s/` has one obvious place to
 * declare itself.
 */
export const RESERVED_PAGE_SLUGS: readonly string[] = ['book']
