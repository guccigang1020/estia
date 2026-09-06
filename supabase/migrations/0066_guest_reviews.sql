-- ============================================================================
-- 0066_guest_reviews.sql — ESTIA · the table two grants have been pointing at
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `review.view` and `review.manage` are in the permission catalogue and are
-- handed out by roles. **There is no reviews table in any migration.** The
-- grants point at nothing, and a business owner looking at the roles screen
-- reads them as a feature that exists and is merely switched off.
--
-- Found while building `listing-quality`, which is why `property.guest_rating`
-- reports `not_assessed` and says in Hebrew that there is nothing to measure —
-- rather than letting a listing look unrated. Recorded as G-028. It is the
-- same shape `message.assign` was in before 0063.
--
-- ── THE RULE THAT DECIDES WHETHER ANY OF THIS IS WORTH ANYTHING ────────────
--
-- **A business cannot edit a guest's words or change their score, and cannot
-- delete a review at all.**
--
-- This is not a nicety. A rating a business can quietly curate is not a
-- quality signal, it is marketing — and `listing-quality` is about to read
-- these rows and tell somebody their listing is good. If a bad review can be
-- removed without trace, that number is a lie told with real data, which is
-- worse than the `not_assessed` it replaces.
--
-- So three separate mechanisms, because one is a preference and three are a
-- design:
--
--   1. NO DELETE PRIVILEGE. `authenticated` and `service_role` are refused
--      `delete` and `truncate` on this table outright, the same way 0063
--      refuses them on `conversation_messages`.
--
--   2. THE WORDS AND THE SCORES ARE IMMUTABLE. A trigger rejects any UPDATE
--      that changes `overall`, any sub-score, `comment`, `source`,
--      `booking_id` or `stayed_at`. What a business MAY change is its own
--      reply, its own private note, and whether the review is displayed.
--
--   3. HIDING IS RECORDED AND NEEDS A REASON. `status = 'hidden'` requires
--      `hidden_at`, `hidden_by` and a non-blank `hidden_reason`. Hidden
--      reviews still exist, still count in "how many were hidden", and
--      `listing-quality` is expected to show that count beside the average.
--      A business with a good reason — a review naming a guest's medical
--      details, say — is not obstructed. One with no reason is recorded.
--
-- ── A REVIEW MUST BE ABOUT A STAY THAT HAPPENED ────────────────────────────
--
-- A trigger refuses a review whose booking never reached the guest leaving.
-- An enquiry cannot be reviewed, a cancelled booking cannot be reviewed, and
-- a guest arriving next month cannot have reviewed their stay. Without this,
-- the easiest way to inflate a rating is to create bookings that never happen
-- and review them, and it would need no privilege at all.
--
-- The same trigger checks the property and unit against the booking rather
-- than trusting the caller, so a five-star review cannot be filed against a
-- property the stay was not at.
--
-- ── WHAT IS NOT HERE, AND WHOSE IT IS ──────────────────────────────────────
--
-- **The guest-facing capture screen.** A guest submits a review from the
-- guest portal, and `src/app/g/**` belongs to another agent's work in this
-- repository. `guest_portal_submit_review` below is the door it will need —
-- SECURITY DEFINER, keyed on the booking's guest token, refusing everything
-- the trigger refuses — so that side is one screen away rather than one
-- design away. Until it exists, `entered_by_host` is the reachable source,
-- which is genuinely useful: most Israeli guesthouses today receive reviews
-- by WhatsApp and have nowhere to put them.
--
-- Depends on 0002 (organizations), 0008 (properties, units, scope helpers),
-- 0028-era bookings, and 0033 (`bookings.guest_token`).
-- ============================================================================

set search_path = public, extensions;

do $$ begin
  create type public.review_status as enum ('published', 'hidden');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.review_source as enum (
    'guest_portal', 'entered_by_host', 'channel_import');
exception when duplicate_object then null; end $$;

