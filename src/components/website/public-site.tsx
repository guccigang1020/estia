/**
 * THE PUBLIC RENDERER.
 *
 * Server components, no business chrome, RTL, and it reads NOTHING but the
 * snapshot it is handed. There is no database client in this file, no `fetch`,
 * and no import from the persistence layer — which is what makes "a visitor
 * sees the published document" a property of the component tree rather than
 * a rule the route must remember.
 *
 * ── It renders claims, not content ───────────────────────────────────────
 *
 * Every string on the page comes out of `section.claims`, and a claim that is
 * absent renders nothing rather than a placeholder. So a property with no
 * description produces a section with a heading and no paragraph — which is
 * correct, and is the visible consequence of the module's rule.
 *
 * ── No arbitrary style ───────────────────────────────────────────────────
 *
 * Colours arrive as CSS custom properties from `cssVariables`, whose values
 * are literals in `design.ts`. Nothing a user typed reaches a stylesheet, and
 * there is no `dangerouslySetInnerHTML` anywhere in this file — a published
 * site is served to strangers and is the last place to interpolate stored
 * text into markup.
 */

import Link from 'next/link'

import {
  claimText,
  claimTexts,
  mediaOf,
  navigationOf,
  SITE_SECTION_KIND_LABEL,
  type SiteSnapshot,
  type SiteSnapshotPage,
  type SiteSection,
} from '@/lib/website'

/* ------------------------------------------------------------- the frame -- */

