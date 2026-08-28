-- ============================================================================
-- 0009_booking_core.sql — ESTIA · guests, bookings, holds, and the one
--                         guarantee the product cannot survive without
--
-- What this does
--   Creates the booking domain exactly as src/lib/booking/types.ts defines it:
--   `guests`, `bookings`, `booking_status_history`, `booking_price_lines`,
--   `holds`, and the availability ledger that makes double booking
--   structurally impossible.
--
--   Every enum here is a transcription of a constant in that file, in the same
--   order, spelled the same way. That is a contract, not a coincidence, and
--   supabase/tests/booking.sql contains an assertion that fails the moment the
--   two drift.
--
-- ── The hard part: no double booking ────────────────────────────────────────
--
--   An application check cannot do this. "Is the unit free?" followed by
--   "insert the booking" is two statements, and two transactions can both read
--   `free` before either writes. The window is small and the failure is
--   expensive: two families arrive at the same villa on the same Friday.
--
--   Postgres can refuse it outright, with an exclusion constraint over a range
--   type. But an exclusion constraint lives on one table, and there are two
--   things that occupy a calendar here — a booking, and a hold placed by an
--   agent while they close a sale. A constraint on `bookings` plus a trigger
--   that consults `holds` would put the race straight back: the trigger reads,
--   the other transaction has not committed yet, both succeed.
--
--   So both write into one table.
--
--       bookings ─┐
--                 ├─► unit_occupancy   EXCLUDE USING gist
--       holds ────┘                      (unit_id WITH =, during WITH &&)
--
--   `unit_occupancy` is the availability ledger and the only thing that
--   decides whether a date is taken. Bookings and holds are kept in step with
--   it by triggers, so the two writers contend on the same index entries and
--   Postgres serialises them for us. There is no window, because there is no
--   read.
--
--   Nothing but those triggers may write to it: the ledger is not granted to
--   `authenticated` at all, and the triggers are SECURITY DEFINER. A member
--   cannot free somebody else's dates by deleting a row, and cannot claim
--   dates without creating the booking that justifies them.
--
--   Four consequences follow, and each one is a test in
--   supabase/tests/booking.sql:
--
--     · Half-open. `during` is a daterange built as [check_in, check_out), so
--       a same-day turnaround — one guest out on Friday, the next in on
--       Friday — does not collide. A closed range would lose a night on every
--       turnaround in the business.
--     · Only occupying statuses participate. `occupying_booking_statuses()`
--       is the single definition, transcribed from OCCUPYING_STATUSES. An
--       inquiry does not hold a date; an option does.
--     · Cancelling or soft-deleting a booking removes its ledger row, so the
--       dates come back. This is the case that gets forgotten, and it is the
--       one that loses revenue quietly rather than loudly.
--     · An expired hold does not block. Expiry is a moving target and no
--       index can encode `now()`, so the writer that would have been blocked
--       clears the lapsed rows for that unit inside its own transaction,
--       taking the row locks as it goes. Correct without a scheduled job;
--       `purge_expired_holds()` exists only to reclaim space.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units, property_in_scope,
--   unit_in_scope, and the composite keys the foreign keys below rely on).
-- ============================================================================

set search_path = public, extensions;

-- The exclusion constraint compares a uuid with `=` and a daterange with `&&`
-- in the same GiST index. Core GiST does not know how to index a uuid; this is
-- the extension that teaches it.
create extension if not exists btree_gist with schema extensions;


-- ============================================================================
-- Types — transcribed from src/lib/booking/types.ts
-- ============================================================================

-- BOOKING_STATUSES, in order. A booking is a workflow, not a record with a
-- flag: the sequence below is the life of a stay from enquiry to review, with
-- the three terminal states at the end.
do $$ begin
  create type public.booking_status as enum (
    'inquiry',
    'quote',
    'option',
    'awaiting_payment',
    'deposit_paid',
    'contract_pending',
    'confirmed',
    'pre_arrival',
    'ready_for_check_in',
    'checked_in',
    'in_house',
    'checkout_pending',
    'checked_out',
    'inspection',
    'deposit_release',
    'completed',
    'review_requested',
    'cancelled',
    'no_show'
  );
exception when duplicate_object then null;
end $$;

comment on type public.booking_status is
  'Transcribed from BOOKING_STATUSES in src/lib/booking/types.ts, in the same order. The order is load-bearing: it is the order the workflow runs in, and comparison operators on the enum follow it. supabase/tests/booking.sql asserts the two are identical.';

-- BOOKING_SOURCES.
do $$ begin
  create type public.booking_source as enum (
    'direct_website',
    'direct_manual',
    'agent',
    'agency',
    'airbnb',
    'booking_com',
    'vrbo',
    'other_channel'
  );
exception when duplicate_object then null;
end $$;

-- HOLD_REASONS.
do $$ begin
  create type public.hold_reason as enum (
    'agent_quote',
    'guest_checkout',
    'staff_manual',
    'maintenance_block'
  );
exception when duplicate_object then null;
end $$;

-- PRICE_LINE_KINDS.
do $$ begin
  create type public.price_line_kind as enum (
    'accommodation',
    'extra_guest',
    'addon',
    'cleaning_fee',
    'discount',
    'promotion',
    'tax',
    'deposit',
    'agent_commission'
  );
exception when duplicate_object then null;
end $$;

-- Not from the contract: the two things that can occupy a unit.
do $$ begin
  create type public.occupancy_kind as enum ('booking', 'hold');
exception when duplicate_object then null;
end $$;


-- ── OCCUPYING_STATUSES and TERMINAL_STATUSES, stated once ───────────────────
-- Functions rather than a CHECK expression repeated in three places. Adding a
-- status without deciding whether it blocks dates is exactly how a double
-- booking happens, and a set defined in one place is a set somebody has to
-- edit deliberately.

