-- ============================================================================
-- 0058_property_guide.sql — ESTIA · what a guest is told, and when
--
-- What this is
--   The structured property guide: directions and parking before arrival,
--   wi-fi and the jacuzzi and the bins during the stay, checkout and forgotten
--   items after. Plus local recommendations, and the rules about when each
--   piece becomes visible.
--
--   This is the CONTENT LIBRARY and its admin screens. The guest-facing
--   rendering lives in the portal and is not written here — the seam is a
--   SECURITY DEFINER function described in the module's own README, and the
--   decision about a secret has to be made before the secret leaves the
--   database.
--
-- The one rule the whole design turns on
--   A door code, an alarm code, a lock-box location must not be visible until
--   eligibility passes, and must never be somewhere a public page could read.
--   That is made structural rather than conventional in four places:
--
--     1. `guide_entries` HAS NO COLUMN A SECRET FITS IN. Not nullable, not
--        optional. `has_secret` is a boolean. So no bug in the release
--        function can leak a code — the worst it can do is show the wrong
--        paragraph early.
--     2. `guide_entry_secrets` is a separate table with COLUMN PRIVILEGES:
--        `authenticated` may INSERT and UPDATE `value` and may never SELECT
--        it. The rehearsal asserts that. Only the definer seam reads it.
--     3. `guide_versions_snapshot_secret_free` refuses a published snapshot
--        containing one, because a rotated code that survived in append-only
--        evidence would outlive every guest entitled to it.
--     4. `guide_entries_secret_needs_condition` refuses `has_secret` with
--        release mode `immediate` — a code released immediately is a code on
--        a link.
--
--   The product consequence, stated so it can be reversed deliberately: an
--   operator who set a code CANNOT READ IT BACK, not even their own. Rotating
--   means typing the new one, which is what rotating a door code means anyway.
--   What it buys is that a compromised session cannot exfiltrate the codes of
--   every property it can see.
--
-- No fabricated recommendations
--   `guide_recommendation_source` has two members and deliberately no
--   `generated`. `guide_recommendations_sourced` makes a sourceless row
--   impossible: a business source names the person who entered it, a named
--   source names the party it came from. There is no model client in this
--   codebase and no enum value a hallucinated recommendation could be filed
--   under. Adding a generator later is an addition somebody reviews, not a
--   configuration change.
--
-- Where this is stricter than 0042 on purpose
--   `site_media_url_shape` is `url ~ '^(https://|/)'`, which accepts
--   `//evil.example` — a protocol-relative URL resolving to another origin —
--   and accepts a scheme smuggled across a newline. Every URL check here
--   refuses both. That constraint in 0042 is worth tightening in a follow-up.
--
-- Depends on
--   0008 (properties and its composite key), 0004 (RLS helpers), 0034 (whose
--   guest_arrival_release the first seven release modes mirror in order).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies — from src/lib/guest-guide/types.ts, in order
-- ============================================================================

do $$ begin
  create type public.guide_status as enum ('draft', 'published', 'unpublished');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guide_stage as enum
    ('before_arrival', 'during_stay', 'after_checkout');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guide_topic as enum (
    'directions', 'parking', 'check_in_time', 'what_to_bring', 'arrival_contact',
    'wifi', 'access', 'pool', 'jacuzzi', 'air_conditioning', 'tv', 'barbecue',
    'hot_water', 'kitchen', 'shabbat_equipment', 'quiet_hours', 'waste',
    'emergency_contact', 'checkout', 'forgotten_items', 'feedback', 'custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guide_release_mode as enum (
    'immediate', 'after_confirmation', 'after_contract', 'after_deposit',
    'after_full_payment', 'hours_before', 'manual', 'after_check_in'
  );
exception when duplicate_object then null; end $$;

comment on type public.guide_release_mode is
  'The first SEVEN members are byte-identical to public.guest_arrival_release from 0034, in its order, so mode::text::public.guest_arrival_release is a lossless cast for them. That cast is what lets the portal seam delegate to guest_arrival_released rather than reimplementing eligibility.';

