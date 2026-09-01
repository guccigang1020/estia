-- ============================================================================
-- 0028_booking_party.sql — ESTIA · the desk types 4/2/1 and the row says 7/0/0
--
-- What this closes
--   The preparation engine has been complete and tested for weeks. It wants
--   adults, children, infants, the couples among them, the extra beds and cots
--   asked for, and what kind of event this is. The booking form now collects
--   every one of those. And `SupabaseBookingRepository.insertBooking` writes
--   `adults: draft.guestCount, children: 0, infants: 0`, because five of the
--   columns do not exist — so the whole count round-trips, nothing looks
--   broken, and the split has gone nowhere.
--
--   `intake.test.ts` asserts exactly that today, in numbers, so that the gap
--   could not be mistaken for finished work. This migration is what lets that
--   assertion be flipped.
--
-- Why the difference matters, in one sentence
--   `allocateSleeping` is fed the sleeping guests, not the head count. An
--   infant in a cot is a head and not a bed, and feeding seven where six sleep
--   makes up a fourth bed, dresses it with two sheets and a pillow, and sends
--   a cleaner to prepare a bed nobody sleeps in. The linen for it is then
--   washed, forecast and paid for.
--
-- Why `special_requests` is not `internal_notes`
--   Because a cleaner has to read "שתי מיטות תינוק". `bookings.internal_notes`
--   sits behind `booking.note.internal`, which housekeeping deliberately does
--   not hold — it is where staff write about the guest. This column is where
--   the guest writes about the stay, so it is readable wherever `guest_notes`
--   is readable and nowhere narrower.
--
-- On the enum's name
--   `booking_event_type`, not `event_type`. 0016 already has a `text` column
--   called `event_type` meaning something else entirely, and a type and a
--   column sharing a name across two tables is how somebody in a hurry writes
--   a cast that compiles and means nothing.
--
-- Depends on
--   0009 (bookings, and its `adults`/`children`/`infants` columns), 0021
--   (preparation, whose `PreparationFacts` these feed).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · What kind of stay this is
-- ============================================================================
-- Mirrors `EVENT_TYPES` in `src/lib/preparation/types.ts` exactly, in the same
-- order. The engine picks an `EventTemplate` by this value — a Shabbat brings
-- an urn, hotplates, candles and a second urn once the party is big enough —
-- so a value the code has never heard of silently selects no template at all.
-- `accommodation` is the default because most stays are just a stay.

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'booking_event_type'
  ) then
    create type public.booking_event_type as enum (
      'accommodation',
      'day_event',
      'overnight_event',
      'wedding',
      'birthday',
      'retreat',
      'corporate',
      'shabbat',
      'family_event',
      'custom'
    );
  end if;
end $$;

comment on type public.booking_event_type is
  'What kind of stay this is, mirroring EVENT_TYPES in src/lib/preparation/types.ts. Selects the event template whose extra requirements the preparation engine adds. Named booking_event_type because 0016 already has an unrelated event_type.';


-- ============================================================================
-- 2 · The five columns
-- ============================================================================

alter table public.bookings
  add column if not exists couples integer not null default 0,
  add column if not exists extra_beds_requested integer not null default 0,
  add column if not exists cots_requested integer not null default 0,
  add column if not exists event_type public.booking_event_type
    not null default 'accommodation',
  add column if not exists special_requests text;

comment on column public.bookings.couples is
  'How many of the adults share a bed. Two couples and four colleagues are the same six people to a naive allocator and a different laundry order to a real one: three double beds against six singles. Recorded at intake so the sleeping allocation has it to consume.';
comment on column public.bookings.extra_beds_requested is
  'What the guest asked for. Not what the plan decided — SleepingAllocation.extraBeds is an output, and the two are allowed to disagree, which is precisely why they are two columns.';
comment on column public.bookings.cots_requested is
  'Baby cots. An infant occupies a cot and not a sleeping place, so this never reaches allocateSleeping and does reach the cleaner.';
comment on column public.bookings.special_requests is
  'The guest''s own words about the stay. Readable wherever guest_notes is readable, and deliberately NOT behind booking.note.internal: a cleaner has to be able to read "two baby cots". Staff write about the guest in internal_notes instead.';


-- ============================================================================
-- 3 · What cannot be stored
-- ============================================================================
-- 0009 already refuses negative adults, children and infants. These are the
-- same discipline for the new columns, plus the one relationship that is not
-- obvious: a couple is two adults, so there cannot be more couples than half
-- the adults. A form that allows three couples among four adults is a form
-- that will one day order three double beds for four people.

alter table public.bookings
  add constraint bookings_couples_nonnegative check (couples >= 0),
  add constraint bookings_couples_within_adults check (couples * 2 <= adults),
  add constraint bookings_extra_beds_nonnegative
    check (extra_beds_requested >= 0),
  add constraint bookings_cots_nonnegative check (cots_requested >= 0),
  -- Long enough for a real request, short enough that it is not a document.
  add constraint bookings_special_requests_length
    check (special_requests is null or length(special_requests) <= 1000);


-- ============================================================================
-- 4 · Rehearsal
-- ============================================================================
-- Assert what this migration assumed, so a drifted schema fails here rather
-- than at the moment a cleaner opens a plan for the wrong number of beds.

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('couples'), ('extra_beds_requested'), ('cots_requested'),
    ('event_type'), ('special_requests'),
    -- The three this work depends on and did not add.
    ('adults'), ('children'), ('infants'), ('guest_notes')
  ) as c(name)
  where not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bookings'
      and column_name = c.name
  );

  if missing is not null then
    raise exception 'bookings is missing columns after 0028: %', missing;
  end if;

  -- The enum's members, in the order the engine expects. A member added to
  -- `EVENT_TYPES` and not here selects no template and produces a plan with
  -- the event's requirements silently absent.
  select string_agg(name, ', ') into missing
  from (values
    ('accommodation'), ('day_event'), ('overnight_event'), ('wedding'),
    ('birthday'), ('retreat'), ('corporate'), ('shabbat'),
    ('family_event'), ('custom')
  ) as e(name)
  where not exists (
    select 1
    from pg_enum en
    join pg_type t on t.oid = en.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'booking_event_type'
      and en.enumlabel = e.name
  );

  if missing is not null then
    raise exception 'booking_event_type is missing members: %', missing;
  end if;

  -- The constraints, by name.
  --
  -- Deliberately checked against the catalogue rather than by inserting a row
  -- that ought to be refused. A rehearsal that writes to `bookings` fires the
  -- reference generator and the occupancy trigger, and a fabricated booking —
  -- even one rolled back a millisecond later — is not something a migration
  -- should be doing to a tenant's table. What can be asserted here is that
  -- each CHECK exists, which is the failure mode that actually occurs: a
  -- constraint written and not applied looks identical to one that works.
  select string_agg(name, ', ') into missing
  from (values
    ('bookings_couples_nonnegative'),
    ('bookings_couples_within_adults'),
    ('bookings_extra_beds_nonnegative'),
    ('bookings_cots_nonnegative'),
    ('bookings_special_requests_length')
  ) as k(name)
  where not exists (
    select 1 from pg_constraint where conname = k.name
  );

  if missing is not null then
    raise exception '0028 constraints missing: %', missing;
  end if;
end $$;