create or replace function public.occupying_booking_statuses()
returns public.booking_status[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'option',
    'awaiting_payment',
    'deposit_paid',
    'contract_pending',
    'confirmed',
    'pre_arrival',
    'ready_for_check_in',
    'checked_in',
    'in_house',
    'checkout_pending'
  ]::public.booking_status[];
$$;

comment on function public.occupying_booking_statuses() is
  'The statuses that occupy the calendar, transcribed from OCCUPYING_STATUSES in src/lib/booking/types.ts. The single definition in the database: availability is computed from this and nothing else.';

create or replace function public.terminal_booking_statuses()
returns public.booking_status[]
language sql
immutable
set search_path = ''
as $$
  select array['completed', 'cancelled', 'no_show']::public.booking_status[];
$$;

comment on function public.terminal_booking_statuses() is
  'Transcribed from TERMINAL_STATUSES in src/lib/booking/types.ts. Nothing further happens to a booking in one of these.';

create or replace function public.booking_status_occupies(target_status public.booking_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select target_status = any (public.occupying_booking_statuses());
$$;

grant execute on function public.occupying_booking_statuses() to authenticated, service_role;
grant execute on function public.terminal_booking_statuses()  to authenticated, service_role;
grant execute on function public.booking_status_occupies(public.booking_status) to authenticated, service_role;


-- ============================================================================
-- Phone normalisation
-- ============================================================================
--
-- Deduplication is by phone, because that is the one identifier an Israeli
-- guest always has and often the only one they give. It arrives in every
-- shape a keyboard permits:
--
--     0501234567 · 050-123-4567 · 050 123 4567 · +972501234567
--     +972-50-123-4567 · 972501234567 · 00972501234567 · +9720501234567
--
-- All eight are one person, and all eight normalise to +972501234567. The
-- rules, in order:
--
--   1. Everything that is not a digit is discarded; whether a `+` was typed
--      is remembered first, because it is the only signal that separates a
--      foreign number from a local one.
--   2. A leading `00` is the international prefix and becomes that same
--      signal.
--   3. A number that starts `972` is Israeli: the country code is stripped,
--      and a national trunk `0` left behind it — the very common
--      `+972 050 …` — is stripped too. This is the step that catches the
--      pasted-from-WhatsApp case.
--   4. Anything else that arrived with `+` or `00` is foreign and is kept as
--      it was given.
--   5. A local number starting `0` loses it and gains `+972`.
--   6. Nine digits starting `5` is a mobile written without its zero.
--   7. Anything left is assumed to be an international number typed without
--      its plus.
--
-- The known limit, stated rather than discovered later: a bare ten-digit
-- number beginning `972` is read as Israeli, so a North American number in
-- area code 972 (Dallas) typed without a `+` would be misread. A foreign
-- number has to arrive with `+` or `00`. That is the right trade for a product
-- whose guests are overwhelmingly Israeli, and it is a rule the API can state
-- to its callers.

create or replace function public.normalize_phone_il(raw text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  international boolean;
  d             text;
begin
  if raw is null then
    return null;
  end if;

  international := left(btrim(raw), 1) = '+';
  d := regexp_replace(raw, '[^0-9]', '', 'g');
  if d = '' then
    return null;
  end if;

  if left(d, 2) = '00' then
    international := true;
    d := substr(d, 3);
    if d = '' then
      return null;
    end if;
  end if;

  if left(d, 3) = '972' then
    d := substr(d, 4);
    if left(d, 1) = '0' then
      d := substr(d, 2);
    end if;
    if d = '' then
      return null;
    end if;
    return '+972' || d;
  end if;

  if international then
    return '+' || d;
  end if;

  if left(d, 1) = '0' then
    if length(d) = 1 then
      return null;
    end if;
    return '+972' || substr(d, 2);
  end if;

  if length(d) = 9 and left(d, 1) = '5' then
    return '+972' || d;
  end if;

  return '+' || d;
end;
$$;

comment on function public.normalize_phone_il(text) is
  'Normalises a phone number to E.164, assuming Israel when nothing says otherwise. The deduplication key for guests. Known limit: a bare number beginning 972 with no plus is read as an Israeli country code, so foreign numbers must arrive with + or 00.';

revoke all on function public.normalize_phone_il(text) from public, anon;
grant execute on function public.normalize_phone_il(text) to authenticated, service_role;


-- ============================================================================
-- guests
-- ============================================================================
-- A person, once, not a set of fields copied onto every booking they make. A
-- returning guest is the most valuable thing a small hospitality business has,
-- and it is invisible to a system that stores `guest_name` on a stay.
--
-- Deliberately unconnected to auth.users: docs/ARCHITECTURE.md §2 makes a
-- guest a separate external identity with no account, no membership and no
-- role. Mixing the two is a permanent security debt.

create table if not exists public.guests (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,

  full_name             text not null,
  first_name            text,
  last_name             text,

  email                 citext,
  phone                 text,
  -- The deduplication key. Generated, so it can never disagree with `phone`
  -- and no write path can forget to compute it.
  phone_e164            text generated always as (public.normalize_phone_il(phone)) stored,
  phone_alt             text,

  language              text not null default 'he',
  nationality           text,
  date_of_birth         date,

  -- Identity documents. Reading these is guest.view_document_id, a separate
  -- grant from guest.view_contact, which is separate again from guest.view:
  -- a cleaner gets a name and a time, never a passport number.
  id_document_type      text,
  id_document_number    text,
  id_document_country   text,

  address_line1         text,
  city                  text,
  postal_code           text,
  country               text,

  tags                  text[] not null default '{}'::text[],
  notes                 text,

  marketing_consent     boolean not null default false,
  marketing_consent_at  timestamptz,

  -- A guest who may not book again. Kept as a fact with a reason attached,
  -- because "why is this person blocked" is asked months later by someone who
  -- was not there.
  is_blocked            boolean not null default false,
  blocked_reason        text,

  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,
  deleted_at            timestamptz,
  deleted_by            uuid references auth.users (id) on delete set null,

  constraint guests_id_organization_key unique (id, organization_id),
  constraint guests_full_name_not_blank check (length(btrim(full_name)) > 0),
  constraint guests_email_format check (
    email is null or (email::text) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint guests_country_format check (country is null or country ~ '^[A-Z]{2}$'),
  constraint guests_nationality_format check (nationality is null or nationality ~ '^[A-Z]{2}$'),
  constraint guests_id_document_type check (
    id_document_type is null
    or id_document_type in ('id_card', 'passport', 'driver_license', 'other')
  ),
  constraint guests_blocked_reason check (is_blocked or blocked_reason is null),
  constraint guests_version_positive check (version >= 1),
  constraint guests_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.guests is
  'A guest identity, held once per organization rather than copied onto each booking. Deduplicated by normalised phone number. Has no auth.users link on purpose: a guest is an external identity with no account, no membership and no role.';
comment on column public.guests.phone_e164 is
  'The normalised phone, generated by normalize_phone_il(phone). The deduplication key. Stored rather than computed on read so the unique index can use it, and generated rather than written so no code path can skip it.';
comment on column public.guests.tags is
  'Free-form labels the business assigns: returning, vip, allergy-nuts. Text and not a table because they are a working vocabulary, not a taxonomy anyone will curate.';
comment on column public.guests.id_document_number is
  'Gated by the guest.view_document_id grant, separately from contact details. Minimum necessity: almost no role needs to see this.';

-- The deduplication rule, as a constraint rather than a convention: one live
-- guest per normalised phone per organization. Scoped to the organization
-- because two businesses having the same customer is the ordinary case, and a
-- global unique would leak one tenant's customer list to another by collision.
create unique index if not exists guests_organization_phone_idx
  on public.guests (organization_id, phone_e164)
  where phone_e164 is not null and deleted_at is null;

-- Email is indexed but deliberately NOT unique: a couple books two stays from
-- one address, a family shares one, and refusing the second is a support call.
create index if not exists guests_organization_email_idx
  on public.guests (organization_id, email) where email is not null;
create index if not exists guests_organization_idx
  on public.guests (organization_id) where deleted_at is null;
create index if not exists guests_tags_idx
  on public.guests using gin (tags);
create index if not exists guests_organization_name_idx
  on public.guests (organization_id, lower(full_name));

drop trigger if exists guests_touch on public.guests;
create trigger guests_touch
  before update on public.guests
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- bookings
-- ============================================================================

create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  property_id        uuid not null,
  unit_id            uuid not null,
  guest_id           uuid not null,

  -- What a person quotes on the phone. A uuid is not a booking number.
  reference          text not null default
                       'B' || upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8)),

  status             public.booking_status not null default 'inquiry',
  -- Why the status last changed. Copied into booking_status_history by the
  -- trigger, so a transition and its reason are recorded together or not at
  -- all.
  status_reason      text,

  -- Half-open [check_in, check_out), exactly as DateRange defines it. Check-out
  -- day is not occupied.
  check_in           date not null,
  check_out          date not null,
  stay               daterange generated always as (daterange(check_in, check_out, '[)')) stored,
  arrival_time       time,

  adults             integer not null default 1,
  children           integer not null default 0,
  infants            integer not null default 0,

  -- ── Attribution ──────────────────────────────────────────────────────────
  -- The whole of BookingAttribution, present from the migration that creates
  -- the table rather than added later. docs/ARCHITECTURE.md §12: a commission
  -- dispute against a table that does not know who sold the stay cannot be
  -- settled, and back-filling this onto live bookings means guessing at money.
  source             public.booking_source not null default 'direct_manual',
  source_channel     text,
  agent_user_id      uuid references auth.users (id) on delete set null,
  agency_id          uuid,
  campaign_id        uuid,
  referral_id        uuid,

  -- ── Money ────────────────────────────────────────────────────────────────
  currency           text not null default 'ILS',
  -- Owned by the database, like `version`. Recomputed from the price lines on
  -- every write to either table; a value supplied by a caller is discarded.
  -- "Why is it 6,400?" has to have an answer.
  total_agorot       integer not null default 0,
  -- What tax rule was actually applied, snapshotted. The property setting can
  -- change; an issued invoice cannot.
  tax_rate_bps       integer,
  tourist_vat_exempt boolean not null default false,

  -- ── The guest portal link ────────────────────────────────────────────────
  -- Separate from the primary key and random, because it is a capability: a
  -- guest arrives holding this and nothing else — no account, no membership,
  -- no role (docs/ARCHITECTURE.md §2). If the URL carried the id, then anyone
  -- who saw one booking's link could try neighbouring ids, and every id that
  -- appears in an internal screen or a log line would become a credential.
  -- 32 bytes from a CSPRNG, hex, unique.
  guest_token        text not null default encode(extensions.gen_random_bytes(32), 'hex'),

  guest_notes        text,
  internal_notes     text,

  metadata           jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users (id) on delete set null,

  -- One foreign key, three facts: the unit exists, it is in this property, and
  -- that property is in this organization. Nothing downstream has to re-check.
  constraint bookings_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete restrict,
  constraint bookings_guest_fkey
    foreign key (guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,

  -- What the child tables hang their tenant and property proof on.
  constraint bookings_id_organization_property_key unique (id, organization_id, property_id),
  constraint bookings_organization_reference_key unique (organization_id, reference),
  constraint bookings_guest_token_key unique (guest_token),

  constraint bookings_dates_ordered check (check_out > check_in),
  constraint bookings_adults_positive check (adults >= 1),
  constraint bookings_children_nonnegative check (children >= 0),
  constraint bookings_infants_nonnegative check (infants >= 0),
  constraint bookings_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint bookings_tax_rate_range check (tax_rate_bps is null or tax_rate_bps between 0 and 10000),
  constraint bookings_guest_token_length check (length(guest_token) >= 32),
  constraint bookings_reference_not_blank check (length(btrim(reference)) > 0),
  -- A stay sold by an agent has to name the agent. This is the column a
  -- commission argument is settled from.
  constraint bookings_agent_attributed check (
    source <> 'agent' or agent_user_id is not null
  ),
  constraint bookings_version_positive check (version >= 1),
  constraint bookings_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.bookings is
  'A stay. The date range is half-open [check_in, check_out) exactly as DateRange in src/lib/booking/types.ts defines it, so a same-day turnaround is not an overlap. Occupancy is not decided here — it is decided in unit_occupancy, which is the only table the no-double-booking constraint lives on.';
comment on column public.bookings.stay is
  'The half-open range, generated. What the availability ledger stores and what every overlap test compares.';
comment on column public.bookings.guest_token is
  'Capability token for the guest portal link. Random and unrelated to the primary key on purpose: a guest has no account, so the link is the credential, and an enumerable id in a URL would turn every id that ever appears in a log into one.';
comment on column public.bookings.total_agorot is
  'The sum of booking_price_lines.amount_agorot, maintained by trigger and never by a caller. A total nobody can explain is a total nobody can defend.';
comment on column public.bookings.agency_id is
  'The agency that sold the stay, denormalised so a departing agent does not erase the commercial relationship. Foreign key deferred: `agencies` does not exist yet, and an agency can sell for several organizations so it is not tenant-scoped.';
comment on column public.bookings.status_reason is
  'Why the status last changed. Read by the history trigger, so a transition and its reason are recorded together.';

drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch
  before update on public.bookings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- booking_status_history
-- ============================================================================
-- Every transition, who made it, when and why. Append-only on the same terms
-- as audit_events in 0005: the privileges are revoked and a statement-level
-- trigger refuses both UPDATE and DELETE.
--
-- Written only by the trigger below, never by a caller — `authenticated` is
-- not granted INSERT at all. That is what makes "no scattered status
-- mutations" true rather than aspirational: there is no way to change a
-- booking's status without recording the transition, because the recording is
-- not something the writer does.

create table if not exists public.booking_status_history (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  booking_id       uuid not null,

  from_status      public.booking_status,
  to_status        public.booking_status not null,

  changed_by       uuid references auth.users (id) on delete set null,
  reason           text,
  occurred_at      timestamptz not null default now(),

  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  constraint booking_status_history_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,
  -- from_status IS NULL is the creation of the booking; anything else is a
  -- real move.
  constraint booking_status_history_is_a_transition check (
    from_status is null or from_status <> to_status
  )
);

comment on table public.booking_status_history is
  'Every status transition of every booking: from, to, who, when, why. Append-only, and written only by the trigger on bookings — no caller is granted INSERT, so a status cannot change without the transition being recorded.';


-- ============================================================================
-- booking_price_lines
-- ============================================================================
-- Matching PriceLine and PRICE_LINE_KINDS. The total is a sum of these and is
-- never a number a person typed: `amount_agorot` is the line total in agorot,
-- negative on a discount so the sum stays a plain addition, and `quantity` is
-- what the line says on the invoice.

create table if not exists public.booking_price_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  booking_id       uuid not null,

  kind             public.price_line_kind not null,
  label            text not null,
  amount_agorot    integer not null,
  quantity         numeric(12,3) not null default 1,
  -- The night this line belongs to, for per-night accommodation lines.
  line_date        date,
  sort_order       integer not null default 0,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint booking_price_lines_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,
  constraint booking_price_lines_label_not_blank check (length(btrim(label)) > 0),
  constraint booking_price_lines_quantity_positive check (quantity > 0),
  -- Sign discipline, so the total is an addition and nothing else. A discount
  -- stored positive and subtracted somewhere is how two screens end up
  -- disagreeing about a price. `agent_commission` is unconstrained: it is
  -- recorded against the stay and the commission engine decides its direction.
  constraint booking_price_lines_sign check (
    case kind
      when 'discount'  then amount_agorot <= 0
      when 'promotion' then amount_agorot <= 0
      when 'agent_commission' then true
      else amount_agorot >= 0
    end
  ),
  constraint booking_price_lines_version_positive check (version >= 1)
);

comment on table public.booking_price_lines is
  'What the guest is paying for, one line at a time. bookings.total_agorot is the sum of amount_agorot over these lines and is maintained by trigger — "why is it 6,400?" is the most common question a guest asks, and a system that cannot answer it invites arguments it cannot win.';
comment on column public.booking_price_lines.amount_agorot is
  'The line total in agorot, not a unit price. Negative for discounts and promotions so the booking total is a plain sum.';
comment on column public.booking_price_lines.quantity is
  'What the line says on the invoice — 3 nights, 2 extra guests. Descriptive: the money is amount_agorot, already multiplied.';

drop trigger if exists booking_price_lines_touch on public.booking_price_lines;
create trigger booking_price_lines_touch
  before update on public.booking_price_lines
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- holds
-- ============================================================================
-- A temporary claim on dates. Part of the availability model itself and not a
-- feature layered on top — see the Hold interface in the contract, and
-- docs/ARCHITECTURE.md §12 on inventory blocking by agents.
--
-- `expires_at` is NOT NULL, so an unbounded hold is not representable. It is
-- deliberately NOT checked against created_at: a hold whose expiry is already
-- past is not an error, it is a hold that has lapsed. Forbidding it would make
-- "an expired hold does not block" impossible to state, and would break any
-- restore that replays rows after their expiry.

create table if not exists public.holds (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  property_id              uuid not null,
  unit_id                  uuid not null,

  check_in                 date not null,
  check_out                date not null,
  stay                     daterange generated always as (daterange(check_in, check_out, '[)')) stored,

  reason                   public.hold_reason not null,
  -- The agent or staff member who placed it. NOT NULL, per the contract, so
  -- ON DELETE CASCADE rather than SET NULL: a hold is transient by
  -- construction, and the durable record of what an account did is
  -- audit_events, which keeps the actor's name after the account is gone.
  held_by_user_id          uuid not null references auth.users (id) on delete cascade,

  expires_at               timestamptz not null,
  released_at              timestamptz,
  released_by              uuid references auth.users (id) on delete set null,
  converted_to_booking_id  uuid,

  note                     text,
  metadata                 jsonb not null default '{}'::jsonb,

  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id) on delete set null,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users (id) on delete set null,
  version                  integer not null default 1,

  constraint holds_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint holds_converted_booking_fkey
    foreign key (converted_to_booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete set null (converted_to_booking_id),
  constraint holds_dates_ordered check (check_out > check_in),
  constraint holds_released_pair check (
    (released_at is null and released_by is null) or released_at is not null
  ),
  constraint holds_version_positive check (version >= 1)
);

comment on table public.holds is
  'A temporary claim on a unit dates, placed while a sale is closed. Occupies the calendar exactly as a booking does, through the same ledger and the same exclusion constraint, because a hold that availability queries had to be told about separately is a hold somebody forgets.';
comment on column public.holds.expires_at is
  'Never null: a hold without an expiry locks up a business inventory. Not compared against created_at — an expiry in the past is a lapsed hold, not an invalid one.';
comment on column public.holds.converted_to_booking_id is
  'Set once the hold turns into a real booking. Setting it releases the ledger row, so the booking can take the dates the hold was keeping warm.';

drop trigger if exists holds_touch on public.holds;
create trigger holds_touch
  before update on public.holds
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- unit_occupancy — the availability ledger
-- ============================================================================
-- One row per thing that occupies a unit, whether it is a booking or a hold,
-- and one exclusion constraint over all of them. This is the guarantee.

create table if not exists public.unit_occupancy (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  unit_id          uuid not null,

  kind             public.occupancy_kind not null,
  booking_id       uuid references public.bookings (id) on delete cascade,
  hold_id          uuid references public.holds (id) on delete cascade,

  -- Half-open. daterange canonicalises to [) so this is enforced by the type
  -- itself; the constructor says it anyway, at every call site.
  during           daterange not null,
  -- Holds only. Read by the sweep that makes expiry real without a cron job.
  expires_at       timestamptz,

  created_at       timestamptz not null default now(),

  constraint unit_occupancy_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint unit_occupancy_shape check (
    (kind = 'booking' and booking_id is not null and hold_id is null and expires_at is null)
    or (kind = 'hold' and hold_id is not null and booking_id is null and expires_at is not null)
  ),
  constraint unit_occupancy_range_bounded check (
    not isempty(during) and lower(during) is not null and upper(during) is not null
  ),
  constraint unit_occupancy_booking_key unique (booking_id),
  constraint unit_occupancy_hold_key unique (hold_id),

  -- ── The guarantee ────────────────────────────────────────────────────────
  -- No two rows for the same unit may have overlapping ranges. `&&` on a
  -- daterange is half-open, so [Mon, Fri) and [Fri, Sun) do not overlap and a
  -- same-day turnaround is allowed; [Mon, Fri) and [Thu, Sun) do, and the
  -- second one is refused with SQLSTATE 23P01 no matter how many transactions
  -- try at once.
  constraint unit_occupancy_no_overlap
    exclude using gist (unit_id with =, during with &&)
);

comment on table public.unit_occupancy is
  'The availability ledger: one row per booking or hold that occupies a unit, and one exclusion constraint over all of them. The single place a date is taken or free. Written only by the SECURITY DEFINER triggers on bookings and holds — no caller is granted INSERT, UPDATE or DELETE, so nobody can free somebody else dates or claim dates without the record that justifies them.';
comment on column public.unit_occupancy.expires_at is
  'Copied from the hold. No index can encode now(), so expiry is realised by the writer: before inserting, a transaction clears the lapsed hold rows for that unit, inside its own transaction and holding their locks.';


-- ============================================================================
-- Keeping the ledger in step
-- ============================================================================
-- SECURITY DEFINER, because the ledger is deliberately not writable by the
-- roles that write bookings and holds. Empty search_path, matching 0004 and
-- 0007: a definer function that resolves an unqualified name through the
-- caller's search_path is a privilege escalation waiting to be found.
--
-- AFTER, not BEFORE: the ledger row references the booking, so the booking has
-- to exist first. An exclusion violation raised from an AFTER trigger aborts
-- the statement exactly as one raised from the insert itself would.

create or replace function public.tg_bookings_sync_occupancy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  occupies boolean;
begin
  -- A hold converting into this booking must let go of the dates first.
  -- Doing it here as well as on the hold means the two writes can happen in
  -- either order within the transaction, which is the difference between a
  -- conversion that works and a conversion that works if you remember the
  -- sequence.
  delete from public.unit_occupancy o
   using public.holds h
   where o.hold_id = h.id
     and h.converted_to_booking_id = new.id;

  -- Lapsed holds do not block. See the note on unit_occupancy.expires_at.
  delete from public.unit_occupancy o
   where o.unit_id = new.unit_id
     and o.kind = 'hold'::public.occupancy_kind
     and o.expires_at <= now();

  occupies := new.deleted_at is null
              and public.booking_status_occupies(new.status);

  if occupies then
    insert into public.unit_occupancy
      (organization_id, property_id, unit_id, kind, booking_id, during)
    values
      (new.organization_id, new.property_id, new.unit_id,
       'booking'::public.occupancy_kind, new.id,
       daterange(new.check_in, new.check_out, '[)'))
    on conflict (booking_id) do update
      set organization_id = excluded.organization_id,
          property_id     = excluded.property_id,
          unit_id         = excluded.unit_id,
          during          = excluded.during;
  else
    -- Cancelled, no-show, back to an enquiry, or soft-deleted: the dates come
    -- back. This is the case that is forgotten, and it loses money quietly.
    delete from public.unit_occupancy where booking_id = new.id;
  end if;

  return null;
end;
$$;

comment on function public.tg_bookings_sync_occupancy() is
  'Keeps unit_occupancy in step with a booking. Occupying status and not soft-deleted means a ledger row; anything else means none, so cancelling or soft-deleting a booking frees its dates. Also clears lapsed holds for the unit and releases any hold being converted into this booking.';

drop trigger if exists bookings_sync_occupancy on public.bookings;
create trigger bookings_sync_occupancy
  after insert or update on public.bookings
  for each row execute function public.tg_bookings_sync_occupancy();


create or replace function public.tg_holds_sync_occupancy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  live boolean;
begin
  delete from public.unit_occupancy o
   where o.unit_id = new.unit_id
     and o.kind = 'hold'::public.occupancy_kind
     and o.expires_at <= now()
     and o.hold_id <> new.id;

  live := new.released_at is null
          and new.converted_to_booking_id is null
          and new.expires_at > now();

  if live then
    insert into public.unit_occupancy
      (organization_id, property_id, unit_id, kind, hold_id, during, expires_at)
    values
      (new.organization_id, new.property_id, new.unit_id,
       'hold'::public.occupancy_kind, new.id,
       daterange(new.check_in, new.check_out, '[)'), new.expires_at)
    on conflict (hold_id) do update
      set organization_id = excluded.organization_id,
          property_id     = excluded.property_id,
          unit_id         = excluded.unit_id,
          during          = excluded.during,
          expires_at      = excluded.expires_at;
  else
    delete from public.unit_occupancy where hold_id = new.id;
  end if;

  return null;
end;
$$;

comment on function public.tg_holds_sync_occupancy() is
  'Keeps unit_occupancy in step with a hold. A hold occupies dates while it is unreleased, unconverted and unexpired; releasing it, converting it or letting it lapse takes the row away.';

drop trigger if exists holds_sync_occupancy on public.holds;
create trigger holds_sync_occupancy
  after insert or update on public.holds
  for each row execute function public.tg_holds_sync_occupancy();


create or replace function public.purge_expired_holds()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  delete from public.unit_occupancy
   where kind = 'hold'::public.occupancy_kind
     and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.purge_expired_holds() is
  'Reclaims ledger rows for holds that have lapsed. Housekeeping only — correctness does not depend on it, because the writer that would have been blocked clears the lapsed rows itself. Intended for hourly pg_cron, and deliberately not scheduled by this migration: enabling pg_cron is an operational decision. The hold rows themselves are kept; they are history.';

revoke all on function public.purge_expired_holds() from public, anon, authenticated;
grant execute on function public.purge_expired_holds() to service_role;


-- ── The status history trigger ──────────────────────────────────────────────

create or replace function public.tg_bookings_record_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.booking_status_history
      (organization_id, property_id, booking_id, from_status, to_status, changed_by, reason)
    values
      (new.organization_id, new.property_id, new.id, null, new.status,
       coalesce(new.created_by, (select auth.uid())),
       nullif(btrim(coalesce(new.status_reason, '')), ''));
  elsif new.status is distinct from old.status then
    insert into public.booking_status_history
      (organization_id, property_id, booking_id, from_status, to_status, changed_by, reason)
    values
      (new.organization_id, new.property_id, new.id, old.status, new.status,
       coalesce(new.updated_by, (select auth.uid())),
       nullif(btrim(coalesce(new.status_reason, '')), ''));
  end if;

  return null;
end;
$$;

comment on function public.tg_bookings_record_status() is
  'Records every status transition into booking_status_history, including the creation of the booking (from_status NULL). SECURITY DEFINER because no caller is granted INSERT on that table: the recording must not be something a write path can skip.';

drop trigger if exists bookings_record_status on public.bookings;
create trigger bookings_record_status
  after insert or update on public.bookings
  for each row execute function public.tg_bookings_record_status();


-- ── The total ───────────────────────────────────────────────────────────────
-- Two halves of one rule. The BEFORE trigger on bookings overwrites whatever
-- total a caller supplied with the sum of the lines, so the column cannot be
-- typed into. The AFTER trigger on the lines pushes a change back onto the
-- booking, so the two can never drift.
--
-- Yes, adding a price line bumps the booking's `version`. That is correct
-- rather than unfortunate: the booking really did change, and a form holding
-- the old total should be told its data is stale.

create or replace function public.tg_bookings_freeze_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.total_agorot := coalesce(
    (select sum(l.amount_agorot)
       from public.booking_price_lines l
      where l.booking_id = new.id),
    0
  );
  return new;
end;
$$;

comment on function public.tg_bookings_freeze_total() is
  'Overwrites bookings.total_agorot with the sum of the booking price lines on every insert and update. The total is owned by the database in the same way version is: a number a caller typed is discarded, because a total that is not the sum of its lines cannot be explained.';

drop trigger if exists bookings_freeze_total on public.bookings;
create trigger bookings_freeze_total
  before insert or update on public.bookings
  for each row execute function public.tg_bookings_freeze_total();


create or replace function public.tg_price_lines_recalc_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.booking_id, old.booking_id);
begin
  update public.bookings
     set total_agorot = coalesce(
       (select sum(l.amount_agorot)
          from public.booking_price_lines l
         where l.booking_id = target), 0)
   where id = target;

  -- A line moved between bookings: fix the one it left, too.
  if tg_op = 'UPDATE' and new.booking_id is distinct from old.booking_id then
    update public.bookings
       set total_agorot = coalesce(
         (select sum(l.amount_agorot)
            from public.booking_price_lines l
           where l.booking_id = old.booking_id), 0)
     where id = old.booking_id;
  end if;

  return null;
end;
$$;

comment on function public.tg_price_lines_recalc_total() is
  'Pushes a price line change back onto bookings.total_agorot. SECURITY DEFINER so the recalculation does not depend on the writer holding update rights on the booking itself.';

drop trigger if exists booking_price_lines_recalc_total on public.booking_price_lines;
create trigger booking_price_lines_recalc_total
  after insert or update or delete on public.booking_price_lines
  for each row execute function public.tg_price_lines_recalc_total();


-- ── booking_status_history is append-only ───────────────────────────────────
-- Same two independent refusals as audit_events in 0005: revoked privileges,
-- and a trigger, because the table owner is not bound by grants and
-- service_role has BYPASSRLS.
--
-- UPDATE is refused outright, statement-level, so a statement that would have
-- matched no rows is refused just as loudly as one that would have matched
-- many. There is no legitimate update: a correction is a new transition.
--
-- DELETE is different from audit_events, and the difference is not a
-- weakening. An audit event has no parent and is never deleted by anything.
-- A status history row is a child of a booking, and if a booking is ever hard
-- deleted its history has to go with it or the delete is impossible. So the
-- rule is stated precisely rather than absolutely: you may not delete the
-- history of a booking that still exists. That refuses every direct attempt —
-- the row-level check sees the parent — while letting the cascade through,
-- because by the time the cascade fires the booking is already gone.
-- Deleting the booking itself is `booking.delete`, a grant almost no role
-- carries, and it lands in audit_events, which nothing deletes.

create or replace function public.tg_booking_status_history_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'booking_status_history is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

comment on function public.tg_booking_status_history_append_only() is
  'Refuses UPDATE on booking_status_history. Statement-level, so a statement matching no rows is refused as loudly as one matching many.';

create or replace function public.tg_booking_status_history_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.bookings b where b.id = old.booking_id) then
    raise exception
      'booking_status_history is append-only; DELETE is not permitted while the booking exists'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function public.tg_booking_status_history_no_delete() is
  'Refuses to delete the status history of a booking that still exists. Row-level rather than statement-level on purpose: it has to let the ON DELETE CASCADE from bookings through, and by the time that cascade fires the parent row is already gone, so the EXISTS check is exactly the right discriminator.';