do $$ begin
  create type public.guide_media_kind as enum ('photo', 'video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guide_recommendation_category as enum (
    'restaurant', 'attraction', 'supermarket', 'pharmacy', 'religious_service',
    'beach', 'hike', 'custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.guide_recommendation_source as enum ('business', 'named');
exception when duplicate_object then null; end $$;

comment on type public.guide_recommendation_source is
  'Two members and deliberately no `generated`. A recommendation is entered by the business or carries a named source; there is no model client in this codebase and no enum value a fabricated recommendation could be filed under.';


-- ============================================================================
-- 2 · The guide
-- ============================================================================

create table if not exists public.property_guides (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  property_id          uuid not null,
  status               public.guide_status not null default 'draft',
  languages            text[] not null default '{he}',
  published_version_id uuid,
  published_at         timestamptz,
  published_by         uuid references auth.users (id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,
  constraint property_guides_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint property_guides_property_key unique (organization_id, property_id),
  constraint property_guides_id_org_key unique (id, organization_id),
  constraint property_guides_version_positive check (version >= 1),
  constraint property_guides_languages_hebrew check ('he' = any (languages)),
  constraint property_guides_draft_has_no_version
    check (status <> 'draft' or published_version_id is null),
  constraint property_guides_published_has_version
    check (status <> 'published' or published_version_id is not null)
);

comment on constraint property_guides_languages_hebrew on public.property_guides is
  'Hebrew is not a language a business may drop: every entry carries it, so a guide declaring only English would render Hebrew text under English headings.';

create index if not exists property_guides_org_idx
  on public.property_guides (organization_id, property_id);

drop trigger if exists property_guides_touch on public.property_guides;
create trigger property_guides_touch
  before update on public.property_guides
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · Entries
-- ============================================================================

create table if not exists public.guide_entries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guide_id        uuid not null,
  property_id     uuid not null,
  stage           public.guide_stage not null,
  topic           public.guide_topic not null,
  title           jsonb not null,
  body            jsonb,
  icon            text,
  link_url        text,
  link_label      jsonb,
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  has_secret      boolean not null default false,
  release_mode    public.guide_release_mode not null default 'immediate',
  release_hours   integer not null default 24,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  version         integer not null default 1,
  constraint guide_entries_guide_fkey foreign key (guide_id, organization_id)
    references public.property_guides (id, organization_id) on delete cascade,
  constraint guide_entries_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guide_entries_id_org_key unique (id, organization_id),
  constraint guide_entries_title_hebrew check (
    jsonb_typeof(title) = 'object' and length(btrim(coalesce(title ->> 'he', ''))) > 0
  ),
  constraint guide_entries_body_hebrew check (
    body is null or length(btrim(coalesce(body ->> 'he', ''))) > 0
  ),
  constraint guide_entries_link_label_hebrew check (
    link_label is null or length(btrim(coalesce(link_label ->> 'he', ''))) > 0
  ),
  constraint guide_entries_link_complete check (
    (link_url is null and link_label is null)
    or (link_url is not null and link_label is not null)
  ),
  constraint guide_entries_link_url_shape check (
    link_url is null or (
      link_url ~ '^(https://[^[:space:]/]|/[^/[:space:]])'
      and link_url !~ '[[:space:][:cntrl:]]'
    )
  ),
  constraint guide_entries_release_hours check (release_hours between 0 and 720),
  constraint guide_entries_version_positive check (version >= 1),
  constraint guide_entries_secret_needs_condition
    check (not has_secret or release_mode <> 'immediate')
);

comment on column public.guide_entries.has_secret is
  'Declares that a secret belongs here. NEVER the value — there is no column on this table a door code fits in, which matches the GuideEntry type exactly and is why no bug in the release function can leak one.';
comment on constraint guide_entries_secret_needs_condition on public.guide_entries is
  'A code released `immediate` is a code on a link.';
comment on constraint guide_entries_link_url_shape on public.guide_entries is
  'https or a deployment-relative path. Stricter than site_media_url_shape in 0042, which accepts a protocol-relative //host resolving to another origin, and accepts a scheme smuggled across a newline.';

create index if not exists guide_entries_guide_idx
  on public.guide_entries (guide_id, stage, sort_order);
create index if not exists guide_entries_topic_idx
  on public.guide_entries (organization_id, property_id, topic);

drop trigger if exists guide_entries_touch on public.guide_entries;
create trigger guide_entries_touch
  before update on public.guide_entries
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · Secrets — the separate table, and its column privileges
-- ============================================================================

create table if not exists public.guide_entry_secrets (
  entry_id        uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  property_id     uuid not null,
  value           jsonb not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  version         integer not null default 1,
  constraint guide_entry_secrets_entry_fkey foreign key (entry_id, organization_id)
    references public.guide_entries (id, organization_id) on delete cascade,
  constraint guide_entry_secrets_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guide_entry_secrets_value_hebrew
    check (length(btrim(coalesce(value ->> 'he', ''))) > 0),
  constraint guide_entry_secrets_version_positive check (version >= 1)
);

comment on table public.guide_entry_secrets is
  'Door codes, alarm codes, lock-box locations. Its own table, its own grant and — the part that matters — its own COLUMN privileges: authenticated may SET a code and may never read one back through PostgREST. Only the SECURITY DEFINER portal seam reads `value`. That is what makes "no secret reaches a server-rendered page''s props" a database fact rather than a code convention. The cost is that an operator cannot read their own code back; rotating means typing the new one, which is what rotating a door code means anyway.';

drop trigger if exists guide_entry_secrets_touch on public.guide_entry_secrets;
create trigger guide_entry_secrets_touch
  before update on public.guide_entry_secrets
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · Media — references, never files
-- ============================================================================

create table if not exists public.guide_media (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guide_id        uuid not null,
  property_id     uuid not null,
  entry_id        uuid not null,
  kind            public.guide_media_kind not null,
  url             text not null,
  alt_text        jsonb,
  sort_order      integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  version         integer not null default 1,
  constraint guide_media_entry_fkey foreign key (entry_id, organization_id)
    references public.guide_entries (id, organization_id) on delete cascade,
  constraint guide_media_guide_fkey foreign key (guide_id, organization_id)
    references public.property_guides (id, organization_id) on delete cascade,
  constraint guide_media_url_shape check (
    url ~ '^(https://[^[:space:]/]|/[^/[:space:]])'
    and url !~ '[[:space:][:cntrl:]]'
  ),
  constraint guide_media_alt_hebrew check (
    alt_text is null or length(btrim(coalesce(alt_text ->> 'he', ''))) > 0
  ),
  constraint guide_media_version_positive check (version >= 1)
);

comment on table public.guide_media is
  'References, never files. There is no data column and there never will be — the same discipline as site_media, with the two holes in its own CHECK closed.';

create index if not exists guide_media_entry_idx on public.guide_media (entry_id, sort_order);

drop trigger if exists guide_media_touch on public.guide_media;
create trigger guide_media_touch
  before update on public.guide_media
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · Recommendations
-- ============================================================================

create table if not exists public.guide_recommendations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guide_id        uuid not null,
  property_id     uuid not null,
  category        public.guide_recommendation_category not null,
  name            jsonb not null,
  description     jsonb,
  address         jsonb,
  phone           text,
  url             text,
  minutes_away    integer,
  source_kind     public.guide_recommendation_source not null,
  source_user_id  uuid,
  source_name     text,
  source_url      text,
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  version         integer not null default 1,
  constraint guide_recommendations_guide_fkey foreign key (guide_id, organization_id)
    references public.property_guides (id, organization_id) on delete cascade,
  constraint guide_recommendations_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guide_recommendations_name_hebrew
    check (length(btrim(coalesce(name ->> 'he', ''))) > 0),
  constraint guide_recommendations_url_shape check (
    url is null or (url ~ '^(https://[^[:space:]/]|/[^/[:space:]])'
                and url !~ '[[:space:][:cntrl:]]')
  ),
  constraint guide_recommendations_source_url_shape check (
    source_url is null or (source_url ~ '^https://[^[:space:]/]'
                       and source_url !~ '[[:space:][:cntrl:]]')
  ),
  constraint guide_recommendations_minutes check (
    minutes_away is null or minutes_away between 0 and 600
  ),
  constraint guide_recommendations_sourced check (
    (source_kind = 'business' and source_user_id is not null
       and source_name is null and source_url is null)
    or (source_kind = 'named' and length(btrim(coalesce(source_name, ''))) > 0)
  ),
  constraint guide_recommendations_version_positive check (version >= 1)
);