export function SiteNavigation({
  snapshot,
  basePath,
  current,
}: {
  snapshot: SiteSnapshot
  basePath: string
  current: string
}) {
  const entries = navigationOf(snapshot)
  if (entries.length <= 1) return null

  return (
    <nav
      aria-label="ניווט באתר"
      className="flex flex-wrap items-center gap-x-5 gap-y-2"
    >
      {entries.map((entry) => (
        <Link
          key={entry.slug}
          href={entry.slug === '' ? basePath : `${basePath}/${entry.slug}`}
          aria-current={entry.slug === current ? 'page' : undefined}
          style={{
            color:
              entry.slug === current
                ? 'var(--site-accent)'
                : 'var(--site-muted)',
          }}
          className="text-sm underline-offset-4 hover:underline"
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  )
}

/* ---------------------------------------------------------- the sections -- */

export function SitePageBody({
  snapshot,
  page,
  basePath,
}: {
  snapshot: SiteSnapshot
  page: SiteSnapshotPage
  basePath: string
}) {
  if (page.sections.length === 0) {
    // An empty page is published only if somebody chose to. The quality pass
    // warned about it; the renderer does not invent something to fill it.
    return (
      <p style={{ color: 'var(--site-muted)' }} className="text-sm">
        העמוד הזה עדיין ריק.
      </p>
    )
  }

  return (
    <>
      {page.sections.map((section) => (
        <SiteSectionView
          key={section.id}
          snapshot={snapshot}
          section={section}
          basePath={basePath}
        />
      ))}
    </>
  )
}

function SiteSectionView({
  snapshot,
  section,
  basePath,
}: {
  snapshot: SiteSnapshot
  section: SiteSection
  basePath: string
}) {
  const heading = claimText(section, 'heading')
  const body = claimText(section, 'body')

  switch (section.kind) {
    case 'hero':
      return (
        <section className="flex flex-col gap-3">
          {heading ? <Display>{heading}</Display> : null}
          {claimText(section, 'subheading') ? (
            <Lead>{claimText(section, 'subheading')}</Lead>
          ) : null}
        </section>
      )

    case 'property_intro':
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading ?? claimText(section, 'property.name')}</Heading>
          <Prose>{body ?? claimText(section, 'property.description')}</Prose>
          <FactRow
            values={[
              claimText(section, 'property.check_in_time'),
              claimText(section, 'property.check_out_time'),
              claimText(section, 'property.min_nights'),
            ]}
          />
        </section>
      )

    case 'rich_text':
    case 'faq':
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading}</Heading>
          <Prose>{body}</Prose>
        </section>
      )

    case 'unit_grid': {
      // One card per unit, built from that unit's own claims. The keys carry
      // the unit id — `unit.name.<id>` — so grouping is a string split rather
      // than a second query.
      const units = groupByUnit(section)

      return (
        <section className="flex flex-col gap-4">
          <Heading>{heading ?? 'היחידות'}</Heading>
          {units.length === 0 ? (
            <Prose>אין יחידות להצגה.</Prose>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {units.map((unit) => (
                <li
                  key={unit.id}
                  style={{
                    background: 'var(--site-surface)',
                    borderColor: 'var(--site-line)',
                    borderRadius: 'var(--site-radius)',
                  }}
                  className="flex flex-col gap-2 border p-5"
                >
                  <p
                    style={{ fontFamily: 'var(--site-heading-font)' }}
                    className="text-lg font-bold"
                  >
                    {unit.name}
                  </p>
                  {unit.description ? <Prose>{unit.description}</Prose> : null}
                  <FactRow values={unit.facts} />
                  {snapshot.bookableUnitIds.includes(unit.id) ? (
                    <Link
                      href={`${basePath}/book?unit=${encodeURIComponent(unit.id)}`}
                      style={{ color: 'var(--site-accent)' }}
                      className="mt-1 self-start text-sm underline underline-offset-4"
                    >
                      בדיקת זמינות ומחיר
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )
    }

    case 'amenity_list': {
      const amenities = claimTexts(section, 'amenity')
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading ?? 'מה יש במקום'}</Heading>
          {amenities.length === 0 ? (
            <Prose>לא הוגדרו מתקנים.</Prose>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {amenities.map((amenity) => (
                <li
                  key={amenity}
                  style={{
                    borderColor: 'var(--site-line)',
                    borderRadius: 'var(--site-radius)',
                  }}
                  className="border px-3 py-1.5 text-sm"
                >
                  {amenity}
                </li>
              ))}
            </ul>
          )}
        </section>
      )
    }

    case 'gallery': {
      const images = section.claims
        .filter((claim) => claim.source === 'media' && claim.sourceId)
        .map((claim) => ({
          media: mediaOf(snapshot, claim.sourceId),
          alt: claim.text,
        }))
        .filter(
          (
            entry,
          ): entry is { media: NonNullable<typeof entry.media>; alt: string } =>
            entry.media !== null,
        )

      if (images.length === 0) return null

      return (
        <section className="flex flex-col gap-3">
          {heading ? <Heading>{heading}</Heading> : null}
          <ul className="grid gap-3 sm:grid-cols-3">
            {images.map((image) => (
              <li key={image.media.id}>
                {/* eslint-disable-next-line @next/next/no-img-element --
                    the URL is a customer's own media reference and may point at
                    any storage host; next/image would need every one of them in
                    next.config, which belongs to another owner. */}
                <img
                  src={image.media.url}
                  alt={image.media.altText ?? image.alt}
                  width={image.media.width ?? undefined}
                  height={image.media.height ?? undefined}
                  style={{ borderRadius: 'var(--site-radius)' }}
                  className="h-auto w-full object-cover"
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
        </section>
      )
    }

    case 'location_map':
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading ?? 'איפה זה'}</Heading>
          <Prose>{body}</Prose>
          <FactRow
            values={[
              claimText(section, 'property.address'),
              claimText(section, 'property.city'),
              claimText(section, 'property.region'),
            ]}
          />
        </section>
      )

    case 'contact_details':
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading ?? 'ליצירת קשר'}</Heading>
          <FactRow
            values={[
              claimText(section, 'property.contact_phone'),
              claimText(section, 'property.contact_email'),
              claimText(section, 'property.address'),
            ]}
          />
        </section>
      )

    case 'booking_widget':
      return (
        <section className="flex flex-col gap-3">
          <Heading>{heading ?? 'הזמנת חופשה'}</Heading>
          <Prose>
            בחרו יחידה ותאריכים, ונבדוק זמינות ומחיר מול המערכת עצמה.
          </Prose>
          <Link
            href={`${basePath}/book`}
            style={{
              background: 'var(--site-accent)',
              color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)',
            }}
            className="self-start px-5 py-2.5 text-sm font-semibold"
          >
            בדיקת זמינות
          </Link>
        </section>
      )

    case 'cta':
      return (
        <section
          style={{
            background: 'var(--site-surface)',
            borderColor: 'var(--site-line)',
            borderRadius: 'var(--site-radius)',
          }}
          className="flex flex-col gap-3 border p-6"
        >
          <Heading>{heading}</Heading>
          <Prose>{body}</Prose>
          {claimText(section, 'cta') ? (
            <Link
              href={`${basePath}/book`}
              style={{
                background: 'var(--site-accent)',
                color: 'var(--site-accent-ink)',
                borderRadius: 'var(--site-radius)',
              }}
              className="self-start px-5 py-2.5 text-sm font-semibold"
            >
              {claimText(section, 'cta')}
            </Link>
          ) : null}
        </section>
      )
  }
}

/* --------------------------------------------------------------- pieces -- */

function Display({ children }: { children: string }) {
  return (
    <h1
      style={{ fontFamily: 'var(--site-heading-font)' }}
      className="text-3xl font-bold leading-tight sm:text-4xl"
    >
      {children}
    </h1>
  )
}

function Heading({ children }: { children: string | null }) {
  if (!children) return null
  return (
    <h2
      style={{ fontFamily: 'var(--site-heading-font)' }}
      className="text-2xl font-bold"
    >
      {children}
    </h2>
  )
}

function Lead({ children }: { children: string | null }) {
  if (!children) return null
  return (
    <p style={{ color: 'var(--site-muted)' }} className="text-lg">
      {children}
    </p>
  )
}

/**
 * A paragraph, or nothing.
 *
 * `null` renders nothing rather than an empty `<p>`. That is the visible face
 * of the absent-column rule: a property with no description simply has no
 * paragraph, and the layout does not leave a hole where one would have been.
 */
function Prose({ children }: { children: string | null | undefined }) {
  if (!children) return null
  return <p className="whitespace-pre-line leading-relaxed">{children}</p>
}

/** A row of short facts, each of which may be absent. */
function FactRow({ values }: { values: readonly (string | null)[] }) {
  const present = values.filter((value): value is string => Boolean(value))
  if (present.length === 0) return null

  return (
    <ul
      style={{ color: 'var(--site-muted)' }}
      className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
    >
      {present.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  )
}

/**
 * Group a unit grid's claims by the unit they belong to.
 *
 * The keys are `unit.<field>.<unitId>`, produced by `factsForSection`. Split
 * rather than joined, because a snapshot must be self-contained and going back
 * to the units table at render time would be the second read the whole design
 * exists to avoid.
 */
function groupByUnit(section: SiteSection): readonly {
  id: string
  name: string
  description: string | null
  facts: readonly string[]
}[] {
  const byUnit = new Map<string, Map<string, string>>()

  for (const claim of section.claims) {
    if (claim.source !== 'unit') continue
    const parts = claim.key.split('.')
    if (parts.length < 3) continue

    const field = parts[1]
    const unitId = parts.slice(2).join('.')

    const bucket = byUnit.get(unitId) ?? new Map<string, string>()
    bucket.set(field, claim.text)
    byUnit.set(unitId, bucket)
  }

  return Array.from(byUnit.entries())
    .map(([id, fields]) => ({
      id,
      name: fields.get('name') ?? '',
      description: fields.get('description') ?? null,
      facts: ['max_guests', 'bedrooms', 'beds', 'bathrooms', 'size_sqm']
        .map((field) => fields.get(field))
        .filter((value): value is string => Boolean(value)),
    }))
    .filter((unit) => unit.name.length > 0)
}

/** Exported for the studio's preview, which labels each block by kind. */
export { SITE_SECTION_KIND_LABEL }