drop trigger if exists booking_status_history_no_update on public.booking_status_history;
create trigger booking_status_history_no_update
  before update on public.booking_status_history
  for each statement execute function public.tg_booking_status_history_append_only();

drop trigger if exists booking_status_history_no_delete on public.booking_status_history;
create trigger booking_status_history_no_delete
  before delete on public.booking_status_history
  for each row execute function public.tg_booking_status_history_no_delete();


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.guests                enable row level security;
alter table public.guests                force  row level security;
alter table public.bookings              enable row level security;
alter table public.bookings              force  row level security;
alter table public.booking_status_history enable row level security;
alter table public.booking_status_history force  row level security;
alter table public.booking_price_lines   enable row level security;
alter table public.booking_price_lines   force  row level security;
alter table public.holds                 enable row level security;
alter table public.holds                 force  row level security;
alter table public.unit_occupancy        enable row level security;
alter table public.unit_occupancy        force  row level security;

revoke all on public.guests                 from anon, authenticated;
revoke all on public.bookings               from anon, authenticated;
revoke all on public.booking_status_history from anon, authenticated;
revoke all on public.booking_price_lines    from anon, authenticated;
revoke all on public.holds                  from anon, authenticated;
revoke all on public.unit_occupancy         from anon, authenticated;

grant select, insert, update, delete on public.guests              to authenticated;
grant select, insert, update, delete on public.bookings            to authenticated;
grant select, insert, update, delete on public.booking_price_lines to authenticated;
grant select, insert, update, delete on public.holds               to authenticated;
-- Read only, both of them, and for different reasons. The history is
-- append-only and written by a trigger; the ledger is derived and written by a
-- trigger. Neither is something a caller has any business writing.
grant select on public.booking_status_history to authenticated;
grant select on public.unit_occupancy         to authenticated;