comment on constraint guide_recommendations_sourced on public.guide_recommendations is
  'A row with no source cannot exist. There is no enum member for a model, a business source names the person who entered it, and a named source names the party it came from. This is the no-hallucinated-recommendations rule at the floor rather than in a comment.';
comment on column public.guide_recommendations.source_user_id is
  'Deliberately NOT a foreign key to auth.users. A recommendation''s provenance must survive the deletion of the account that entered it — the same argument booking_contract_signatures makes about storing text rather than a pointer.';

create index if not exists guide_recommendations_property_idx
  on public.guide_recommendations (organization_id, property_id, category, sort_order);

drop trigger if exists guide_recommendations_touch on public.guide_recommendations;
create trigger guide_recommendations_touch
  before update on public.guide_recommendations
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · Published versions — append only, and provably secret-free
-- ============================================================================

create or replace function public.guide_snapshot_has_no_secret(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(not (e ? 'secret') and not (e ? 'value')
                       and not (e ? 'accessCode')), true)
  from jsonb_array_elements(coalesce(p -> 'entries', '[]'::jsonb)) e
$$;

comment on function public.guide_snapshot_has_no_secret(jsonb) is
  'A published snapshot must not contain a door code. A rotated code that survived forever in an append-only row would outlive every guest who was entitled to it.';

