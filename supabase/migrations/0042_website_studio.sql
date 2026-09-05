-- ============================================================================
-- 0042_website_studio.sql — ESTIA · the customer's own website, and the one
--                            rule it is not allowed to break
--
-- What this closes
--   0002 and 0012 declared eight grants — `site.view`, `site.edit_content`,
--   `site.edit_design`, `site.manage_seo`, `site.manage_domain`,
--   `site.publish`, `site.rollback`, `site.ai_generate` — and there was
--   nothing behind any of them. No table, no domain, no screen, and two menu
--   entries reading "בקרוב". `src/lib/plans/entitlements.ts` already maps the
--   first six to the `website` entitlement, `site.manage_domain` to
--   `custom_domain` and `site.ai_generate` to `ai_content`, metered
--   separately so a customer can hold a website without paying for
--   generation. This is the schema those grants were declared for; there is
--   deliberately no `website.*` or `page.*` vocabulary anywhere in this file.
--
-- ══ THE ONE RULE THIS SCHEMA IS BUILT AROUND ════════════════════════════════
--
--   A PUBLISHED SENTENCE MUST BE TRACEABLE TO A ROW, AND A VISITOR MUST NEVER
--   SEE AN UNPUBLISHED CHANGE.
--
--   Two halves of one promise, and each is answered by shape rather than by
--   discipline.
--
--   ── Traceable ────────────────────────────────────────────────────────────
--
--   `site_sections.claims` is not prose. It is an array of objects each
--   carrying `key`, `text`, `source`, `sourceId`, `sourceField` and
--   `sourceValue`, and `site_sections_claims_sourced` is a CHECK constraint
--   that refuses to store one whose `source` is canonical and whose `sourceId`
--   is null. A fabricated fact has to arrive in exactly that shape — a
--   sentence asserting it came from a property, naming no property — and the
--   database will not hold it. `src/lib/website/facts.ts` is the only
--   constructor and the constraint is the floor beneath it.
--
--   There is no `generated` member in `site_fact_source`. A model's draft is a
--   proposal, not a source; it becomes `authored` when a person with
--   `site.edit_content` accepts it, and the fact that a model wrote it lives
--   in `site_generation_requests` with the prompt and the facts it was given.
--   A published claim's answer to "who says so?" is never "a language model".
--
--   ── Never seen early ─────────────────────────────────────────────────────
--
--   The public route reads `site_versions.snapshot` and NOTHING ELSE. Not
--   `site_pages`, not `site_sections`, not `site_media` — those tables hand
--   `anon` nothing at all, and there is no policy in this file that would let
--   them. So "a visitor must never see an unpublished change" is not one
--   forgotten `.eq('is_published', true)` away from being false; there is no
--   query for anybody to forget a filter in, because the draft is not
--   reachable from the public path.
--
--   `public.site_public_snapshot` is the one door, it is SECURITY DEFINER, it
--   is the only function in this schema `anon` may execute against site data,
--   and it reads `site_versions` by `sites.published_version_id`. A site whose
--   pointer is null returns a refusal. `src/lib/website/public.test.ts`
--   asserts the draft/published separation from the other side.
--
-- ══ ROLLING BACK TO v3 CREATES v7 ═══════════════════════════════════════════
--
--   It does not delete v4, v5 or v6. A business that rolls back at 21:00
--   because a price was wrong must be able to roll forward at 09:00 once it is
--   fixed, and a rollback that destroyed the intervening versions would have
--   thrown away the work.
--
--   `tg_site_versions_immutable` refuses UPDATE and DELETE on
--   `site_versions` for everybody, and `delete`/`truncate` are revoked from
--   `service_role` too — which carries BYPASSRLS and would otherwise be the
--   one caller a policy cannot stop. A version is what was live; that is
--   evidence, and the same argument 0032 makes about a cancelled order.
--
-- ══ THERE IS EXACTLY ONE AVAILABILITY TRUTH, AND IT IS NOT IN THIS FILE ═════
--
--   The public site sells nights, so it has to answer "is this free?" — and
--   the wrong way to do that is a SQL function in this migration that reads
--   `bookings` and decides. That would be a second availability engine, its
--   definition of "occupying" would drift from
--   `src/lib/booking/availability.ts`, and the day they disagree is the day a
--   villa is sold twice.
--
--   So `site_public_availability_facts` returns FACTS, not answers: the
--   occupying bookings' dates and statuses, the live holds' dates, and the
--   unit's own rules row. `src/lib/website/availability-source.ts` implements
--   the existing `AvailabilitySource` interface over it and the canonical
--   `checkAvailability` decides. Same for money:
--   `site_public_rate_facts` returns the unit's rate columns and `priceStay`
--   computes the quote. This file contains no overlap test, no minimum-nights
--   arithmetic and no price.
--
--   What the projection carries is exactly what `availabilityCalendar`'s own
--   documentation says an external seller may see: taken or not, and by what
--   kind of thing. No guest, no name, no telephone, no reference, no money, no
--   agent, no channel. `site_public_availability_facts_no_guest_columns` in
--   the rehearsal asserts that against the built jsonb keys rather than
--   trusting review.
--
-- ══ A PUBLIC VISITOR NEVER CREATES A BOOKING ════════════════════════════════
--
--   `site_booking_requests` is a REQUEST and the vocabulary says so. A visitor
--   with no account cannot hold a calendar: the GiST exclusion constraint in
--   0009 is what prevents a double booking and it is reached through
--   `defineBookingOperations`, which needs an actor. So the public site
--   produces a request, a person confirms it through the ordinary booking
--   screen, and nothing in this file writes to `bookings`, `holds` or any
--   table 0009 owns.
--
--   The request carries `submission_key` with a unique index, so a visitor who
--   double-taps on a phone with a poor signal creates one request. Idempotency
--   for a caller that has no idempotency store.
--
-- ══ EIGHT GRANTS, AND THEY GENUINELY DIFFER ═════════════════════════════════
--
--   The roles are not a formality. A marketing employee writes copy
--   (`site.edit_content`) and cannot touch the palette. A designer changes the
--   palette (`site.edit_design`) and cannot rewrite the cancellation
--   paragraph. Only `site.publish` puts a sentence in front of a customer, and
--   `site.rollback` is separate from it because taking a live site back to an
--   older version at 21:00 is a different act with a different blast radius.
--   Every policy below names exactly one of them.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units, amenities, property_in_scope),
--   0009 (bookings, holds — read as facts only, never written), 0012 (the
--   eight `site.*` grants), 0014 (the rule that a function in `public` is an
--   API surface until its grants say otherwise), 0033 (the SECURITY DEFINER
--   projection pattern this file follows for `anon`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The vocabularies
-- ============================================================================
-- Transcribed from `src/lib/website/types.ts`, in the same order, and the order
-- is load-bearing: an enum's ordinal is what `order by status` sorts on.
--
-- They live in `src/lib/website/types.ts` rather than in
-- `src/lib/contracts/states.ts` — where every other module's tuples live —
-- for one reason and it is not a design one: `states.ts` belongs to another
-- owner in this wave and this worker may not write it. The report asks for
-- them to be moved. What must never happen is a second copy appearing there
-- while this one stays; when they move, `types.ts` re-exports.

-- SITE_STATUSES, in order.
do $$ begin
  create type public.site_status as enum (
    'draft',
    'published',
    'unpublished'
  );
exception when duplicate_object then null;
end $$;

comment on type public.site_status is
  'draft has never been published. published has a live snapshot. unpublished HAS snapshots and was taken down — distinct from draft, because a business that took its site down has not lost its work.';

-- SITE_PAGE_KINDS, in order.
do $$ begin
  create type public.site_page_kind as enum (
    'home',
    'property',
    'units',
    'amenities',
    'gallery',
    'location',
    'booking',
    'contact',
    'policy',
    'custom'
  );
exception when duplicate_object then null;
end $$;

-- SITE_SECTION_KINDS, in order.
do $$ begin
  create type public.site_section_kind as enum (
    'hero',
    'rich_text',
    'property_intro',
    'unit_grid',
    'amenity_list',
    'gallery',
    'location_map',
    'contact_details',
    'booking_widget',
    'faq',
    'cta'
  );
exception when duplicate_object then null;
end $$;

-- SITE_FACT_SOURCES, in order. THE VOCABULARY THE MODULE TURNS ON.
--
-- Seven canonical sources and one honest human one. There is deliberately no
-- member meaning "we do not know where this came from" and no member meaning
-- "a model wrote it": the first cannot be represented so it cannot be stored,
-- and the second would be a published claim nobody will own.
do $$ begin
  create type public.site_fact_source as enum (
    'organization',
    'property',
    'unit',
    'amenity',
    'pricing',
    'availability',
    'media',
    'authored'
  );
exception when duplicate_object then null;
end $$;

comment on type public.site_fact_source is
  'Where a published sentence came from. Seven canonical rows plus `authored`, which is a person who stands behind it. No `generated` member: a model draft is a proposal and becomes `authored` when somebody accepts it.';

-- SITE_DOMAIN_STATUSES, in order.
do $$ begin
  create type public.site_domain_status as enum (
    'pending',
    'verifying',
    'verified',
    'failed',
    'released'
  );
exception when duplicate_object then null;
end $$;

-- SITE_QUALITY_KINDS, in order. The four passes the specification asks for.
do $$ begin
  create type public.site_quality_kind as enum (
    'content',
    'conversion',
    'technical',
    'pre_publish'
  );
exception when duplicate_object then null;
end $$;

-- SITE_FINDING_SEVERITIES, in order.
do $$ begin
  create type public.site_finding_severity as enum (
    'blocker',
    'warning',
    'advice'
  );
exception when duplicate_object then null;
end $$;

-- SITE_FINDING_STATUSES, in order.
--
-- `not_assessed` is why this list is five long rather than four. A check that
-- cannot be sourced from real data reports it rather than inventing a score:
-- page load time, keyword competitiveness and conversion rate are all
-- unmeasurable in this product today and all three say so.
do $$ begin
  create type public.site_finding_status as enum (
    'open',
    'accepted',
    'dismissed',
    'resolved',
    'not_assessed'
  );
exception when duplicate_object then null;
end $$;

comment on type public.site_finding_status is
  'not_assessed is a first-class outcome. A quality check with no real data behind it reports it rather than producing a score, because a report that scores what it cannot measure is decoration and decoration is what makes people stop reading quality reports.';

-- SITE_GENERATION_STATUSES, in order.
do $$ begin
  create type public.site_generation_status as enum (
    'requested',
    'refused',
    'drafted',
    'accepted',
    'discarded'
  );
exception when duplicate_object then null;
end $$;

comment on type public.site_generation_status is
  'refused is not a failure state. There is no model client in this codebase; the null implementation refuses honestly and the refusal is recorded with its reason so the studio can say so instead of spinning.';

-- SITE_BOOKING_REQUEST_STATUSES, in order.
do $$ begin
  create type public.site_booking_request_status as enum (
    'new',
    'contacted',
    'converted',
    'declined',
    'expired'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 2 · sites — one publishable website
-- ============================================================================
-- `property_id` NULL means the site presents the whole organization, which is
-- the ordinary single-property case. A property set narrows it, and
-- `buildSnapshot` uses that to decide which units the published site may quote
-- — so a two-property business cannot publish a site that accidentally sells
-- the wrong house.
--
-- `slug` is globally unique, not unique per organization. It is the public
-- URL: two tenants cannot both be `/s/galilee`.

create table if not exists public.sites (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  property_id           uuid references public.properties (id) on delete set null,

  slug                  citext not null,
  name                  text not null,
  status                public.site_status not null default 'draft',
  locale                text not null default 'he',

  -- WHAT A VISITOR IS SERVED. NULL until the first publish, and cleared by
  -- unpublishing. The one column the public path reads a site by.
  published_version_id  uuid,
  published_at          timestamptz,
  published_by          uuid references auth.users (id) on delete set null,

  -- Design tokens, bounded. Not CSS: the renderer maps these onto custom
  -- properties from a fixed vocabulary and never interpolates a stored string
  -- into a style attribute. See `src/lib/website/design.ts`.
  design                jsonb not null default '{}'::jsonb,

  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,

  constraint sites_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  constraint sites_name_not_blank check (length(btrim(name)) > 0),
  constraint sites_locale_format check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint sites_version_positive check (version >= 1),

  -- A published site must point at a version, and a draft must not. The status
  -- and the pointer are one fact stored twice, and a row where they disagree
  -- is a public route that either serves nothing or serves a version the
  -- status says was taken down.
  constraint sites_published_has_version check (
    (status = 'published' and published_version_id is not null)
    or (status <> 'published')
  ),
  constraint sites_draft_has_no_version check (
    status <> 'draft' or published_version_id is null
  )
);

comment on table public.sites is
  'One publishable website. published_version_id is the only column the public path reads a site by, which is what makes "a visitor never sees an unpublished change" a property of the shape rather than of every query remembering to filter.';

comment on column public.sites.slug is
  'Globally unique — it is the public URL. Two tenants cannot both be /s/galilee.';

comment on column public.sites.design is
  'Bounded design tokens, never CSS. The renderer maps them from a fixed vocabulary; a stored string is never interpolated into a style attribute.';

create unique index if not exists sites_slug_idx on public.sites (slug);
create index if not exists sites_organization_idx
  on public.sites (organization_id, status);
create index if not exists sites_property_idx
  on public.sites (property_id) where property_id is not null;

drop trigger if exists sites_touch on public.sites;
create trigger sites_touch
  before update on public.sites
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · site_pages — the draft's pages
-- ============================================================================
-- `slug` of `''` is the home page. Written as an empty string rather than as
-- NULL so the unique index below actually constrains it: NULLs do not collide
-- in Postgres, and two home pages is exactly the collision worth preventing.

create table if not exists public.site_pages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,

  slug             text not null default '',
  kind             public.site_page_kind not null default 'custom',
  title            text not null,
  nav_label        text,
  show_in_nav      boolean not null default true,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint site_pages_slug_format
    check (slug = '' or slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint site_pages_title_not_blank check (length(btrim(title)) > 0),
  constraint site_pages_version_positive check (version >= 1)
);

comment on table public.site_pages is
  'The draft''s pages. Never read by the public route — a visitor is served site_versions.snapshot and nothing else.';

comment on column public.site_pages.slug is
  'The empty string is the home page, written as '''' rather than NULL so the unique index constrains it. Two home pages is exactly the collision worth preventing and NULLs do not collide.';

create unique index if not exists site_pages_slug_idx
  on public.site_pages (site_id, slug);
create index if not exists site_pages_site_order_idx
  on public.site_pages (site_id, sort_order);

drop trigger if exists site_pages_touch on public.site_pages;
create trigger site_pages_touch
  before update on public.site_pages
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · site_sections — WHERE THE ONE RULE IS A CONSTRAINT
-- ============================================================================
-- A section does not hold prose. It holds `claims`: an array of objects each
-- carrying where its sentence came from. `site_sections_claims_sourced` below
-- is the floor beneath `src/lib/website/facts.ts` — it refuses to store a
-- claim that says it came from a property and names no property, which is the
-- exact shape a fabricated fact arrives in when somebody writes the row by
-- hand or an import goes wrong.

-- ============================================================================
-- The claims predicate
-- ============================================================================
-- A CHECK constraint cannot contain a subquery, and there is no way to walk a
-- jsonb array without one. So the law lives in an IMMUTABLE function and the
-- constraint calls it: still refused at write time, still "cannot be stored"
-- rather than "is caught by a test".
--
-- Guards the array shape itself rather than trusting the sibling constraint —
-- CHECK constraints have no evaluation order, and `jsonb_array_elements` on an
-- object raises instead of returning false.

create or replace function public.site_claims_are_sourced(p_claims jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when jsonb_typeof(p_claims) <> 'array' then false
    else not exists (
      select 1
      from jsonb_array_elements(p_claims) as element
      where jsonb_typeof(element) <> 'object'
         or coalesce(length(btrim(element ->> 'key')), 0) = 0
         or coalesce(length(btrim(element ->> 'text')), 0) = 0
         or (element ->> 'source') is null
         or (element ->> 'source') not in (
              'organization', 'property', 'unit', 'amenity',
              'pricing', 'availability', 'media', 'authored'
            )
         or coalesce(length(btrim(element ->> 'sourceId')), 0) = 0
    )
  end;
$fn$;

comment on function public.site_claims_are_sourced(jsonb) is
  'The website module''s one law. Every claim carries a non-empty key, a non-empty text, a source in the vocabulary and a non-empty sourceId — authored included, because a sentence nobody is signed to is as unaccountable as an invented one. Called by site_sections_claims_sourced, which cannot hold the subquery itself.';

create table if not exists public.site_sections (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,
  page_id          uuid not null references public.site_pages (id) on delete cascade,

  kind             public.site_section_kind not null,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,

  -- What this section is bound to, when it is bound to something. A
  -- `property_intro` with no binding has nothing to say, and the content
  -- quality pass reports that rather than the renderer inventing a villa.
  bound_source     public.site_fact_source,
  bound_id         uuid,

  -- THE CLAIMS. See the constraint below.
  claims           jsonb not null default '[]'::jsonb,

  -- Presentation only. Never prose, never a fact.
  layout           jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint site_sections_version_positive check (version >= 1),
  constraint site_sections_claims_is_array check (jsonb_typeof(claims) = 'array'),
  constraint site_sections_layout_is_object check (jsonb_typeof(layout) = 'object'),

  -- A binding is a source AND a row, or neither. Half a binding is a section
  -- that believes it is showing a property and cannot say which.
  constraint site_sections_binding_complete check (
    (bound_source is null and bound_id is null)
    or (bound_source is not null and bound_id is not null)
  ),
  -- Only these four are rows a section can be bound to. `pricing` and
  -- `availability` are engine outputs computed live and are never a binding;
  -- `organization` and `authored` are not things a section points at.
  constraint site_sections_binding_source check (
    bound_source is null
    or bound_source in ('property', 'unit', 'amenity', 'media')
  ),

  -- ══ THE MODULE'S LAW, AS A CHECK CONSTRAINT ════════════════════════════
  --
  -- Every element must be an object carrying a non-empty `key`, a non-empty
  -- `text`, a `source` in the enum and a non-empty `sourceId` — including
  -- when the source is `authored`, because an authored claim with nobody
  -- signed to it is exactly as unaccountable as a fabricated one.
  --
  -- Delegated to `site_claims_are_sourced` because a CHECK constraint may not
  -- contain a subquery, and walking a jsonb array needs one. The law is
  -- unchanged and still refuses the write; only where it is written moved.
  --
  -- A row asserting "the villa has a heated pool", tagged as coming from the
  -- property table, naming no property, cannot be stored. Not "is caught by a
  -- test": cannot be stored. `facts.ts` is the only constructor and this is
  -- the floor beneath it, for the day somebody writes the row another way.
  constraint site_sections_claims_sourced
    check (public.site_claims_are_sourced(claims))
);

comment on table public.site_sections is
  'One block on one page. Holds claims rather than prose: every sentence carries key, text, source, sourceId, sourceField and sourceValue. site_sections_claims_sourced refuses a claim that names a canonical source and no row, which is the shape a fabricated fact arrives in.';

comment on column public.site_sections.claims is
  'THE MODULE''S LAW LIVES HERE. Each element: {key, text, source, sourceId, sourceField, sourceValue}. A canonical source with no sourceId is refused by CHECK, and so is an authored claim with nobody signed to it.';

comment on column public.site_sections.layout is
  'Presentation only — alignment, column count, image position. Never prose and never a fact, so nothing here is ever published as a claim.';

create index if not exists site_sections_page_order_idx
  on public.site_sections (page_id, sort_order);
create index if not exists site_sections_site_idx
  on public.site_sections (site_id, is_active);
create index if not exists site_sections_bound_idx
  on public.site_sections (bound_source, bound_id) where bound_id is not null;

drop trigger if exists site_sections_touch on public.site_sections;
create trigger site_sections_touch
  before update on public.site_sections
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · site_seo — one row per page
-- ============================================================================
-- Separate from `site_pages` and gated on `site.manage_seo` rather than
-- `site.edit_content`, because they are different jobs done by different
-- people. A marketing employee writing a paragraph is not the person deciding
-- whether the page is indexable.

create table if not exists public.site_seo (
  page_id           uuid primary key references public.site_pages (id) on delete cascade,
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  site_id           uuid not null references public.sites (id) on delete cascade,

  meta_title        text,
  meta_description  text,
  canonical_url     text,
  og_media_id       uuid,
  -- False keeps the page out of search engines. The default is true because a
  -- website nobody can find is not what a business bought.
  indexable         boolean not null default true,

  keywords          text[] not null default '{}',

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  version           integer not null default 1,

  constraint site_seo_title_length check (
    meta_title is null or length(meta_title) <= 200
  ),
  constraint site_seo_description_length check (
    meta_description is null or length(meta_description) <= 500
  ),
  -- Absolute https only. A canonical pointing at a relative path or an http
  -- URL is a canonical search engines ignore, and one pointing at `javascript:`
  -- is worse than ignored.
  constraint site_seo_canonical_absolute check (
    canonical_url is null or canonical_url ~ '^https://[a-z0-9.-]+(/|$)'
  ),
  constraint site_seo_version_positive check (version >= 1)
);

comment on table public.site_seo is
  'Search metadata, one row per page, gated on site.manage_seo rather than on site.edit_content — writing a paragraph and deciding whether a page is indexable are different jobs done by different people.';

create index if not exists site_seo_site_idx on public.site_seo (site_id);

drop trigger if exists site_seo_touch on public.site_seo;
create trigger site_seo_touch
  before update on public.site_seo
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · site_media — references, not files
-- ============================================================================
-- A row here points at something already stored — a Supabase Storage object, a
-- property's `cover_image_url`. This module stores no bytes and this table has
-- no `data` column.
--
-- `alt_text` is nullable and its absence is a technical quality finding rather
-- than a constraint. A business uploading twelve photographs at 23:00 must not
-- be stopped; it must be told, at the moment it matters, which is before
-- publish.

create table if not exists public.site_media (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,

  url              text not null,
  alt_text         text,
  width            integer,
  height           integer,
  content_type     text,
  sort_order       integer not null default 0,

  -- When the image came from a property or unit row rather than an upload, so
  -- a gallery of the villa's own photographs is traceable like any other fact.
  bound_source     public.site_fact_source,
  bound_id         uuid,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  -- https or a relative path within the deployment. Never `javascript:`,
  -- never `data:` — a data URI in an `<img src>` on a public page is an
  -- unbounded blob served to every visitor.
  constraint site_media_url_shape check (url ~ '^(https://|/)'),
  constraint site_media_dimensions check (
    (width is null or width > 0) and (height is null or height > 0)
  ),
  constraint site_media_binding_complete check (
    (bound_source is null and bound_id is null)
    or (bound_source is not null and bound_id is not null)
  ),
  constraint site_media_version_positive check (version >= 1)
);

comment on table public.site_media is
  'Media REFERENCES. This module stores no bytes and there is no data column. url is https or a deployment-relative path; javascript: and data: are refused by CHECK because an img src on a public page is served to every visitor.';

create index if not exists site_media_site_idx
  on public.site_media (site_id, sort_order);

drop trigger if exists site_media_touch on public.site_media;
create trigger site_media_touch
  before update on public.site_media
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · site_versions — WHAT WAS LIVE, AND IT IS EVIDENCE
-- ============================================================================
-- Append-only, enforced by trigger and by revoked privileges rather than by
-- convention. Rolling back to v3 creates v7 and leaves v4, v5 and v6 exactly
-- where they were; see the header.
--
-- `snapshot` is the whole self-contained document a visitor is served. It
-- carries the pages, the sections, the claims, the media and
-- `bookableUnitIds` — and deliberately carries no availability and no price,
-- because a snapshot of who is free next Tuesday is a lie by Wednesday. Those
-- two are computed live from the canonical engines.

create table if not exists public.site_versions (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  site_id                   uuid not null references public.sites (id) on delete cascade,

  version_number            integer not null,
  label                     text,

  snapshot                  jsonb not null,
  -- Every claim in the snapshot, flattened. What an auditor reads to answer
  -- "on what basis did this page say that?" without parsing the document.
  fact_manifest             jsonb not null default '[]'::jsonb,

  published_at              timestamptz not null default now(),
  published_by              uuid references auth.users (id) on delete set null,
  -- Set when this version was created by rolling back to an earlier one. The
  -- provenance of a rollback, so the history reads as a sequence of publishes.
  restored_from_version_id  uuid references public.site_versions (id) on delete set null,

  created_at                timestamptz not null default now(),

  constraint site_versions_number_positive check (version_number >= 1),
  constraint site_versions_snapshot_is_object check (jsonb_typeof(snapshot) = 'object'),
  constraint site_versions_manifest_is_array check (jsonb_typeof(fact_manifest) = 'array'),
  -- A snapshot with no pages is a published blank site. The pre-publish pass
  -- raises it as a blocker; this is the floor beneath that.
  constraint site_versions_snapshot_has_pages check (
    jsonb_typeof(snapshot -> 'pages') = 'array'
  )
);

comment on table public.site_versions is
  'Immutable published snapshots. The ONLY table the public route reads. Append-only by trigger and by revoked privileges: rolling back to v3 creates v7 and does not delete v4, v5 or v6, because a business that rolls back at 21:00 must be able to roll forward at 09:00.';

comment on column public.site_versions.snapshot is
  'The complete self-contained document a visitor is served. Carries pages, sections, claims, media and bookableUnitIds. Deliberately carries NO availability and NO price — both are computed live from the canonical engines, because a snapshot of who is free next Tuesday is a lie by Wednesday.';

comment on column public.site_versions.restored_from_version_id is
  'Set when this version was created by a rollback. Version numbers only go up and the highest is not necessarily the newest content — that is correct, because the history of what was live is a sequence of publishes and a rollback is one of them.';

create unique index if not exists site_versions_number_idx
  on public.site_versions (site_id, version_number);
create index if not exists site_versions_site_published_idx
  on public.site_versions (site_id, published_at desc);

-- The pointer, added after the table exists. A site's live version must be one
-- of its own versions; `on delete restrict` because deleting the version a
-- site is serving would leave the public route reading nothing.
do $$ begin
  alter table public.sites
    add constraint sites_published_version_fkey
    foreign key (published_version_id)
    references public.site_versions (id) on delete restrict;
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 8 · site_domains — a hostname a business owns
-- ============================================================================
-- Gated on `site.manage_domain`, which carries the `custom_domain`
-- entitlement rather than `website` — a customer can hold a website on the
-- system's own address without paying for a domain, and the entitlement map in
-- `src/lib/plans/entitlements.ts` already says so.

create table if not exists public.site_domains (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  site_id             uuid not null references public.sites (id) on delete cascade,

  hostname            citext not null,
  status              public.site_domain_status not null default 'pending',
  -- What the business puts in a TXT record. Generated here so no application
  -- can choose a weak one.
  verification_token  text not null default encode(gen_random_bytes(24), 'hex'),
  verified_at         timestamptz,
  -- Why verification did not work. "It doesn't work" is the support call this
  -- column exists to prevent.
  failure_reason      text,
  is_primary          boolean not null default false,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  -- A hostname, lowercase, with at least one dot. Refused rather than
  -- normalised: a business that typed `HTTPS://Www.Villa.co.il/` should be
  -- told, not silently given something else.
  constraint site_domains_hostname_format check (
    hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint site_domains_token_length check (length(verification_token) >= 32),
  constraint site_domains_verified_pair check (
    (status = 'verified') = (verified_at is not null)
  ),
  constraint site_domains_version_positive check (version >= 1)
);

comment on table public.site_domains is
  'Custom hostnames. Globally unique — two tenants cannot both claim villa.co.il. Only a `verified` domain resolves on the public path.';

-- Globally unique: two tenants cannot both claim `villa.co.il`. A released
-- domain does not hold the name, so a business that gave one up frees it.
create unique index if not exists site_domains_hostname_idx
  on public.site_domains (hostname) where status <> 'released';
create index if not exists site_domains_site_idx on public.site_domains (site_id);
-- One primary per site.
create unique index if not exists site_domains_primary_idx
  on public.site_domains (site_id) where is_primary;

drop trigger if exists site_domains_touch on public.site_domains;
create trigger site_domains_touch
  before update on public.site_domains
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 9 · site_generation_requests — what was asked of a model, and what it said
-- ============================================================================
-- The history a `SiteClaim` deliberately does not carry. A published sentence
-- is `authored` by the person who accepted it; the fact that a model drafted
-- it is here, with the prompt, the facts it was given and its answer.
--
-- `offered_facts` is the closed world the generator was handed. Recorded
-- because "the model invented a heated pool" and "we told the model there was
-- a heated pool" are different incidents and only this column can tell them
-- apart.

create table if not exists public.site_generation_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,
  section_id       uuid references public.site_sections (id) on delete set null,

  status           public.site_generation_status not null default 'requested',
  -- A stable name, so a row written today is distinguishable from one written
  -- after somebody wires a real provider. The null implementation is `none`.
  provider         text not null default 'none',

  instruction      text,
  tone             text not null default 'warm',
  offered_facts    jsonb not null default '[]'::jsonb,
  drafts           jsonb not null default '[]'::jsonb,
  -- Hebrew, and shown to the person. A refusal is an ordinary outcome.
  refusal_reason   text,
  -- Drafts dropped because they cited a fact that was never offered. The
  -- record that grounding refused something, which is the interesting half.
  rejected_drafts  jsonb not null default '[]'::jsonb,

  requested_at     timestamptz not null default now(),
  requested_by     uuid references auth.users (id) on delete set null,
  resolved_at      timestamptz,

  constraint site_generation_tone check (
    tone in ('warm', 'plain', 'upscale', 'family')
  ),
  constraint site_generation_refusal_reason check (
    status <> 'refused' or refusal_reason is not null
  ),
  constraint site_generation_facts_array check (
    jsonb_typeof(offered_facts) = 'array'
    and jsonb_typeof(drafts) = 'array'
    and jsonb_typeof(rejected_drafts) = 'array'
  )
);

comment on table public.site_generation_requests is
  'What was asked of a generator and what it answered. offered_facts is the closed world it was handed — recorded because "the model invented a fact" and "we told the model that fact" are different incidents and only this column separates them.';

create index if not exists site_generation_site_idx
  on public.site_generation_requests (site_id, requested_at desc);

-- Append-only in the same sense as the versions: a generation request is the
-- record of what a model was asked. It may be resolved (status and drafts
-- move) but never deleted.
revoke delete, truncate on public.site_generation_requests from service_role;


-- ============================================================================
-- 10 · site_quality_runs / site_quality_findings
-- ============================================================================
-- Findings a person reads and decides about, not a score. `not_assessed` is a
-- status a finding can carry, and several checks return it deliberately —
-- page load time, keyword competitiveness and conversion rate are unmeasurable
-- in this product and all three say so rather than inventing a number.

create table if not exists public.site_quality_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,

  kind             public.site_quality_kind not null,
  ran_at           timestamptz not null default now(),
  ran_by           uuid references auth.users (id) on delete set null,
  -- Counts, never a score. blockers / warnings / advice / notAssessed.
  summary          jsonb not null default '{}'::jsonb,

  constraint site_quality_runs_summary_object check (jsonb_typeof(summary) = 'object')
);

comment on table public.site_quality_runs is
  'One execution of one quality pass. summary carries counts — blockers, warnings, advice, notAssessed — and never a score, because a score over checks that could not be measured is decoration.';

create index if not exists site_quality_runs_site_idx
  on public.site_quality_runs (site_id, ran_at desc);

create table if not exists public.site_quality_findings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  run_id           uuid not null references public.site_quality_runs (id) on delete cascade,

  check_code       text not null,
  kind             public.site_quality_kind not null,
  severity         public.site_finding_severity not null,
  status           public.site_finding_status not null default 'open',

  title            text not null,
  detail           text not null,
  page_slug        text,
  section_id       uuid references public.site_sections (id) on delete set null,

  decided_at       timestamptz,
  decided_by       uuid references auth.users (id) on delete set null,

  constraint site_quality_findings_code_format check (
    check_code ~ '^[a-z_]+\.[a-z_]+$'
  ),
  constraint site_quality_findings_title_not_blank check (
    length(btrim(title)) > 0
  ),
  -- A decision has a decider. An accepted finding nobody signed is a finding
  -- that will be argued about.
  constraint site_quality_findings_decided_pair check (
    status not in ('accepted', 'dismissed') or decided_at is not null
  )
);

comment on column public.site_quality_findings.status is
  'not_assessed means the check had no real data behind it and declined to score. It never blocks a publish; only an OPEN blocker does.';

create index if not exists site_quality_findings_run_idx
  on public.site_quality_findings (run_id, severity);


-- ============================================================================
-- 11 · site_booking_requests — an enquiry, and never a booking
-- ============================================================================
-- A visitor with no account cannot hold a calendar. The GiST exclusion
-- constraint in 0009 is what prevents a double booking and it is reached
-- through `defineBookingOperations`, which needs an actor. So the public site
-- produces a request, a person confirms it through the ordinary booking
-- screen, and nothing in this file writes to `bookings` or `holds`.
--
-- `quoted_total_agorot` is a SNAPSHOT of what the visitor was shown, the same
-- argument 0032 makes about an order line: the business must be able to honour
-- what was on screen, and re-deriving it from today's rates three days later
-- would produce a different number and an argument.

create table if not exists public.site_booking_requests (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  site_id              uuid not null references public.sites (id) on delete cascade,
  property_id          uuid references public.properties (id) on delete set null,
  unit_id              uuid references public.units (id) on delete set null,

  check_in             date not null,
  check_out            date not null,
  adults               integer not null default 2,
  children             integer not null default 0,
  infants              integer not null default 0,

  contact_name         text not null,
  contact_phone        text not null,
  contact_email        citext,
  message              text,

  status               public.site_booking_request_status not null default 'new',
  -- What the visitor was shown. Never re-derived on read.
  quoted_total_agorot  integer,
  quoted_currency      text not null default 'ILS',

  -- Idempotency for a caller with no idempotency store. A visitor who
  -- double-taps on a phone with a poor signal creates one request.
  submission_key       text not null,

  -- The booking a person eventually created from this, when they did.
  converted_booking_id uuid references public.bookings (id) on delete set null,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,

  constraint site_booking_requests_range check (check_out > check_in),
  constraint site_booking_requests_party check (
    adults >= 1 and children >= 0 and infants >= 0
    and adults + children + infants <= 100
  ),
  constraint site_booking_requests_name check (
    length(btrim(contact_name)) between 2 and 200
  ),
  constraint site_booking_requests_phone check (
    length(btrim(contact_phone)) between 6 and 40
  ),
  constraint site_booking_requests_quote check (
    quoted_total_agorot is null or quoted_total_agorot >= 0
  ),
  constraint site_booking_requests_submission_key check (
    length(submission_key) between 16 and 128
  ),
  constraint site_booking_requests_converted check (
    status = 'converted' or converted_booking_id is null
  ),
  constraint site_booking_requests_version_positive check (version >= 1)
);

comment on table public.site_booking_requests is
  'A direct enquiry from the public site. NOT a booking: a visitor with no account cannot hold a calendar, so this is a request a person confirms through the ordinary booking screen. Nothing in 0042 writes to bookings or holds.';

comment on column public.site_booking_requests.quoted_total_agorot is
  'What the visitor was shown, in agorot. A snapshot, never re-derived — the same argument 0032 makes about an order line.';

create unique index if not exists site_booking_requests_submission_idx
  on public.site_booking_requests (site_id, submission_key);
create index if not exists site_booking_requests_site_status_idx
  on public.site_booking_requests (site_id, status, created_at desc);
create index if not exists site_booking_requests_organization_idx
  on public.site_booking_requests (organization_id, created_at desc);

drop trigger if exists site_booking_requests_touch on public.site_booking_requests;
create trigger site_booking_requests_touch
  before update on public.site_booking_requests
  for each row execute function public.tg_touch_row();

-- An enquiry that arrived is a thing that happened. Declined, not deleted.
revoke delete, truncate on public.site_booking_requests from service_role;


-- ============================================================================
-- 12 · The trigger that makes a version immutable
-- ============================================================================

create or replace function public.tg_site_versions_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A published version is what was live. Changing it rewrites history, and
  -- deleting it removes the thing a rollback exists to return to. Refused for
  -- everybody: this trigger runs for the table owner and for `service_role`,
  -- which carries BYPASSRLS and would otherwise be the one caller no policy
  -- can stop.
  raise exception
    'site_versions is append-only — a published version is the record of what was live'
    using hint = 'כדי לחזור לגרסה קודמת השתמשו בשחזור, שיוצר גרסה חדשה ואינו מוחק דבר.',
          errcode = 'P0001';
  return null;
end;
$$;

comment on function public.tg_site_versions_immutable() is
  'Refuses UPDATE and DELETE on site_versions. Rolling back creates a new version; it never edits or removes an old one.';

revoke all on function public.tg_site_versions_immutable() from public, anon, authenticated, service_role;

drop trigger if exists site_versions_immutable on public.site_versions;
create trigger site_versions_immutable
  before update or delete on public.site_versions
  for each row execute function public.tg_site_versions_immutable();


-- ============================================================================
-- 13 · Row level security
-- ============================================================================

alter table public.sites                    enable row level security;
alter table public.sites                    force row level security;
alter table public.site_pages               enable row level security;
alter table public.site_pages               force row level security;
alter table public.site_sections            enable row level security;
alter table public.site_sections            force row level security;
alter table public.site_seo                 enable row level security;
alter table public.site_seo                 force row level security;
alter table public.site_media               enable row level security;
alter table public.site_media               force row level security;
alter table public.site_versions            enable row level security;
alter table public.site_versions            force row level security;
alter table public.site_domains             enable row level security;
alter table public.site_domains             force row level security;
alter table public.site_generation_requests enable row level security;
alter table public.site_generation_requests force row level security;
alter table public.site_quality_runs        enable row level security;
alter table public.site_quality_runs        force row level security;
alter table public.site_quality_findings    enable row level security;
alter table public.site_quality_findings    force row level security;
alter table public.site_booking_requests    enable row level security;
alter table public.site_booking_requests    force row level security;

-- 0014's discipline: revoke from anon and authenticated first, then hand back
-- exactly what the policies are written for.
--
-- `anon` gets NOTHING on any of these, and that is the second half of "a
-- visitor never sees an unpublished change". The public route does not read a
-- table; it executes one SECURITY DEFINER function, which is the only door.

revoke all on public.sites                    from anon, authenticated;
revoke all on public.site_pages               from anon, authenticated;
revoke all on public.site_sections            from anon, authenticated;
revoke all on public.site_seo                 from anon, authenticated;
revoke all on public.site_media               from anon, authenticated;
revoke all on public.site_versions            from anon, authenticated;
revoke all on public.site_domains             from anon, authenticated;
revoke all on public.site_generation_requests from anon, authenticated;
revoke all on public.site_quality_runs        from anon, authenticated;
revoke all on public.site_quality_findings    from anon, authenticated;
revoke all on public.site_booking_requests    from anon, authenticated;

grant select, insert, update, delete on public.sites                    to authenticated;
grant select, insert, update, delete on public.site_pages               to authenticated;
grant select, insert, update, delete on public.site_sections            to authenticated;
grant select, insert, update, delete on public.site_seo                 to authenticated;
grant select, insert, update, delete on public.site_media               to authenticated;
grant select, insert                 on public.site_versions            to authenticated;
grant select, insert, update, delete on public.site_domains             to authenticated;
grant select, insert, update         on public.site_generation_requests to authenticated;
grant select, insert                 on public.site_quality_runs        to authenticated;
grant select, insert, update         on public.site_quality_findings    to authenticated;
grant select,         update         on public.site_booking_requests    to authenticated;

grant select, insert, update, delete on public.sites                    to service_role;
grant select, insert, update, delete on public.site_pages               to service_role;
grant select, insert, update, delete on public.site_sections            to service_role;
grant select, insert, update, delete on public.site_seo                 to service_role;
grant select, insert, update, delete on public.site_media               to service_role;
grant select, insert                 on public.site_versions            to service_role;
grant select, insert, update, delete on public.site_domains             to service_role;
grant select, insert, update         on public.site_generation_requests to service_role;
grant select, insert, update, delete on public.site_quality_runs        to service_role;
grant select, insert, update, delete on public.site_quality_findings    to service_role;
grant select,         update         on public.site_booking_requests    to service_role;

-- The evidence, revoked from service_role too. A version is what was live, a
-- generation request is what a model was asked, and an enquiry is a thing that
-- happened.
revoke delete, truncate on public.site_versions from authenticated, service_role;
revoke update           on public.site_versions from authenticated, service_role;


-- ── Policies · sites ──────────────────────────────────────────────────────
-- Read on `site.view`. Creating and renaming a site is `site.edit_content` —
-- the same grant as writing a page, because a site with no pages is not a
-- separate act. Deleting is `site.publish`, which is deliberately the
-- strictest of the content grants: removing a site removes what is live.

drop policy if exists sites_select on public.sites;
create policy sites_select on public.sites
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists sites_insert on public.sites;
create policy sites_insert on public.sites
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'site.edit_content')
  );

-- UPDATE is the widest policy in the file on purpose. Four different grants
-- write different columns of this one row — content renames it, design writes
-- `design`, publish moves `published_version_id`, rollback moves it back — and
-- Postgres column privileges do not compose with RLS in a way anybody can read
-- six months later. So the policy admits any of the four and the OPERATION
-- layer asserts which one, per column, in `src/lib/website/operations.ts`.
-- That is the same choice 0032 documents for `product.price_manage`.
drop policy if exists sites_update on public.sites;
create policy sites_update on public.sites
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (public.has_permission(organization_id, 'site.edit_content')
         or public.has_permission(organization_id, 'site.edit_design')
         or public.has_permission(organization_id, 'site.publish')
         or public.has_permission(organization_id, 'site.rollback'))
  )
  with check (
    organization_id in (select public.my_organizations())
    and (public.has_permission(organization_id, 'site.edit_content')
         or public.has_permission(organization_id, 'site.edit_design')
         or public.has_permission(organization_id, 'site.publish')
         or public.has_permission(organization_id, 'site.rollback'))
  );

drop policy if exists sites_delete on public.sites;
create policy sites_delete on public.sites
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.publish')
  );


-- ── Policies · site_pages, site_sections, site_media ──────────────────────
-- One shape: read on `site.view`, write on `site.edit_content`. Written out
-- per table rather than generated, because a policy a reader cannot see in
-- full is a policy nobody audits.

drop policy if exists site_pages_select on public.site_pages;
create policy site_pages_select on public.site_pages
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_pages_write on public.site_pages;
create policy site_pages_write on public.site_pages
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );

drop policy if exists site_sections_select on public.site_sections;
create policy site_sections_select on public.site_sections
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_sections_write on public.site_sections;
create policy site_sections_write on public.site_sections
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );

drop policy if exists site_media_select on public.site_media;
create policy site_media_select on public.site_media
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_media_write on public.site_media;
create policy site_media_write on public.site_media
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );


-- ── Policies · site_seo ───────────────────────────────────────────────────
-- WRITING SEO IS `site.manage_seo`, NOT `site.edit_content`.
--
-- The asymmetry is the point of having the grant at all. A marketing employee
-- who writes the paragraph is not necessarily the person who decides whether
-- the page is indexable, and the way to guarantee that is not a screen hiding
-- a field — it is a policy refusing the write.

drop policy if exists site_seo_select on public.site_seo;
create policy site_seo_select on public.site_seo
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_seo_write on public.site_seo;
create policy site_seo_write on public.site_seo
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.manage_seo')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.manage_seo')
  );


-- ── Policies · site_versions ──────────────────────────────────────────────
-- Reading history is `site.view`. Writing one is `site.publish` OR
-- `site.rollback`, because a rollback creates a version and its holder must be
-- able to. UPDATE and DELETE have no policy at all and no privilege — the
-- trigger refuses them anyway, and a policy would suggest there is a case
-- where they are allowed.

drop policy if exists site_versions_select on public.site_versions;
create policy site_versions_select on public.site_versions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_versions_insert on public.site_versions;
create policy site_versions_insert on public.site_versions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (public.has_permission(organization_id, 'site.publish')
         or public.has_permission(organization_id, 'site.rollback'))
  );


-- ── Policies · site_domains ───────────────────────────────────────────────
-- READING A DOMAIN IS `site.manage_domain`, NOT `site.view`.
--
-- The same asymmetry 0032 makes about providers. A verification token is a
-- credential — anybody holding it can prove control of a hostname to this
-- system — and the way to keep a copywriter from having it is a policy that
-- returns no rows, not a screen omitting a column.

drop policy if exists site_domains_select on public.site_domains;
create policy site_domains_select on public.site_domains
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.manage_domain')
  );

drop policy if exists site_domains_write on public.site_domains;
create policy site_domains_write on public.site_domains
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.manage_domain')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.manage_domain')
  );


-- ── Policies · site_generation_requests ───────────────────────────────────
-- Reading what was asked of a model is `site.view` — the history is part of
-- the site. Asking is `site.ai_generate`, which carries the `ai_content`
-- entitlement and is metered separately, so a customer can hold a website
-- without paying for generation and every other screen still works.

drop policy if exists site_generation_requests_select on public.site_generation_requests;
create policy site_generation_requests_select on public.site_generation_requests
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_generation_requests_insert on public.site_generation_requests;
create policy site_generation_requests_insert on public.site_generation_requests
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.ai_generate')
  );

-- Accepting a draft is a CONTENT act, not a generation act: it is the moment a
-- model's proposal becomes a sentence a person owns. So the update that marks
-- a request `accepted` or `discarded` is gated on `site.edit_content`, which
-- is the grant that also writes the resulting claim.
drop policy if exists site_generation_requests_update on public.site_generation_requests;
create policy site_generation_requests_update on public.site_generation_requests
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );


-- ── Policies · quality ────────────────────────────────────────────────────
-- Anybody who may see the site may see its findings. Running a pass and
-- deciding about a finding are `site.edit_content`: a finding is about the
-- content, and the person who fixes it is the person who wrote it.

drop policy if exists site_quality_runs_select on public.site_quality_runs;
create policy site_quality_runs_select on public.site_quality_runs
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_quality_runs_insert on public.site_quality_runs;
create policy site_quality_runs_insert on public.site_quality_runs
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );

drop policy if exists site_quality_findings_select on public.site_quality_findings;
create policy site_quality_findings_select on public.site_quality_findings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.view')
  );

drop policy if exists site_quality_findings_write on public.site_quality_findings;
create policy site_quality_findings_write on public.site_quality_findings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'site.edit_content')
  );


-- ── Policies · site_booking_requests ──────────────────────────────────────
-- READING AN ENQUIRY IS `booking.view`, NOT `site.view`.
--
-- Deliberate, and the most important policy in this file after the claims
-- constraint. An enquiry carries a name, a telephone number and an email
-- address — it is guest data that happens to have arrived through a website,
-- and a copywriter holding `site.view` has no business reading it. The grant
-- that governs somebody's contact details is the one that governs bookings.
--
-- There is no INSERT policy at all. A visitor has no `auth.uid()` and no
-- membership, so no policy could express "this stranger may create this row";
-- the insert happens inside `site_public_booking_request`, which is SECURITY
-- DEFINER and validates the site and the dates itself.

drop policy if exists site_booking_requests_select on public.site_booking_requests;
create policy site_booking_requests_select on public.site_booking_requests
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists site_booking_requests_update on public.site_booking_requests;
create policy site_booking_requests_update on public.site_booking_requests
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'booking.update')
  );


-- ============================================================================
-- 14 · The public door — three functions, and they are the ONLY one
-- ============================================================================
-- `anon` holds no privilege on any table above. Everything a visitor can reach
-- goes through these, each SECURITY DEFINER, each returning a hand-picked
-- projection rather than a row, and each refusing before it reads anything.
--
-- The same pattern 0033 established for the guest portal, for the same reason:
-- a visitor has no `auth.uid()` and no policy can express "the published
-- version of this one site".

-- ── 14.1 · The published snapshot ────────────────────────────────────────
--
-- THE ONE PLACE A VISITOR'S REQUEST TOUCHES SITE DATA.
--
-- It reads `site_versions` BY `sites.published_version_id`. It does not read
-- `site_pages`, `site_sections`, `site_media` or `site_seo`, and it could not
-- serve a draft if it wanted to — there is no join to any of them in this
-- function. That is what makes the guarantee structural.
--
-- `p_host` accepts either a slug or a verified custom hostname, resolved in
-- that order, so `/s/galilee` and `https://villa.co.il` serve the same
-- document through the same code.

create or replace function public.site_public_snapshot(p_host text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site     public.sites%rowtype;
  v_snapshot jsonb;
begin
  if p_host is null or length(btrim(p_host)) = 0 then
    raise exception 'site_not_found'
      using hint = 'הכתובת אינה תקינה.', errcode = 'P0002';
  end if;

  -- By slug first. The system's own address is the one that always works,
  -- including while a custom domain is still verifying.
  select * into v_site
  from public.sites
  where slug = btrim(lower(p_host))::citext;

  if not found then
    -- Then by a VERIFIED custom hostname. `verified` and nothing else: a
    -- pending domain that resolved by accident must not serve somebody's site
    -- at an address they have not proven they control.
    select s.* into v_site
    from public.sites s
    join public.site_domains d
      on d.site_id = s.id
     and d.status = 'verified'
     and d.hostname = btrim(lower(p_host))::citext
    limit 1;
  end if;

  if not found then
    raise exception 'site_not_found'
      using hint = 'לא מצאנו אתר בכתובת הזו.', errcode = 'P0002';
  end if;

  -- THE DRAFT GATE. A site that has never been published, or that was taken
  -- down, has no pointer — and a visitor gets a refusal rather than the
  -- editor's work in progress.
  if v_site.published_version_id is null then
    raise exception 'site_not_published'
      using hint = 'האתר עדיין אינו באוויר.', errcode = 'P0003';
  end if;

  select v.snapshot into v_snapshot
  from public.site_versions v
  where v.id = v_site.published_version_id
    and v.site_id = v_site.id;

  if v_snapshot is null then
    raise exception 'site_not_published'
      using hint = 'האתר עדיין אינו באוויר.', errcode = 'P0003';
  end if;

  return jsonb_build_object(
    'siteId',        v_site.id,
    'slug',          v_site.slug,
    'versionId',     v_site.published_version_id,
    'publishedAt',   v_site.published_at,
    'snapshot',      v_snapshot
  );
end;
$$;

comment on function public.site_public_snapshot(text) is
  'The ONE door a public visitor reaches site data through. Reads site_versions by sites.published_version_id and joins to no draft table, so it could not serve an unpublished change if a caller asked it to. Accepts a slug or a VERIFIED custom hostname.';


-- ── 14.2 · Availability FACTS, and not an availability answer ────────────
--
-- THIS FUNCTION DECIDES NOTHING.
--
-- It returns the rows `src/lib/booking/availability.ts` needs and stops. No
-- overlap test, no minimum-nights arithmetic, no `available: true`. The
-- canonical engine is in TypeScript, it is the only one, and duplicating a
-- fragment of it here is how a villa gets sold twice.
--
-- The projection is exactly what `availabilityCalendar` documents as visible
-- to an external seller: taken or not, and by what kind of thing. No guest, no
-- name, no telephone, no reference, no money, no agent, no channel. The
-- rehearsal asserts that against the built keys.
--
-- `p_unit_id` must be in the PUBLISHED snapshot's `bookableUnitIds`. That is
-- what stops a draft leaking through the booking widget: adding a unit to a
-- draft page does not add it to the published snapshot, so the live site
-- refuses to quote it.

create or replace function public.site_public_availability_facts(
  p_host    text,
  p_unit_id uuid,
  p_from    date,
  p_to      date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site      public.sites%rowtype;
  v_snapshot  jsonb;
  v_unit      public.units%rowtype;
  v_bookings  jsonb;
  v_holds     jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'site_range_invalid'
      using hint = 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.', errcode = 'P0006';
  end if;

  -- A window nobody legitimately asks for. Not a business rule — a bound, so
  -- an anonymous caller cannot ask for ten years of one unit's calendar in a
  -- loop.
  if p_to - p_from > 400 then
    raise exception 'site_range_too_wide'
      using hint = 'טווח התאריכים רחב מדי.', errcode = 'P0006';
  end if;

  select * into v_site from public.sites
  where slug = btrim(lower(p_host))::citext;

  if not found then
    select s.* into v_site
    from public.sites s
    join public.site_domains d
      on d.site_id = s.id and d.status = 'verified'
     and d.hostname = btrim(lower(p_host))::citext
    limit 1;
  end if;

  if not found or v_site.published_version_id is null then
    raise exception 'site_not_published'
      using hint = 'האתר אינו באוויר.', errcode = 'P0003';
  end if;

  select v.snapshot into v_snapshot
  from public.site_versions v
  where v.id = v_site.published_version_id and v.site_id = v_site.id;

  -- THE DRAFT GATE, AGAIN, ON THE BOOKING PATH. The published snapshot's own
  -- list — never the live `sites` row, never the draft sections.
  --
  -- `jsonb_exists(...)` rather than the `?` operator it reads as in every
  -- Postgres document. `?` is a bind placeholder to a number of SQL drivers,
  -- and a migration applied through one of them breaks on a character that
  -- means something entirely different here. The function form is identical to
  -- Postgres and unambiguous to everything else.
  if v_snapshot is null
     or not jsonb_exists(v_snapshot -> 'bookableUnitIds', p_unit_id::text) then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה מוצעת להזמנה באתר.', errcode = 'P0008';
  end if;

  select * into v_unit
  from public.units
  where id = p_unit_id
    and organization_id = v_site.organization_id
    and deleted_at is null;

  if not found or v_unit.status <> 'active' then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה זמינה כרגע.', errcode = 'P0008';
  end if;

  -- Bookings, as availability sees them: dates and a status. NOT filtered by
  -- status here — the engine decides what occupies, over `OCCUPYING_STATUSES`,
  -- and a WHERE clause that drifted from that definition could make dates
  -- appear free. Over-returning is explicitly fine; the interface says so.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',       b.id,
           'status',   b.status,
           'checkIn',  b.check_in,
           'checkOut', b.check_out
         )), '[]'::jsonb)
  into v_bookings
  from public.bookings b
  where b.unit_id = p_unit_id
    and b.organization_id = v_site.organization_id
    and b.deleted_at is null
    and b.check_in < p_to
    and b.check_out > p_from;

  -- Holds, expired ones included. `isHoldLive` decides, in the engine.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                   h.id,
           'organizationId',       h.organization_id,
           'unitId',               h.unit_id,
           'checkIn',              h.check_in,
           'checkOut',             h.check_out,
           'reason',               h.reason,
           'heldByUserId',         h.held_by_user_id,
           'expiresAt',            h.expires_at,
           'releasedAt',           h.released_at,
           'convertedToBookingId', h.converted_to_booking_id
         )), '[]'::jsonb)
  into v_holds
  from public.holds h
  where h.unit_id = p_unit_id
    and h.organization_id = v_site.organization_id
    and h.check_in < p_to
    and h.check_out > p_from;

  return jsonb_build_object(
    'unitId',   v_unit.id,
    'rules', jsonb_build_object(
      'unitId',         v_unit.id,
      'minimumNights',  v_unit.min_nights,
      'metadata',       v_unit.metadata
    ),
    'bookings', v_bookings,
    'holds',    v_holds
  );
end;
$$;

comment on function public.site_public_availability_facts(text, uuid, date, date) is
  'Returns the FACTS src/lib/booking/availability.ts needs and decides nothing. No overlap test, no minimum-nights arithmetic, no available flag — there is exactly one availability engine and it is in TypeScript. The projection carries no guest, name, telephone, reference, money, agent or channel, and the unit must be in the PUBLISHED snapshot''s bookableUnitIds.';


-- ── 14.3 · Rate FACTS, and not a price ──────────────────────────────────
--
-- Same argument as availability. `priceStay` in `src/lib/booking/pricing.ts`
-- is the only thing in this product that turns a rate into a total, and this
-- function returns the columns it reads. No multiplication happens here.

create or replace function public.site_public_rate_facts(
  p_host    text,
  p_unit_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_site     public.sites%rowtype;
  v_snapshot jsonb;
  v_unit     public.units%rowtype;
  v_property public.properties%rowtype;
begin
  select * into v_site from public.sites
  where slug = btrim(lower(p_host))::citext;

  if not found then
    select s.* into v_site
    from public.sites s
    join public.site_domains d
      on d.site_id = s.id and d.status = 'verified'
     and d.hostname = btrim(lower(p_host))::citext
    limit 1;
  end if;

  if not found or v_site.published_version_id is null then
    raise exception 'site_not_published'
      using hint = 'האתר אינו באוויר.', errcode = 'P0003';
  end if;

  select v.snapshot into v_snapshot
  from public.site_versions v
  where v.id = v_site.published_version_id and v.site_id = v_site.id;

  if v_snapshot is null
     or not jsonb_exists(v_snapshot -> 'bookableUnitIds', p_unit_id::text) then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה מוצעת להזמנה באתר.', errcode = 'P0008';
  end if;

  select * into v_unit
  from public.units
  where id = p_unit_id
    and organization_id = v_site.organization_id
    and deleted_at is null;

  if not found or v_unit.status <> 'active' then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה זמינה כרגע.', errcode = 'P0008';
  end if;

  select * into v_property from public.properties
  where id = v_unit.property_id and organization_id = v_site.organization_id;

  return jsonb_build_object(
    'unitId',                  v_unit.id,
    'unitName',                v_unit.name,
    'propertyId',              v_unit.property_id,
    'baseNightlyAgorot',       v_unit.base_price_agorot,
    'extraGuestNightlyAgorot', v_unit.extra_guest_price_agorot,
    'cleaningFeeAgorot',       v_unit.cleaning_fee_agorot,
    'depositAgorot',           v_unit.deposit_agorot,
    'standardGuests',          v_unit.standard_guests,
    'maxGuests',               v_unit.max_guests,
    'minNights',               v_unit.min_nights,
    'currency',                coalesce(v_property.currency, 'ILS'),
    'taxRateBps',              coalesce(v_property.tax_rate_bps, 0),
    'taxIncludedInPrice',      coalesce(v_property.tax_included_in_price, true)
  );
end;
$$;

comment on function public.site_public_rate_facts(text, uuid) is
  'Returns the rate columns priceStay reads. No multiplication happens here — there is one pricing engine and it is in TypeScript.';


-- ── 14.4 · An enquiry from a stranger ────────────────────────────────────
--
-- Writes to `site_booking_requests` and to nothing else. It does not create a
-- booking, does not place a hold and does not touch the calendar: a visitor
-- with no account cannot hold a night, and the exclusion constraint in 0009 is
-- reached through the operation layer with an actor.
--
-- Idempotent on `submission_key`, so a double-tap on a poor signal creates one
-- request. The existing row's id comes back rather than a conflict, because a
-- visitor who has already sent their enquiry should see "we have it", not an
-- error.

create or replace function public.site_public_booking_request(
  p_host           text,
  p_unit_id        uuid,
  p_check_in       date,
  p_check_out      date,
  p_adults         integer,
  p_children       integer,
  p_infants        integer,
  p_contact_name   text,
  p_contact_phone  text,
  p_contact_email  text,
  p_message        text,
  p_quoted_agorot  integer,
  p_submission_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_site     public.sites%rowtype;
  v_snapshot jsonb;
  v_unit     public.units%rowtype;
  v_existing public.site_booking_requests%rowtype;
  v_id       uuid;
begin
  if p_submission_key is null or length(btrim(p_submission_key)) < 16 then
    raise exception 'site_request_invalid'
      using hint = 'הבקשה אינה תקינה. רעננו את הדף ונסו שוב.', errcode = 'P0006';
  end if;

  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    raise exception 'site_range_invalid'
      using hint = 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.', errcode = 'P0006';
  end if;

  select * into v_site from public.sites
  where slug = btrim(lower(p_host))::citext;

  if not found then
    select s.* into v_site
    from public.sites s
    join public.site_domains d
      on d.site_id = s.id and d.status = 'verified'
     and d.hostname = btrim(lower(p_host))::citext
    limit 1;
  end if;

  if not found or v_site.published_version_id is null then
    raise exception 'site_not_published'
      using hint = 'האתר אינו באוויר.', errcode = 'P0003';
  end if;

  -- Idempotency, checked before anything is validated further: a repeat of a
  -- request that already landed is a success, not a second validation pass.
  select * into v_existing
  from public.site_booking_requests
  where site_id = v_site.id and submission_key = btrim(p_submission_key);

  if found then
    return jsonb_build_object(
      'requestId', v_existing.id, 'deduplicated', true
    );
  end if;

  select v.snapshot into v_snapshot
  from public.site_versions v
  where v.id = v_site.published_version_id and v.site_id = v_site.id;

  if v_snapshot is null
     or not jsonb_exists(v_snapshot -> 'bookableUnitIds', p_unit_id::text) then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה מוצעת להזמנה באתר.', errcode = 'P0008';
  end if;

  select * into v_unit
  from public.units
  where id = p_unit_id
    and organization_id = v_site.organization_id
    and deleted_at is null;

  if not found or v_unit.status <> 'active' then
    raise exception 'site_unit_not_bookable'
      using hint = 'היחידה הזו אינה זמינה כרגע.', errcode = 'P0008';
  end if;

  insert into public.site_booking_requests (
    organization_id, site_id, property_id, unit_id,
    check_in, check_out, adults, children, infants,
    contact_name, contact_phone, contact_email, message,
    quoted_total_agorot, submission_key
  ) values (
    v_site.organization_id, v_site.id, v_unit.property_id, v_unit.id,
    p_check_in, p_check_out,
    greatest(coalesce(p_adults, 2), 1),
    greatest(coalesce(p_children, 0), 0),
    greatest(coalesce(p_infants, 0), 0),
    btrim(p_contact_name), btrim(p_contact_phone),
    nullif(btrim(coalesce(p_contact_email, '')), '')::citext,
    nullif(btrim(coalesce(p_message, '')), ''),
    p_quoted_agorot, btrim(p_submission_key)
  )
  on conflict (site_id, submission_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Somebody else's insert of the same key won the race. That is the
    -- idempotent outcome, not a failure.
    select id into v_id from public.site_booking_requests
    where site_id = v_site.id and submission_key = btrim(p_submission_key);
    return jsonb_build_object('requestId', v_id, 'deduplicated', true);
  end if;

  return jsonb_build_object('requestId', v_id, 'deduplicated', false);
end;
$$;

comment on function public.site_public_booking_request(text, uuid, date, date, integer, integer, integer, text, text, text, text, integer, text) is
  'A public enquiry. Writes site_booking_requests and NOTHING else — no booking, no hold, no calendar. Idempotent on submission_key so a double-tap creates one request.';


-- ── The grants, and the one place `anon` holds EXECUTE ───────────────────
-- 0014's rule: a function in `public` is an API surface until its grants say
-- otherwise. Revoke everything, then hand back exactly these four to `anon`,
-- which is the only reason they exist.

revoke all on function public.site_public_snapshot(text) from public, anon, authenticated, service_role;
revoke all on function public.site_public_availability_facts(text, uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.site_public_rate_facts(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.site_public_booking_request(text, uuid, date, date, integer, integer, integer, text, text, text, text, integer, text) from public, anon, authenticated, service_role;

grant execute on function public.site_public_snapshot(text) to anon, authenticated;
grant execute on function public.site_public_availability_facts(text, uuid, date, date) to anon, authenticated;
grant execute on function public.site_public_rate_facts(text, uuid) to anon, authenticated;
grant execute on function public.site_public_booking_request(text, uuid, date, date, integer, integer, integer, text, text, text, text, integer, text) to anon, authenticated;


-- ============================================================================
-- 15 · The rehearsal
-- ============================================================================
-- Everything this migration assumed, asserted against the live catalogue. A
-- failure here is a migration that would have produced a module refusing
-- everybody, or worse, a public route serving a draft.

do $$
declare
  missing     text;
  v_generated text;
begin
  -- The tables 0042 depends on and does not create.
  select string_agg(name, ', ') into missing
  from (values
    ('organizations'), ('properties'), ('units'), ('amenities'),
    ('bookings'), ('holds')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0042: %', missing;
  end if;

  -- The functions the policies are written against.
  select string_agg(name, ', ') into missing
  from (values
    ('my_organizations'), ('has_permission'), ('property_in_scope'),
    ('tg_touch_row')
  ) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
  );

  if missing is not null then
    raise exception 'functions missing for 0042: %', missing;
  end if;

  -- The eight grants this module is written against. 0002 and 0012 own the
  -- catalogue; if one were renamed there, every policy above would silently
  -- refuse everybody, which reads on screen as "the website is empty".
  select string_agg(code, ', ') into missing
  from (values
    ('site.view'), ('site.edit_content'), ('site.edit_design'),
    ('site.manage_seo'), ('site.manage_domain'), ('site.publish'),
    ('site.rollback'), ('site.ai_generate'),
    -- Reading an enquiry is a booking grant, not a site one. Asserted here
    -- because the policy silently returns nothing if it is renamed.
    ('booking.view'), ('booking.update')
  ) as g(code)
  where not exists (
    select 1 from public.permissions where permissions.code = g.code
  );

  if missing is not null then
    raise exception 'permissions missing for 0042: %', missing;
  end if;

  -- There must be no parallel vocabulary. §the header: the eight `site.*`
  -- grants already carry the `website`, `custom_domain` and `ai_content`
  -- entitlements, and a `website.*` or `page.*` grant would mean two answers
  -- to "may this person publish".
  select string_agg(code, ', ') into missing
  from public.permissions
  where code like 'website.%' or code like 'page.%';

  if missing is not null then
    raise exception 'a parallel website grant exists and must not: %', missing;
  end if;

  -- ── THE CLAIMS CONSTRAINT, ASSERTED IN THE SCHEMA ───────────────────────
  -- If somebody ever drops `site_sections_claims_sourced` "to make an import
  -- easier", the module's one rule is gone silently and a fabricated fact
  -- becomes storable. It is checked by name.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'site_sections'
      and c.conname = 'site_sections_claims_sourced'
  ) then
    raise exception
      'site_sections_claims_sourced is missing — a claim naming a canonical source with no row could be stored, and the module''s one rule is gone';
  end if;

  -- And that it BITES. A constraint that exists and accepts everything is the
  -- more dangerous of the two failures, because it reads as enforcement.
  if public.site_claims_are_sourced(
       '[{"key":"k","text":"t","source":"property"}]'::jsonb
     ) then
    raise exception
      'the claims predicate accepts a property claim naming no row — the module''s one law is not being enforced';
  end if;

  if not public.site_claims_are_sourced(
       '[{"key":"k","text":"t","source":"property","sourceId":"x"}]'::jsonb
     ) then
    raise exception
      'the claims predicate refuses a well-formed claim — every section write would fail';
  end if;

  -- ── THE PUBLIC PATH CANNOT REACH A DRAFT ────────────────────────────────
  -- `anon` must hold NOTHING on every table in this schema. The public route
  -- reads one function; if anon ever held SELECT on `site_sections`, a
  -- visitor could read the draft directly and every argument above would be
  -- decoration.
  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name like 'site%';

  if missing is not null then
    raise exception 'anon holds privileges on: % — a visitor could read the draft', missing;
  end if;

  -- And the four public functions must be executable by anon, which is the
  -- opposite of every other check in this block and is why it is written out.
  select string_agg(name, ', ') into missing
  from (values
    ('site_public_snapshot'),
    ('site_public_availability_facts'),
    ('site_public_rate_facts'),
    ('site_public_booking_request')
  ) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = f.name
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  );

  if missing is not null then
    raise exception 'anon cannot execute % — the public site is closed', missing;
  end if;

  -- ── THE AVAILABILITY PROJECTION LEARNS NOTHING ABOUT A GUEST ────────────
  -- Asserted against the function's own source rather than trusted to review.
  -- A key added later would make the privacy argument a statement about what
  -- somebody remembered instead of about what the function can return.
  select string_agg(word, ', ') into missing
  from (values
    ('guest_id'), ('guest_name'), ('guest_token'), ('total_agorot'),
    ('reference'), ('agent_id'), ('source_channel'), ('internal_notes')
  ) as w(word)
  where exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'site_public_availability_facts'
      and p.prosrc like '%' || w.word || '%'
  );

  if missing is not null then
    raise exception
      'site_public_availability_facts references guest or money columns and must not: %', missing;
  end if;

  -- ── A VERSION IS APPEND-ONLY ────────────────────────────────────────────
  if not exists (
    select 1 from pg_trigger
    where tgname = 'site_versions_immutable' and not tgisinternal
  ) then
    raise exception
      'site_versions_immutable is missing — a published version could be rewritten or deleted, and a rollback would have nothing to return to';
  end if;

  if has_table_privilege('service_role', 'public.site_versions', 'DELETE')
     or has_table_privilege('service_role', 'public.site_versions', 'UPDATE') then
    raise exception
      'service_role can still modify site_versions — it carries BYPASSRLS and is the one caller a policy cannot stop';
  end if;

  -- Every table must have RLS both enabled and forced. Forced is the half
  -- people forget, and without it the table owner reads everything.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'site%'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  -- The slug is the public URL and must be globally unique. A per-organization
  -- unique index would let two tenants both own `/s/galilee`, and the second
  -- one to publish would take the first one's address.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'sites_slug_idx'
  ) then
    raise exception 'sites_slug_idx is missing — two tenants could claim one public URL';
  end if;

  -- The version pointer must be a real foreign key with RESTRICT. Without it,
  -- deleting the version a site is serving leaves the public route reading
  -- nothing and the site claiming to be published.
  select c.confdeltype::text into v_generated
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'sites'
    and c.conname = 'sites_published_version_fkey';

  if v_generated is distinct from 'r' then
    raise exception
      'sites.published_version_id is not RESTRICT on delete — the live version could be removed underneath a published site';
  end if;
end $$;