grant all    on public.guests              to service_role;
grant all    on public.bookings            to service_role;
grant all    on public.booking_price_lines to service_role;
grant all    on public.holds               to service_role;
grant select, insert on public.booking_status_history to service_role;
grant select         on public.unit_occupancy         to service_role;
-- Supabase ALTER DEFAULT PRIVILEGES grants service_role everything on a new
-- table, so these have to be taken back explicitly. service_role also carries
-- BYPASSRLS, which means the grant is the only thing standing between a
-- background job and a hand-edited calendar. The triggers are unaffected:
-- they run as the table owner.
revoke update, delete, truncate         on public.booking_status_history from service_role;
revoke insert, update, delete, truncate on public.unit_occupancy         from service_role;


-- ── Policies · guests ───────────────────────────────────────────────────────
-- Guests are organization-wide, not property-scoped: the same person stays at
-- two of the business's properties and is one record. Reading them is
-- therefore gated on the grant rather than on scope — which is exactly the
-- separation docs/ARCHITECTURE.md §12 demands between the two diaries. An
-- agent holds booking.view and not guest.view, and so gets availability
-- without the customer list.

drop policy if exists guests_select on public.guests;
create policy guests_select on public.guests
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.view')
  );

drop policy if exists guests_insert on public.guests;
create policy guests_insert on public.guests
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.create')
  );