create table if not exists public.guide_versions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  guide_id                 uuid not null,
  property_id              uuid not null,
  version_number           integer not null,
  label                    text,
  snapshot                 jsonb not null,
  entry_count              integer not null default 0,
  published_at             timestamptz not null default now(),
  published_by             uuid references auth.users (id) on delete set null,
  restored_from_version_id uuid references public.guide_versions (id),
  created_at               timestamptz not null default now(),
  constraint guide_versions_guide_fkey foreign key (guide_id, organization_id)
    references public.property_guides (id, organization_id) on delete cascade,
  constraint guide_versions_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guide_versions_number_key unique (guide_id, version_number),
  constraint guide_versions_number_positive check (version_number >= 1),
  constraint guide_versions_snapshot_secret_free
    check (public.guide_snapshot_has_no_secret(snapshot))
);

create index if not exists guide_versions_guide_idx
  on public.guide_versions (guide_id, published_at desc);

do $$ begin
  alter table public.property_guides
    add constraint property_guides_published_version_fkey
    foreign key (published_version_id)
    references public.guide_versions (id) on delete set null;
exception when duplicate_object then null; end $$;

create or replace function public.tg_guide_versions_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'guide_versions is append-only'
    using hint = 'גרסה שפורסמה היא עדות ואינה ניתנת לשינוי או למחיקה.',
          errcode = 'P0001';
  return null;
end;
$$;

revoke all on function public.tg_guide_versions_immutable() from public, anon, authenticated, service_role;

drop trigger if exists guide_versions_immutable on public.guide_versions;
create trigger guide_versions_immutable
  before update or delete on public.guide_versions
  for each row execute function public.tg_guide_versions_immutable();


-- ============================================================================
-- 8 · Row level security
-- ============================================================================
-- No anon policy on any of these. A guest reaches guide content only through
-- the SECURITY DEFINER seam, which resolves the token, reads the published
-- snapshot rather than the draft tables, and selects a secret only for an
-- entry that has already passed its release condition.

alter table public.property_guides       enable row level security;
alter table public.property_guides       force  row level security;
alter table public.guide_entries         enable row level security;
alter table public.guide_entries         force  row level security;
alter table public.guide_entry_secrets   enable row level security;
alter table public.guide_entry_secrets   force  row level security;
alter table public.guide_media           enable row level security;
alter table public.guide_media           force  row level security;
alter table public.guide_recommendations enable row level security;
alter table public.guide_recommendations force  row level security;
alter table public.guide_versions        enable row level security;
alter table public.guide_versions        force  row level security;

revoke all on public.property_guides       from anon, authenticated;
revoke all on public.guide_entries         from anon, authenticated;
revoke all on public.guide_entry_secrets   from anon, authenticated;
revoke all on public.guide_media           from anon, authenticated;
revoke all on public.guide_recommendations from anon, authenticated;
revoke all on public.guide_versions        from anon, authenticated;

grant select, insert, update, delete on public.property_guides       to authenticated, service_role;
grant select, insert, update, delete on public.guide_entries         to authenticated, service_role;
grant select, insert, update, delete on public.guide_media           to authenticated, service_role;
grant select, insert, update, delete on public.guide_recommendations to authenticated, service_role;
grant select, insert                 on public.guide_versions        to authenticated, service_role;