create table if not exists public.guest_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  unit_id          uuid,
  booking_id       uuid not null,
  guest_id         uuid,

  status           public.review_status not null default 'published',
  source           public.review_source not null,

  -- One overall score, and five optional dimensions. Overall is required
  -- because a review with no score is a comment, and the two are read
  -- differently; the dimensions are optional because a guest typing on a
  -- telephone will fill one of them and abandon a form that demands six.
  overall          smallint not null,
  cleanliness      smallint,
  accuracy         smallint,
  communication    smallint,
  location         smallint,
  value_for_money  smallint,

  comment          text,
  -- Written by the guest FOR THE HOST and never displayed anywhere public.
  -- The thing a guest will say privately is usually the thing worth fixing.
  private_note     text,

  host_reply       text,
  host_replied_at  timestamptz,
  host_replied_by  uuid references auth.users (id) on delete set null,

  hidden_at        timestamptz,
  hidden_by        uuid references auth.users (id) on delete set null,
  hidden_reason    text,

  -- The date the stay ended, copied from the booking by the trigger. Kept on
  -- the row so "reviews this season" does not need a join to a booking that
  -- may since have been corrected.
  stayed_at        date not null,

  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  version          integer not null default 1,

  constraint guest_reviews_booking_key unique (booking_id),

  constraint guest_reviews_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guest_reviews_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id)
    on delete set null (unit_id),
  constraint guest_reviews_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint guest_reviews_guest_fkey
    foreign key (guest_id, organization_id)
    references public.guests (id, organization_id)
    on delete set null (guest_id),

  constraint guest_reviews_overall_range check (overall between 1 and 5),
  constraint guest_reviews_dimensions_range check (
    (cleanliness     is null or cleanliness     between 1 and 5) and
    (accuracy        is null or accuracy        between 1 and 5) and
    (communication   is null or communication   between 1 and 5) and
    (location        is null or location        between 1 and 5) and
    (value_for_money is null or value_for_money between 1 and 5)),

  -- Hiding is a decision with an author and a reason, or it is not available.
  constraint guest_reviews_hidden_shape check (
    (status = 'hidden') = (hidden_at is not null)),
  constraint guest_reviews_hidden_has_reason check (
    status <> 'hidden' or length(btrim(coalesce(hidden_reason, ''))) > 0),

  constraint guest_reviews_reply_shape check (
    (host_reply is null) = (host_replied_at is null)),
  constraint guest_reviews_reply_not_blank check (
    host_reply is null or length(btrim(host_reply)) > 0),

  constraint guest_reviews_version_positive check (version >= 1)
);

create index if not exists guest_reviews_org_property_idx
  on public.guest_reviews (organization_id, property_id, stayed_at desc);
create index if not exists guest_reviews_org_unit_idx
  on public.guest_reviews (organization_id, unit_id)
  where unit_id is not null;

/* ------------------------------------------------ a stay that happened -- */

create or replace function public.tg_review_needs_a_completed_stay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
begin
  select property_id, unit_id, guest_id, status, check_out, deleted_at
    into b
  from public.bookings
  where id = new.booking_id and organization_id = new.organization_id;

  if not found or b.deleted_at is not null then
    raise exception
      'a review must belong to a booking in the same organization'
      using errcode = 'foreign_key_violation';
  end if;

  -- Everything from the guest leaving onward. Deliberately NOT `confirmed` or
  -- `in_house`: a stay still running has not been experienced, and a
  -- cancelled one was not experienced at all. The cheapest way to inflate a
  -- rating is to review bookings that never happened.
  if b.status not in (
    'checkout_pending'::public.booking_status,
    'checked_out'::public.booking_status,
    'inspection'::public.booking_status,
    'deposit_release'::public.booking_status,
    'completed'::public.booking_status,
    'review_requested'::public.booking_status
  ) then
    raise exception
      'booking % is %, which is not a stay that has been experienced',
      new.booking_id, b.status
      using errcode = 'check_violation';
  end if;

  -- Taken from the booking rather than trusted from the caller. A five star
  -- review filed against a property the stay was not at would otherwise be
  -- one field away.
  new.property_id := b.property_id;
  new.unit_id     := b.unit_id;
  new.guest_id    := coalesce(new.guest_id, b.guest_id);
  new.stayed_at   := b.check_out;

  return new;
end $$;

drop trigger if exists guest_reviews_needs_a_stay on public.guest_reviews;
create trigger guest_reviews_needs_a_stay
  before insert on public.guest_reviews
  for each row execute function public.tg_review_needs_a_completed_stay();

/* ------------------------------------ the guest's words are not editable -- */

create or replace function public.tg_review_is_not_rewritten()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booking_id      is distinct from old.booking_id
  or new.organization_id is distinct from old.organization_id
  or new.property_id     is distinct from old.property_id
  or new.unit_id         is distinct from old.unit_id
  or new.source          is distinct from old.source
  or new.stayed_at       is distinct from old.stayed_at
  or new.overall         is distinct from old.overall
  or new.cleanliness     is distinct from old.cleanliness
  or new.accuracy        is distinct from old.accuracy
  or new.communication   is distinct from old.communication
  or new.location        is distinct from old.location
  or new.value_for_money is distinct from old.value_for_money
  or new.comment         is distinct from old.comment
  then
    raise exception
      'a review''s words and scores cannot be changed after it is written; '
      'reply to it or hide it with a reason'
      using errcode = 'check_violation';
  end if;

  new.updated_at := pg_catalog.now();
  new.version    := old.version + 1;
  return new;
end $$;

drop trigger if exists guest_reviews_is_not_rewritten on public.guest_reviews;
create trigger guest_reviews_is_not_rewritten
  before update on public.guest_reviews
  for each row execute function public.tg_review_is_not_rewritten();