drop policy if exists guests_update on public.guests;
create policy guests_update on public.guests
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.update')
  );

drop policy if exists guests_delete on public.guests;
create policy guests_delete on public.guests
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.delete')
  );


-- ── Policies · bookings ─────────────────────────────────────────────────────
-- Tenant, then scope, then grant. The scope term is what keeps an agent
-- assigned to two villas from reading the third one's calendar — enforced in
-- the query, not by filtering the result, which is the rule
-- docs/ARCHITECTURE.md §12 states as law for the AI as well.

drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.create')
  );

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists bookings_delete on public.bookings;
create policy bookings_delete on public.bookings
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.delete')
  );


-- ── Policies · booking_status_history ───────────────────────────────────────
-- SELECT only. There is no INSERT policy because there is no INSERT grant.

drop policy if exists booking_status_history_select on public.booking_status_history;
create policy booking_status_history_select on public.booking_status_history
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
  );


-- ── Policies · booking_price_lines ──────────────────────────────────────────
-- Reading the breakdown is booking.view_price, a narrower grant than
-- booking.view: a housekeeper needs to know a stay exists, not what it cost.

drop policy if exists booking_price_lines_select on public.booking_price_lines;
create policy booking_price_lines_select on public.booking_price_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view_price')
  );

drop policy if exists booking_price_lines_insert on public.booking_price_lines;
create policy booking_price_lines_insert on public.booking_price_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists booking_price_lines_update on public.booking_price_lines;
create policy booking_price_lines_update on public.booking_price_lines
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists booking_price_lines_delete on public.booking_price_lines;
create policy booking_price_lines_delete on public.booking_price_lines
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  );