-- ══ COLUMN PRIVILEGES ARE THE FLOOR, NOT THE REPOSITORY ═════════════════════
-- `authenticated` may SET a code and may never READ one back through
-- PostgREST. `entry_id` is selectable so a screen can say "a code is set here"
-- without ever holding the code.
grant select (entry_id) on public.guide_entry_secrets to authenticated;
grant insert (entry_id, organization_id, property_id, value, version, created_by, updated_by)
  on public.guide_entry_secrets to authenticated;
grant update (value, updated_by, version) on public.guide_entry_secrets to authenticated;
grant delete on public.guide_entry_secrets to authenticated;
grant select, insert, update, delete on public.guide_entry_secrets to service_role;

revoke update, delete, truncate on public.guide_versions from authenticated, service_role;


-- ============================================================================
-- 9 · Policies
-- ============================================================================
-- `property.view` to read and `property.update` to edit, publish or set a
-- code. The `site.*` family was considered and rejected: those are held by a
-- copywriter, who has no business holding a door code.

drop policy if exists property_guides_select on public.property_guides;
create policy property_guides_select on public.property_guides
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.view')
  );

drop policy if exists property_guides_write on public.property_guides;
create policy property_guides_write on public.property_guides
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_entries_select on public.guide_entries;
create policy guide_entries_select on public.guide_entries
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.view')
  );

drop policy if exists guide_entries_write on public.guide_entries;
create policy guide_entries_write on public.guide_entries
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_entry_secrets_select on public.guide_entry_secrets;
create policy guide_entry_secrets_select on public.guide_entry_secrets
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_entry_secrets_write on public.guide_entry_secrets;
create policy guide_entry_secrets_write on public.guide_entry_secrets
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_media_select on public.guide_media;
create policy guide_media_select on public.guide_media
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.view')
  );

drop policy if exists guide_media_write on public.guide_media;
create policy guide_media_write on public.guide_media
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_recommendations_select on public.guide_recommendations;
create policy guide_recommendations_select on public.guide_recommendations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.view')
  );

drop policy if exists guide_recommendations_write on public.guide_recommendations;
create policy guide_recommendations_write on public.guide_recommendations
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists guide_versions_select on public.guide_versions;
create policy guide_versions_select on public.guide_versions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.view')
  );

drop policy if exists guide_versions_insert on public.guide_versions;
create policy guide_versions_insert on public.guide_versions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );


-- ============================================================================
-- 10 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
  n       integer;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('property_guides'), ('guide_entries'), ('guide_entry_secrets'),
    ('guide_media'), ('guide_recommendations'), ('guide_versions')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0058: %', missing;
  end if;

  -- THE SECRET FLOOR. `authenticated` may write a code and must never be able
  -- to read one back through PostgREST.
  select count(*) into n
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'guide_entry_secrets'
    and grantee = 'authenticated' and privilege_type = 'SELECT'
    and column_name = 'value';
  if n <> 0 then
    raise exception
      'authenticated can SELECT guide_entry_secrets.value, so a door code can reach a server-rendered page''s props';
  end if;

  if not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'guide_entry_secrets'
      and grantee = 'authenticated' and privilege_type = 'INSERT'
      and column_name = 'value'
  ) then
    raise exception 'authenticated cannot SET a secret, so the feature is unusable';
  end if;

  -- The entry table must have nowhere to put a code.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'guide_entries'
      and column_name in ('secret', 'value', 'access_code', 'code')
  ) then
    raise exception
      'guide_entries has a column a door code fits in, which is exactly what the separate table exists to prevent';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'guide_versions_snapshot_secret_free'
      and conrelid = 'public.guide_versions'::regclass
  ) then
    raise exception
      'a published snapshot could contain a door code, and a rotated code would outlive every guest entitled to it';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'guide_recommendations_sourced'
      and conrelid = 'public.guide_recommendations'::regclass
  ) then
    raise exception 'a recommendation with no source could be stored';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public' and c.relkind = 'r'
    and (c.relname like 'guide_%' or c.relname = 'property_guides')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon'
    and (table_name like 'guide_%' or table_name = 'property_guides');
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;
end $$;