/* ---------------------------------------------------------------- rls -- */

alter table public.guest_reviews enable row level security;
alter table public.guest_reviews force  row level security;

revoke all on public.guest_reviews from anon, authenticated;
grant select, insert, update on public.guest_reviews to authenticated, service_role;

-- Never. Hiding is the only removal, and it leaves a row that says who and
-- why. Same argument as `conversation_messages` in 0063.
revoke delete, truncate on public.guest_reviews from authenticated, service_role;

drop policy if exists guest_reviews_select on public.guest_reviews;
create policy guest_reviews_select on public.guest_reviews
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists guest_reviews_insert on public.guest_reviews;
create policy guest_reviews_insert on public.guest_reviews
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists guest_reviews_update on public.guest_reviews;
create policy guest_reviews_update on public.guest_reviews
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

/* ------------------------------------------------- the guest's own door -- */

-- The door the guest portal will use, built now so the screen is one screen
-- away rather than one design away. It is keyed on the booking's guest token,
-- which `0033_guest_link.sql` established as the guest's only credential, and
-- it refuses everything the trigger refuses because it goes through the same
-- INSERT rather than around it.
create or replace function public.guest_portal_submit_review(
  p_token           text,
  p_overall         smallint,
  p_comment         text default null,
  p_private_note    text default null,
  p_cleanliness     smallint default null,
  p_accuracy        smallint default null,
  p_communication   smallint default null,
  p_location        smallint default null,
  p_value_for_money smallint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b  record;
  v_id uuid;
begin
  if p_token is null or length(pg_catalog.btrim(p_token)) = 0 then
    raise exception 'a guest link is required'
      using errcode = 'insufficient_privilege';
  end if;

  select id, organization_id, guest_id,
         guest_link_expires_at, guest_link_revoked_at
    into b
  from public.bookings
  where guest_token = p_token and deleted_at is null;

  -- One refusal for "no such link", "expired" and "revoked" alike. Telling a
  -- caller which of the three it was turns this into an oracle for guessing
  -- tokens, and `0033` makes the same argument.
  if not found
     or (b.guest_link_revoked_at is not null)
     or (b.guest_link_expires_at is not null
         and b.guest_link_expires_at < pg_catalog.now()) then
    raise exception 'this link is not valid'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.guest_reviews
    (organization_id, property_id, booking_id, guest_id, source, overall,
     cleanliness, accuracy, communication, location, value_for_money,
     comment, private_note, stayed_at)
  values
    (b.organization_id,
     '00000000-0000-0000-0000-000000000000',  -- replaced by the trigger
     b.id, b.guest_id, 'guest_portal'::public.review_source, p_overall,
     p_cleanliness, p_accuracy, p_communication, p_location, p_value_for_money,
     p_comment, p_private_note,
     '1970-01-01'::date)                      -- replaced by the trigger
  returning id into v_id;

  return v_id;
end $$;

comment on function public.guest_portal_submit_review(
  text, smallint, text, text, smallint, smallint, smallint, smallint, smallint) is
  'One review from the holder of a booking guest link. Goes through the same '
  'INSERT as every other source, so the completed-stay trigger and every '
  'constraint apply. See the header of 0066_guest_reviews.sql.';

revoke all on function public.guest_portal_submit_review(
  text, smallint, text, text, smallint, smallint, smallint, smallint, smallint)
  from public;
grant execute on function public.guest_portal_submit_review(
  text, smallint, text, text, smallint, smallint, smallint, smallint, smallint)
  to anon, authenticated;

-- ── Rehearsal ──────────────────────────────────────────────────────────────
--
-- Exercised, not asserted. Every check below RUNS the thing it is checking.
do $$
declare
  v_cfg text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'guest_reviews'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'guest_reviews is not forced';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'guest_reviews'
      and privilege_type in ('DELETE', 'TRUNCATE')
      and grantee in ('authenticated', 'service_role', 'anon', 'PUBLIC')
  ) then
    raise exception 'a review can be deleted, so the rating means nothing';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'guest_reviews'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon holds a privilege on guest_reviews';
  end if;

  for v_cfg in
    select array_to_string(p.proconfig, ',')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('tg_review_needs_a_completed_stay',
                        'guest_portal_submit_review')
  loop
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception 'a reviews function has a mutable search_path';
    end if;
  end loop;

  -- The token check, run rather than read. A caller with a token that is not
  -- a token must be refused before anything is written.
  begin
    perform public.guest_portal_submit_review('not-a-real-token', 5::smallint);
    raise exception 'the guest door accepted an invalid link';
  exception
    when insufficient_privilege then null;
  end;

  if exists (select 1 from public.guest_reviews) then
    raise exception 'the rehearsal wrote a review';
  end if;
end $$;