-- ── Policies · holds ────────────────────────────────────────────────────────

drop policy if exists holds_select on public.holds;
create policy holds_select on public.holds
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists holds_insert on public.holds;
create policy holds_insert on public.holds
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.create')
  );

drop policy if exists holds_update on public.holds;
create policy holds_update on public.holds
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists holds_delete on public.holds;
create policy holds_delete on public.holds
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.cancel')
  );


-- ── Policies · unit_occupancy ───────────────────────────────────────────────
-- SELECT only, and no permission term beyond scope. This is the availability
-- diary, not the internal one: it says taken or free and nothing else, which
-- is precisely what an agent is entitled to see and precisely what the two
-- diaries in docs/ARCHITECTURE.md §12 separate. Guest names, prices and
-- sources live on `bookings`, behind booking.view.

drop policy if exists unit_occupancy_select on public.unit_occupancy;
create policy unit_occupancy_select on public.unit_occupancy
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
  );


-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists bookings_organization_idx
  on public.bookings (organization_id) where deleted_at is null;
create index if not exists bookings_property_check_in_idx
  on public.bookings (organization_id, property_id, check_in) where deleted_at is null;
create index if not exists bookings_organization_status_idx
  on public.bookings (organization_id, status) where deleted_at is null;
create index if not exists bookings_unit_idx
  on public.bookings (unit_id, check_in) where deleted_at is null;
create index if not exists bookings_guest_idx
  on public.bookings (guest_id);
-- Attribution is queried: "what did this agent sell", "what came from this
-- campaign". A commission report that sequentially scans the booking table is
-- a report someone will stop running.
create index if not exists bookings_agent_idx
  on public.bookings (organization_id, agent_user_id) where agent_user_id is not null;
create index if not exists bookings_agency_idx
  on public.bookings (organization_id, agency_id) where agency_id is not null;
create index if not exists bookings_campaign_idx
  on public.bookings (organization_id, campaign_id) where campaign_id is not null;
create index if not exists bookings_source_idx
  on public.bookings (organization_id, source) where deleted_at is null;
-- The calendar query: which stays touch this window in this unit.
create index if not exists bookings_unit_stay_idx
  on public.bookings using gist (unit_id, stay);

create index if not exists booking_status_history_booking_idx
  on public.booking_status_history (booking_id, occurred_at desc);
create index if not exists booking_status_history_organization_idx
  on public.booking_status_history (organization_id, occurred_at desc);
create index if not exists booking_status_history_property_idx
  on public.booking_status_history (property_id);

create index if not exists booking_price_lines_booking_idx
  on public.booking_price_lines (booking_id, sort_order);
create index if not exists booking_price_lines_organization_idx
  on public.booking_price_lines (organization_id);
create index if not exists booking_price_lines_property_idx
  on public.booking_price_lines (property_id);

create index if not exists holds_organization_idx
  on public.holds (organization_id);
create index if not exists holds_unit_idx
  on public.holds (unit_id, check_in);
create index if not exists holds_property_idx
  on public.holds (property_id);
create index if not exists holds_live_expiry_idx
  on public.holds (expires_at)
  where released_at is null and converted_to_booking_id is null;
-- Walked by the booking trigger on every write, to release a converting hold.
create index if not exists holds_converted_booking_idx
  on public.holds (converted_to_booking_id) where converted_to_booking_id is not null;
create index if not exists holds_held_by_idx
  on public.holds (held_by_user_id);

create index if not exists unit_occupancy_organization_idx
  on public.unit_occupancy (organization_id);
create index if not exists unit_occupancy_property_idx
  on public.unit_occupancy (property_id);
-- The sweep: lapsed hold rows for one unit. Without this it is a scan of the
-- whole ledger on every booking write.
create index if not exists unit_occupancy_hold_expiry_idx
  on public.unit_occupancy (unit_id, expires_at) where kind = 'hold';
