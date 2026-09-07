-- ============================================================================
-- 0074_leads_and_guest_merges.sql — ESTIA · the enquiry, and two rows that
--                                   turn out to be one person
--
-- Closes the last two entities of `docs/spec/40-guest-crm.md` that were never
-- built: §3.3 `leads` and §3.2 `guest_merges`. Everything else in that module
-- exists — `guests` (0009), `conversations` and `conversation_messages`
-- (0063), `guest_messages` (0053), `message_templates` (0071), and the guest
-- access link, which is `bookings.guest_token` plus the `guest_link_*` columns
-- rather than a table of its own. That last one is deliberate and is not
-- touched here.
--
--
-- ══ 1 · WHY A `leads` TABLE AT ALL, WHEN `/leads` ALREADY WORKS ═════════════
--
-- `src/app/(app)/leads/_lib/queries.ts` opens by saying, honestly, that there
-- is no `leads` table and that it is reading `bookings` in the four statuses
-- before a sale is committed. It also names precisely what that costs, and the
-- sentence is worth repeating because it is the whole argument for this table:
--
--     "`bookings` requires `unit_id`, `check_in` and `check_out`, so
--      'somebody rang about August, no dates fixed' cannot be recorded at
--      all."
--
-- That is not a cosmetic gap. The enquiry a guesthouse loses money on is
-- exactly the one with no dates and no unit — the one that has to be answered
-- before it can become anything. A product that can only record an enquiry
-- once it is specific enough to be a booking cannot answer "who rang and never
-- got a reply", which §1 of the specification names as one of the four
-- questions the module exists for.
--
-- ── So what happens to the existing screen? ────────────────────────────────
--
-- It is NOT deleted and its rows are NOT migrated. Two different things are
-- being counted and they are both real:
--
--     a `lead`    an enquiry. There is no stay. Nothing is held, nothing is
--                 priced, and the unit may not have been chosen.
--     a `booking` in `inquiry`/`quote`/`option` — a stay being opened. A unit
--                 and dates exist; the money has not settled.
--
-- Copying today's pre-commit bookings into `leads` would invent an enquiry
-- that nobody recorded, and give every one of those stays two rows in the
-- funnel. So the screen shows both, under separate headings, and DE-DUPLICATES
-- them: a booking whose id appears in `leads.booking_id` is shown as that
-- lead's outcome and never again as a pipeline item of its own. There is
-- exactly one row per thing being worked.
--
-- ── "A lead that became a booking stops being a lead" ──────────────────────
--
-- `leads_booked_names_its_booking` makes `booking_id` mandatory at
-- `status = 'booked'`, and `tg_lead_is_governed` makes `booked` terminal. A
-- booked lead leaves the open pipeline by definition rather than by a filter
-- somebody remembered to write.
--
-- 🔒 There is deliberately NO SQL check that the linked booking is out of
-- `inquiry`/`quote`/`option`. `src/lib/revenue/stays.ts` already owns that
-- definition — it is the reason those three statuses are excluded from
-- occupancy — and restating the list here would create a second definition of
-- "demand" that can drift from it silently. The rule is enforced in
-- `src/lib/leads/transitions.ts`, which imports `isDemand` from that file, so
-- there is one list in the product and this migration does not fork it.
--
--
-- ══ 2 · A MERGE IS NEVER SILENT AND NEVER AUTOMATIC ═════════════════════════
--
-- Two guest rows with the same telephone number are a SUGGESTION. Families
-- share numbers, a guesthouse hands the desk telephone to whoever is
-- checking in, and a business that finds two stays merged onto the wrong
-- person has lost the history of both. So:
--
--   · `public.guest_merge_apply` is the ONLY way a row is written into
--     `guest_merges`. `authenticated` holds SELECT on that table and nothing
--     else — no INSERT, no UPDATE, no DELETE — so the record of who decided,
--     when, and which row survived cannot be forged or erased from any request
--     path, including by somebody holding every grant in the catalogue.
--   · The function refuses a reason shorter than ten characters (§8), refuses
--     a guest merged into itself, refuses a guest that is already merged or
--     already deleted, and refuses when either row's `version` is not the one
--     the screen was showing (ח40-17).
--   · Nothing calls it on a schedule and nothing calls it from a score. The
--     score in `src/lib/leads/matching.ts` produces a suggestion; a person
--     types the survivor's name to confirm it.
--
--
-- ══ 3 · REVERSIBLE, AND IT REFUSES RATHER THAN LOSING DATA ══════════════════
--
-- Both, and the two are not alternatives here — the second is what makes the
-- first honest.
--
-- **REVERSIBLE FOR 30 DAYS.** `guest_merges.undo_deadline` is
-- `performed_at + 30 days`. Inside that window `public.guest_merge_undo` puts
-- back exactly the row ids in `moved` and exactly the values in
-- `field_resolutions`.
--
-- **IT REFUSES RATHER THAN GUESSING.** `moved` records, for every row it
-- touched, the row's `version` as it stood immediately after the move. Undo
-- compares that against the row's version now, and refuses — naming every
-- table and id that moved on — if anything was edited since. This is ח40-15,
-- and the version is used rather than `updated_at > performed_at` for a
-- concrete reason: the merge itself bumps `updated_at` on every row it
-- touches, so a timestamp comparison would refuse every undo that ever
-- existed. A version recorded at the moment of the move is exact.
--
-- **NOTHING IS EVER DELETED, SO NOTHING BECOMES UNREACHABLE.** The full walk
-- of every table in this database that carries a `guest_id`:
--
--   table              | fk before        | on merge            | on undo
--   -------------------+------------------+---------------------+----------
--   bookings           | not null,restrict| guest_id → survivor | restored
--   store_orders       | null, restrict   | guest_id → survivor | restored
--   guest_messages     | not null,cascade | guest_id → survivor | restored
--   conversations      | null, set null   | guest_id → survivor | restored
--   guest_reviews      | null, set null   | guest_id → survivor | restored
--   leads (below)      | null, set null   | guest_id → survivor | restored
--
--   guests (merged)    | —                | deleted_at set,     | deleted_at
--                      |                  | merged_into_guest_id| cleared,
--                      |                  | → survivor.         | pointer
--                      |                  | NOT hard-deleted.   | cleared
--   guests (survivor)  | —                | resolved fields     | overwritten
--                      |                  | overwritten         | values put
--                      |                  |                     | back
--   guests (chained)   | —                | any row already     | repointed
--                      |                  | merged into the     | back
--                      |                  | merged guest is     |
--                      |                  | repointed to the    |
--                      |                  | survivor (ק40-10)   |
--
-- Every id above is written into `guest_merges.moved`, keyed by table.
--
-- 🔒 **The list is not trusted to stay complete.** `guest_merge_apply` asks
-- `information_schema` for every base table in `public` with a `guest_id`
-- column and REFUSES THE MERGE if one appears that it does not know how to
-- move. A merge that quietly leaves a table behind is the failure this whole
-- design exists to prevent, and a comment asking future authors to remember is
-- not a mechanism.
--
-- **What does NOT move, and why that is correct.** `payments`, `invoices`,
-- `fiscal_documents`, `booking_contract_signatures`, `guest_requests` and
-- `booking_price_lines` carry no `guest_id`: they hang off a booking, and they
-- move with the booking they belong to. ח40-11 says this in as many words —
-- payments and invoices depend on the stay, not on the person.
--
-- ── What a merge is NOT allowed to copy ────────────────────────────────────
--
-- `docs/PERSONAL_DATA_INVENTORY.md` records that `guests` holds a date of
-- birth, an identity-document number and a full address, that the document
-- number sits in plain text, and that it is the most sensitive field in the
-- database. §14 of the specification puts it on the list of things that are
-- NEVER written to an audit trail.
--
-- So the resolvable set is an ALLOW-LIST, and it stops at identity and contact:
--
--     chooseable by a person: full_name · first_name · last_name ·
--                             email · phone · phone_alt · language
--     decided by rule:        tags (union) · notes (concatenated) ·
--                             marketing_consent (+ _at) · is_blocked (+ reason)
--
--     never read, never copied, never recorded in `field_resolutions`:
--         date_of_birth · nationality · id_document_type ·
--         id_document_number · id_document_country · address_line1 · city ·
--         postal_code · country · metadata
--
-- A merge decides who the person is and how to reach them. It does not decide
-- where they live or what their passport says. Nothing is lost by refusing to
-- copy those: the merged row is soft-deleted, not erased, and still holds
-- every one of them.
--
-- ── The four rules that are NOT a person's choice (ח40-12) ─────────────────
--
--   `marketing_consent`  REFUSAL WINS. `survivor AND merged`. Consent survives
--                        only where both rows carried it, and then with the
--                        later `marketing_consent_at`. A screen that let
--                        somebody pick "yes" after one of the two people said
--                        no would be the bug, so the function computes it and
--                        ignores any choice sent for it.
--   `is_blocked`         THE BLOCK WINS. `survivor OR merged`, reasons
--                        concatenated. A person blocked for damage does not
--                        become unblocked by being recognised twice.
--   `tags`               union.
--   `notes`              concatenated under a dated heading.
--
-- ── Why these are SECURITY DEFINER, and what that costs ────────────────────
--
-- The person merging holds `guest.update` and `guest.delete`. They do not
-- necessarily hold `booking.update`, `message.view` or `review.manage` — and
-- they should not have to: `guest.merge` is not in the permission catalogue
-- (§6 ח40-19 says so and recommends adding it), so the merge is gated on
-- `guest.update` AND `guest.delete` together and treated as a sensitive
-- action. Moving a booking's `guest_id` under the caller's own row level
-- security would therefore fail for exactly the people who are supposed to be
-- doing this.
--
-- The alternative is a service-role client in the request path, which puts a
-- credential that bypasses every policy in the database into a screen, so that
-- two guest cards can be joined. 0061 makes this argument at length and this
-- follows it: one SECURITY DEFINER function, `search_path` pinned to `''`,
-- every object schema-qualified, membership and BOTH permissions checked
-- explicitly inside — because RLS is bypassed in the body and those checks are
-- then the only boundary left — and `revoke ... from public, anon` BY NAME,
-- since Supabase's default privileges grant EXECUTE to `anon` individually and
-- a revoke from PUBLIC does not take that away.
--
--
-- ══ 4 · NEVER MATCH ON NAME ═════════════════════════════════════════════════
--
-- `src/lib/inbox/threading.ts` already settled this for conversations and the
-- reason holds unchanged here: half the guesthouses in this country have had
-- two guests called דוד כהן. `leads.phone_e164` is generated by the same
-- `public.normalize_phone_il` that generates `guests.phone_e164`, so attaching
-- a lead to a guest is an equality test between two columns the database
-- computed — never a string this file normalises a second time, and never a
-- name. §7.1's similarity score gives a name a weight of 0.12 against a
-- threshold of 0.85, which is another way of saying the same thing.
--
--
-- Depends on 0001 (`tg_touch_row`), 0002 (`teams`, `has_permission`),
-- 0004 (`my_organizations`), 0008 (`property_in_scope`), 0009 (`guests`,
-- `bookings`, `normalize_phone_il`), 0015 (`agencies`), 0032 (`store_orders`),
-- 0053 (`guest_messages`), 0063 (`conversations`), 0066 (`guest_reviews`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabulary
-- ============================================================================

do $$ begin
  create type public.lead_status as enum (
    'new', 'contacted', 'interested', 'quote_sent', 'negotiation',
    'booked', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lead_source as enum (
    'website', 'phone', 'whatsapp', 'agent', 'ota_enquiry', 'social',
    'walk_in', 'referral');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lead_lost_reason as enum (
    'price', 'dates_unavailable', 'no_response', 'booked_elsewhere',
    'not_serious', 'duplicate', 'other');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2 · guests · the one column a merge needs
-- ============================================================================
-- The specification asks for eleven new columns on `guests` (§3.3). Ten of
-- them — `preferred_channel`, `preferences`, the stay roll-ups, the erasure
-- state and `source_first_touch` — belong to the profile and the erasure
-- pathway, and adding them here would be claiming work this migration does not
-- do. `merged_into_guest_id` is the one that belongs to merging, and without
-- it a merge cannot be represented at all.

alter table public.guests
  add column if not exists merged_into_guest_id uuid;

do $$ begin
  alter table public.guests
    add constraint guests_merged_into_fkey
    foreign key (merged_into_guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.guests
    add constraint guests_not_merged_into_itself
    check (merged_into_guest_id is null or merged_into_guest_id <> id);
exception when duplicate_object then null; end $$;

-- A merged guest is soft-deleted rather than erased, which is what takes it
-- out of `guests_organization_phone_idx` and frees the number for the
-- survivor (ח40-13). The reverse — a row that points at a survivor and is
-- still live — would be a person present twice under one telephone number,
-- which the unique index would refuse anyway; saying it as a constraint says
-- WHY it is refused.
do $$ begin
  alter table public.guests
    add constraint guests_merged_is_deleted
    check (merged_into_guest_id is null or deleted_at is not null);
exception when duplicate_object then null; end $$;

comment on column public.guests.merged_into_guest_id is
  'The guest this row was merged into. Set together with deleted_at by guest_merge_apply and by nothing else. An old id that keeps turning up in an external link — an OTA reference, a printed confirmation, somebody bookmark — has to lead to the right person, so the row is kept and made to point rather than removed.';

-- Routing an old id to the person it now belongs to. Partial, because almost
-- no row is merged and a full index would be paid for on every guest write.
create index if not exists guests_merged_into_idx
  on public.guests (organization_id, merged_into_guest_id)
  where merged_into_guest_id is not null;


-- ============================================================================
-- 3 · leads
-- ============================================================================

create table if not exists public.leads (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,

  -- Null on purpose, and this is the column that justifies the whole table:
  -- "somebody rang about August" names no property, and a product that
  -- refuses to write it down is a product that loses it.
  property_id           uuid,

  -- Filled the moment an identity matches (ח40-08). Never invented: creating
  -- a lead NEVER creates a guest, because a second card for somebody who is
  -- already on file is the failure §17 opens with.
  guest_id              uuid,

  status                public.lead_status not null default 'new',
  source                public.lead_source not null,
  source_detail         text,

  -- AS TYPED. Not trimmed into shape, not corrected, not normalised. When the
  -- deduplication later turns out to have joined two people, the only way to
  -- see how is to still have what the person actually wrote.
  raw_name              text,
  raw_phone             text,
  raw_email             text,

  -- The attachment key, generated by the SAME function that generates
  -- `guests.phone_e164`. Two columns computed by one function can be compared;
  -- two strings normalised by two code paths cannot.
  phone_e164            text generated always as (public.normalize_phone_il(raw_phone)) stored,
  -- The candidate key. Case and surrounding space only — exactly what
  -- `normaliseEmail` in `src/lib/inbox/threading.ts` does, and deliberately
  -- NOT stripping dots or `+tags`, which are one provider's rules and not the
  -- internet's. `email` is a candidate and never an identity (ח40-06).
  email_normalized      text generated always as (nullif(lower(btrim(raw_email)), '')) stored,

  requested_check_in    date,
  requested_check_out   date,
  party_adults          integer not null default 1,
  party_children        integer not null default 0,
  party_infants         integer not null default 0,

  budget_agorot         integer,
  message               text,

  assigned_to_user_id   uuid references auth.users (id) on delete set null,
  assigned_team_id      uuid,

  -- Written ONCE (ח40-22). The trigger restores the old value on every later
  -- update, so a second write cannot happen even from a caller that names the
  -- column. A response-time median that can be improved by touching a row is
  -- not a measurement.
  first_response_at     timestamptz,
  next_action_at        timestamptz,
  status_changed_at     timestamptz not null default now(),

  lost_reason           public.lead_lost_reason,
  lost_note             text,

  booking_id            uuid,

  agent_user_id         uuid references auth.users (id) on delete set null,
  agency_id             uuid references public.agencies (id) on delete restrict,

  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,
  deleted_at            timestamptz,
  deleted_by            uuid references auth.users (id) on delete set null,

  constraint leads_id_organization_key unique (id, organization_id),

  constraint leads_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id)
    on delete set null (property_id),
  constraint leads_guest_fkey
    foreign key (guest_id, organization_id)
    references public.guests (id, organization_id)
    on delete set null (guest_id),
  constraint leads_team_fkey
    foreign key (assigned_team_id, organization_id)
    references public.teams (id, organization_id)
    on delete set null (assigned_team_id),
  -- RESTRICT, not SET NULL. `leads_booked_names_its_booking` requires the id
  -- at `status = 'booked'`, so a SET NULL would turn deleting a booking into a
  -- check violation raised from a table nobody was looking at. Refusing the
  -- delete outright says the real thing: this stay is the answer to an enquiry
  -- and erasing it erases the answer. Bookings are soft-deleted in this
  -- product anyway.
  constraint leads_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete restrict,

  -- ח40-20 · An enquiry with no way to reply to it is not a lead.
  --
  -- Written against the same immutable expressions that generate `phone_e164`
  -- and `email_normalized` rather than against those columns, so the
  -- constraint does not depend on the order in which a server evaluates
  -- generated columns and table constraints. The point of writing it this way
  -- round is that " -- " in the telephone box normalises to null and is
  -- refused, where `raw_phone is not null` would have accepted it.
  constraint leads_can_be_answered check (
    public.normalize_phone_il(raw_phone) is not null
    or nullif(lower(btrim(raw_email)), '') is not null),

  constraint leads_dates_ordered check (
    requested_check_in is null
    or requested_check_out is null
    or requested_check_out > requested_check_in),
  constraint leads_party_has_an_adult check (party_adults >= 1),
  constraint leads_party_nonnegative check (
    party_children >= 0 and party_infants >= 0),
  constraint leads_budget_nonnegative check (
    budget_agorot is null or budget_agorot >= 0),

  -- ח40-21
  constraint leads_lost_names_a_reason check (
    (status = 'lost') = (lost_reason is not null)),
  constraint leads_other_needs_a_note check (
    lost_reason is distinct from 'other'
    or length(btrim(coalesce(lost_note, ''))) > 0),
  constraint leads_note_belongs_to_a_reason check (
    lost_note is null or lost_reason is not null),

  -- "A lead that became a booking stops being a lead", as a constraint.
  constraint leads_booked_names_its_booking check (
    status <> 'booked' or booking_id is not null),

  constraint leads_version_positive check (version >= 1),
  constraint leads_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null)
);

comment on table public.leads is
  'An enquiry that is not yet a booking. Separate from bookings because bookings require a unit and two dates, so the enquiry that matters most — "somebody rang about August" — could not be written down at all. A lead that converts carries booking_id and moves to booked, which is what keeps one person out of both the funnel and the occupancy figures. See the header of 0074_leads_and_guest_merges.sql.';
comment on column public.leads.raw_phone is
  'The telephone number AS TYPED. phone_e164 beside it is the normalised form and the attachment key; this one is the evidence of what the person actually wrote, which is the only way to explain a deduplication after the fact.';
comment on column public.leads.phone_e164 is
  'Generated by public.normalize_phone_il, the same function that generates guests.phone_e164. Attaching a lead to a guest is therefore an equality test between two columns the database computed, never a comparison between two strings normalised by two code paths.';
comment on column public.leads.first_response_at is
  'When somebody first answered. Written once and then restored by tg_lead_is_governed on every later update: a response time that can be improved by touching the row is not a measurement (ח40-22).';
comment on column public.leads.guest_id is
  'The guest this enquiry turned out to be, or null. Creating a lead never creates a guest — it either attaches to one whose phone_e164 matches exactly, or it leaves this null (ח40-08). An email match is a suggestion for a person to accept, never an attachment.';

-- §3.3 · the four the screens actually ask for.
create index if not exists leads_org_status_next_action_idx
  on public.leads (organization_id, status, next_action_at)
  where deleted_at is null;
create index if not exists leads_org_phone_idx
  on public.leads (organization_id, phone_e164)
  where phone_e164 is not null and deleted_at is null;
create index if not exists leads_org_assignee_idx
  on public.leads (organization_id, assigned_to_user_id, status)
  where deleted_at is null;
create index if not exists leads_org_created_idx
  on public.leads (organization_id, created_at desc);
-- The guest profile's "enquiries" tab, and the merge, which has to find every
-- lead belonging to a guest before it can move them.
create index if not exists leads_org_guest_idx
  on public.leads (organization_id, guest_id)
  where guest_id is not null;
-- The de-duplication the pipeline screen performs: which bookings are already
-- accounted for as a lead's outcome.
create index if not exists leads_org_booking_idx
  on public.leads (organization_id, booking_id)
  where booking_id is not null;


-- ── The state machine, in the database ─────────────────────────────────────
--
-- §4.1 is mirrored in `src/lib/leads/transitions.ts`, which is where the
-- Hebrew refusal comes from and where the screen learns which buttons to draw.
-- Both exist on purpose and they are not equal: **if they ever disagree, this
-- one wins and the screen is wrong.** A state machine that lives only in
-- TypeScript is a state machine a crafted POST walks straight past.

create or replace function public.tg_lead_is_governed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if tg_op = 'INSERT' then
    -- Every lead's history starts at `new`. Not a formality: `lead_conversion`
    -- (§7.5) divides booked leads by leads CREATED in the range, and a row
    -- that arrives already `booked` is a conversion nobody ever worked.
    if new.status <> 'new'::public.lead_status then
      raise exception
        'a lead is created as new; % is a state it has to be moved into',
        new.status
        using errcode = 'check_violation';
    end if;

    -- A lead cannot arrive carrying a history it has not had.
    new.first_response_at := null;
    new.status_changed_at := pg_catalog.now();
    new.created_at        := pg_catalog.now();
    new.created_by        := (select auth.uid());
    new.updated_at        := new.created_at;
    new.updated_by        := new.created_by;
    new.version           := 1;
    new.deleted_at        := null;
    new.deleted_by        := null;
    return new;
  end if;

  -- A lead cannot be moved to another tenant, taking its funnel with it.
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a lead cannot be moved to another organization'
      using errcode = 'check_violation';
  end if;

  new.created_at := old.created_at;
  new.created_by := old.created_by;

  -- ח40-22 · write-once, restored rather than refused: an UPDATE that names
  -- the column alongside twenty legitimate ones should not fail, it should
  -- leave the measurement alone.
  if old.first_response_at is not null then
    new.first_response_at := old.first_response_at;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'booked'::public.lead_status then
      raise exception
        'a booked lead is final; cancelling the booking does not reopen it'
        using errcode = 'check_violation';
    end if;

    v_allowed := (old.status, new.status) in (
      ('new',        'contacted'),
      ('new',        'quote_sent'),
      ('new',        'lost'),
      ('contacted',  'interested'),
      ('contacted',  'quote_sent'),
      ('contacted',  'lost'),
      ('interested', 'quote_sent'),
      ('interested', 'booked'),
      ('interested', 'lost'),
      ('quote_sent', 'negotiation'),
      ('quote_sent', 'booked'),
      ('quote_sent', 'lost'),
      ('negotiation','booked'),
      ('negotiation','lost'),
      ('lost',       'contacted')
    );

    if not v_allowed then
      raise exception 'a lead cannot move from % to %', old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- §4.1 · reopening clears the reason. Leaving it behind would let the
    -- "why we lose sales" breakdown count a lead that was not lost.
    if old.status = 'lost'::public.lead_status then
      new.lost_reason := null;
      new.lost_note   := null;
    end if;

    new.status_changed_at := pg_catalog.now();
  else
    new.status_changed_at := old.status_changed_at;
  end if;

  new.updated_at := pg_catalog.now();
  new.updated_by := (select auth.uid());
  new.version    := old.version + 1;
  return new;
end $$;

comment on function public.tg_lead_is_governed() is
  'The lead state machine and the metadata block in one trigger, so version has exactly one writer. Enforces §4.1 of docs/spec/40-guest-crm.md: a lead is created as new, booked is terminal, reopening a lost lead clears its reason, and first_response_at is written once and then restored on every later update.';

drop trigger if exists leads_is_governed on public.leads;
create trigger leads_is_governed
  before insert or update on public.leads
  for each row execute function public.tg_lead_is_governed();


-- ============================================================================
-- 4 · guest_merges
-- ============================================================================

create table if not exists public.guest_merges (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,

  survivor_guest_id   uuid not null,
  merged_guest_id     uuid not null,

  -- Per field: where the surviving value came from, and what it replaced.
  -- Restricted to the allow-list in the header — no document number, no date
  -- of birth, no address ever reaches this column.
  field_resolutions   jsonb not null default '{}'::jsonb,

  -- Per table: every row id that moved, and the row's `version` immediately
  -- after it moved. The version is the undo condition (ח40-15).
  moved               jsonb not null default '{}'::jsonb,

  reason              text not null,
  -- RESTRICT, and not null. Every other table in this database lets an author
  -- become null when the account goes; here the author IS the record. "Two
  -- people's histories were joined by nobody" is not an answer anybody can act
  -- on two years later, so removing the account is refused while the merge
  -- stands rather than quietly emptying the column.
  performed_by        uuid not null references auth.users (id) on delete restrict,
  performed_at        timestamptz not null default now(),

  -- performed_at + 30 days. Not a generated column: adding a day interval to a
  -- timestamptz is stable rather than immutable, so the database will not
  -- store it as one. Written by guest_merge_apply and checked here.
  undo_deadline       timestamptz not null,

  undone_at           timestamptz,
  undone_by           uuid references auth.users (id) on delete restrict,
  undo_reason         text,

  constraint guest_merges_id_organization_key unique (id, organization_id),
  constraint guest_merges_survivor_fkey
    foreign key (survivor_guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,
  constraint guest_merges_merged_fkey
    foreign key (merged_guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,

  constraint guest_merges_two_different_people check (
    survivor_guest_id <> merged_guest_id),
  -- §8 · "יש להסביר למה מיזגת את הפרופילים." Ten characters is not much; it
  -- is the point at which somebody writes a phrase rather than presses a key,
  -- and the whole value of the reason is that a person reads it two months
  -- later.
  constraint guest_merges_reason_is_a_sentence check (
    length(btrim(reason)) >= 10),
  constraint guest_merges_undo_window check (undo_deadline > performed_at),
  -- An undo is a decision with an author, a time and a reason, or it did not
  -- happen. All three or none.
  constraint guest_merges_undo_shape check (
    (undone_at is null and undone_by is null and undo_reason is null)
    or (undone_at is not null and undone_by is not null
        and length(btrim(coalesce(undo_reason, ''))) >= 10)),
  constraint guest_merges_snapshot_is_complete check (
    jsonb_typeof(field_resolutions) = 'object'
    and jsonb_typeof(moved) = 'object')
);

comment on table public.guest_merges is
  'Who decided that two guest rows were one person, when, which row survived, what was overwritten and exactly which rows moved. Written only by guest_merge_apply and updated only by guest_merge_undo: authenticated holds SELECT and nothing else, so the record cannot be forged or erased from any request path. moved and field_resolutions are the undo condition — a merge without a complete snapshot is an irreversible merge, and that cannot be repaired afterwards.';
comment on column public.guest_merges.moved is
  'Per table, every row that moved: {"bookings":[{"id":…,"from":…,"version":…}]}. The version is the row''s version immediately after the move, and undo refuses when it no longer matches — a row edited since the merge must not be silently rewritten (ח40-15). Version rather than updated_at because the merge itself bumps updated_at on every row it touches.';

create index if not exists guest_merges_org_survivor_idx
  on public.guest_merges (organization_id, survivor_guest_id, performed_at desc);
create index if not exists guest_merges_org_merged_idx
  on public.guest_merges (organization_id, merged_guest_id);
-- The 30-day banner on the profile: "merged 3 days ago · undo".
create index if not exists guest_merges_org_undoable_idx
  on public.guest_merges (organization_id, undo_deadline)
  where undone_at is null;


-- ============================================================================
-- 5 · The tables a merge must walk
-- ============================================================================
-- Asked of the catalogue rather than remembered, so that a table added by
-- somebody else tomorrow is DISCOVERED rather than forgotten. `guest_merge_apply`
-- compares this against the list it knows how to move and refuses if they
-- differ.

create or replace function public.tables_carrying_guest_id()
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(c.table_name::text order by c.table_name), '{}'::text[])
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'guest_id'
    and t.table_type = 'BASE TABLE';
$$;

comment on function public.tables_carrying_guest_id() is
  'Every base table in public with a guest_id column, from the catalogue. guest_merge_apply refuses a merge when this returns a table it does not know how to move — a merge that quietly leaves rows pointing at a deleted guest is the failure the whole design exists to prevent, and a comment asking future authors to remember is not a mechanism.';

revoke all on function public.tables_carrying_guest_id() from public, anon;
grant execute on function public.tables_carrying_guest_id() to authenticated, service_role;


-- ============================================================================
-- 6 · guest_merge_apply
-- ============================================================================
-- SECURITY DEFINER. Row level security is bypassed in the body, so membership
-- and BOTH permissions are checked explicitly here and those checks are the
-- only tenant boundary that remains. See §3 of the header.
--
-- Every refusal below raises a message beginning with a stable uppercase
-- token. `src/lib/leads/errors.ts` maps the token to a Hebrew
-- BusinessRuleError; the English half is the diagnostic. Matching on a token
-- rather than on prose means the sentence can be improved without breaking the
-- screen.

create or replace function public.guest_merge_apply(
  p_organization_id   uuid,
  p_survivor_guest_id uuid,
  p_merged_guest_id   uuid,
  p_survivor_version  integer,
  p_merged_version    integer,
  p_field_choices     jsonb,
  p_reason            text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The tables this function knows how to move. Compared against the
  -- catalogue below; a mismatch refuses the merge.
  c_tables  constant text[] := array[
    'bookings', 'conversations', 'guest_messages', 'guest_reviews',
    'leads', 'store_orders'];

  -- KNOWN, AND DELIBERATELY NOT MOVED.
  --
  -- `discount_redemptions` (0073) carries a `guest_id` and it stays where it
  -- is. Two reasons, and the first is the one that decides it:
  --
  --   · The table is APPEND-ONLY. 0073 revokes the privileges and installs a
  --     statement-level refusal of UPDATE, because a redemption is the frozen
  --     record of a discount somebody was actually given. Rewriting its
  --     `guest_id` is an UPDATE, so moving it would mean either breaking that
  --     law or carving an exception into it — and an append-only financial
  --     record with an exception is not one.
  --   · Nothing is lost by leaving it. A redemption hangs off a booking
  --     through `price_line_id`, and `bookings` DOES move to the survivor, so
  --     the survivor's history still reaches every discount they were given.
  --     The column records who redeemed it at that moment, which remains true.
  --
  -- This list exists at all because the guard below must distinguish "a table
  -- appeared that nobody has thought about" from "a table appeared and the
  -- answer was no". Without it, 0073 landing one migration earlier made every
  -- merge in the product refuse — which is exactly what happened, and is why
  -- the guard is worth having.
  c_frozen  constant text[] := array['discount_redemptions'];

  v_unknown   text;
  v_first     uuid;
  v_second    uuid;
  v_survivor  public.guests%rowtype;
  v_merged    public.guests%rowtype;
  v_table     text;
  v_rows      jsonb;
  v_moved     jsonb := '{}'::jsonb;
  v_res       jsonb := '{}'::jsonb;
  v_now       timestamptz := pg_catalog.now();
  v_actor     uuid := (select auth.uid());
  v_merge_id  uuid;

  -- The resolved survivor.
  v_full_name  text;
  v_first_name text;
  v_last_name  text;
  v_email      extensions.citext;
  v_phone      text;
  v_phone_alt  text;
  v_language   text;
  v_tags       text[];
  v_notes      text;
  v_consent    boolean;
  v_consent_at timestamptz;
  v_blocked    boolean;
  v_block_why  text;
  v_version    integer;
begin
  if p_organization_id is null
     or p_survivor_guest_id is null
     or p_merged_guest_id is null then
    raise exception 'GUEST_MERGE_INCOMPLETE: an organization and two guests are required'
      using errcode = 'check_violation';
  end if;

  -- ק40-09
  if p_survivor_guest_id = p_merged_guest_id then
    raise exception 'GUEST_MERGE_SAME_ROW: a guest cannot be merged into itself'
      using errcode = 'check_violation';
  end if;

  if length(pg_catalog.btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'GUEST_MERGE_NEEDS_A_REASON: a merge is explained or it does not happen'
      using errcode = 'check_violation';
  end if;

  -- The only tenant boundary in a definer function.
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'GUEST_MERGE_FORBIDDEN: not a member of this organization'
      using errcode = '42501';
  end if;

  -- ח40-19 · `guest.merge` is not in the catalogue, so both halves of what a
  -- merge actually does are required together. AND, never OR: a person who may
  -- edit a guest but not remove one must not be able to remove one by calling
  -- it a merge.
  if not (public.has_permission(p_organization_id, 'guest.update')
          and public.has_permission(p_organization_id, 'guest.delete')) then
    raise exception
      'GUEST_MERGE_FORBIDDEN: merging requires guest.update and guest.delete together'
      using errcode = '42501';
  end if;

  -- `performed_by` is not null and it comes from the session, never from an
  -- argument. Refused here rather than by the not-null constraint so the
  -- refusal says what is actually wrong.
  if v_actor is null then
    raise exception 'GUEST_MERGE_FORBIDDEN: a merge is performed by a person, not by a job'
      using errcode = '42501';
  end if;

  -- The catalogue, not the memory of whoever wrote this list.
  select pg_catalog.string_agg(t, ', ' order by t) into v_unknown
  from pg_catalog.unnest(public.tables_carrying_guest_id()) as t
  where t <> all (c_tables || c_frozen);

  if v_unknown is not null then
    raise exception
      'GUEST_MERGE_UNKNOWN_TABLE: % carries guest_id and this merge does not know how to move it',
      v_unknown
      using errcode = 'check_violation';
  end if;

  -- ח40-16 · Both rows, ascending by id, so two merges touching the same pair
  -- from opposite directions queue instead of deadlocking. Two statements
  -- rather than one `in (…) order by … for update`, because the planner is
  -- free to lock in scan order and the ordering is the entire point.
  v_first  := least(p_survivor_guest_id, p_merged_guest_id);
  v_second := greatest(p_survivor_guest_id, p_merged_guest_id);
  perform 1 from public.guests where id = v_first  for update;
  perform 1 from public.guests where id = v_second for update;

  select * into v_survivor from public.guests
   where id = p_survivor_guest_id and organization_id = p_organization_id;
  if not found then
    raise exception 'GUEST_MERGE_NOT_FOUND: the surviving guest is not in this organization'
      using errcode = 'no_data_found';
  end if;

  select * into v_merged from public.guests
   where id = p_merged_guest_id and organization_id = p_organization_id;
  if not found then
    raise exception 'GUEST_MERGE_NOT_FOUND: the merged guest is not in this organization'
      using errcode = 'no_data_found';
  end if;

  -- ק40-11 · The second of two concurrent merges finds the work already done
  -- and is told so, rather than merging a deleted row into a live one. It is
  -- also what lets undo restore the merged row without a snapshot: the row was
  -- live and unmerged, or this merge would not have happened.
  if v_survivor.deleted_at is not null or v_survivor.merged_into_guest_id is not null then
    raise exception 'GUEST_MERGE_ALREADY_MERGED: the surviving profile is itself merged or deleted'
      using errcode = 'check_violation';
  end if;
  if v_merged.deleted_at is not null or v_merged.merged_into_guest_id is not null then
    raise exception 'GUEST_MERGE_ALREADY_MERGED: these profiles have already been merged'
      using errcode = 'check_violation';
  end if;

  -- ח40-17 · The screen showed two rows. If either has moved since, every
  -- field choice on that screen was made against something that no longer
  -- exists.
  if p_survivor_version is not null and v_survivor.version <> p_survivor_version then
    raise exception 'GUEST_MERGE_STALE: the surviving profile changed since the screen loaded it'
      using errcode = '40001';
  end if;
  if p_merged_version is not null and v_merged.version <> p_merged_version then
    raise exception 'GUEST_MERGE_STALE: the merged profile changed since the screen loaded it'
      using errcode = '40001';
  end if;

  /* ── the seven a person chooses ──────────────────────────────────────── */

  v_full_name  := v_survivor.full_name;
  v_first_name := v_survivor.first_name;
  v_last_name  := v_survivor.last_name;
  v_email      := v_survivor.email;
  v_phone      := v_survivor.phone;
  v_phone_alt  := v_survivor.phone_alt;
  v_language   := v_survivor.language;

  if coalesce(p_field_choices->>'full_name', 'survivor') = 'merged'
     and v_merged.full_name is distinct from v_survivor.full_name then
    v_full_name := v_merged.full_name;
    v_res := v_res || jsonb_build_object('full_name', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.full_name),
      'overwritten', pg_catalog.to_jsonb(v_survivor.full_name)));
  end if;

  if coalesce(p_field_choices->>'first_name', 'survivor') = 'merged'
     and v_merged.first_name is distinct from v_survivor.first_name then
    v_first_name := v_merged.first_name;
    v_res := v_res || jsonb_build_object('first_name', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.first_name),
      'overwritten', pg_catalog.to_jsonb(v_survivor.first_name)));
  end if;

  if coalesce(p_field_choices->>'last_name', 'survivor') = 'merged'
     and v_merged.last_name is distinct from v_survivor.last_name then
    v_last_name := v_merged.last_name;
    v_res := v_res || jsonb_build_object('last_name', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.last_name),
      'overwritten', pg_catalog.to_jsonb(v_survivor.last_name)));
  end if;

  if coalesce(p_field_choices->>'email', 'survivor') = 'merged'
     and v_merged.email is distinct from v_survivor.email then
    v_email := v_merged.email;
    v_res := v_res || jsonb_build_object('email', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.email::text),
      'overwritten', pg_catalog.to_jsonb(v_survivor.email::text)));
  end if;

  if coalesce(p_field_choices->>'phone', 'survivor') = 'merged'
     and v_merged.phone is distinct from v_survivor.phone then
    v_phone := v_merged.phone;
    v_res := v_res || jsonb_build_object('phone', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.phone),
      'overwritten', pg_catalog.to_jsonb(v_survivor.phone)));
  end if;

  if coalesce(p_field_choices->>'phone_alt', 'survivor') = 'merged'
     and v_merged.phone_alt is distinct from v_survivor.phone_alt then
    v_phone_alt := v_merged.phone_alt;
    v_res := v_res || jsonb_build_object('phone_alt', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.phone_alt),
      'overwritten', pg_catalog.to_jsonb(v_survivor.phone_alt)));
  end if;

  if coalesce(p_field_choices->>'language', 'survivor') = 'merged'
     and v_merged.language is distinct from v_survivor.language then
    v_language := v_merged.language;
    v_res := v_res || jsonb_build_object('language', jsonb_build_object(
      'taken_from', 'merged',
      'kept', pg_catalog.to_jsonb(v_merged.language),
      'overwritten', pg_catalog.to_jsonb(v_survivor.language)));
  end if;

  /* ── the four nobody chooses (ח40-12) ────────────────────────────────── */

  -- Union, sorted.
  --
  -- `order by` is not cosmetic here: `is distinct from` on two arrays compares
  -- element by element, so an unordered aggregate would record a "resolution"
  -- for a set of tags that did not change, and the undo would then dutifully
  -- put back a different ordering of the same labels.
  select coalesce(array_agg(distinct tag order by tag), '{}'::text[])
    into v_tags
  from (
    select pg_catalog.unnest(coalesce(v_survivor.tags, '{}'::text[])) as tag
    union
    select pg_catalog.unnest(coalesce(v_merged.tags, '{}'::text[]))
  ) both_sides;

  if v_tags is distinct from v_survivor.tags then
    v_res := v_res || jsonb_build_object('tags', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'union',
      'kept', pg_catalog.to_jsonb(v_tags),
      'overwritten', pg_catalog.to_jsonb(v_survivor.tags)));
  end if;

  -- Concatenated. A note that says something a business acted on must not
  -- disappear because it happened to be on the row that lost.
  v_notes := v_survivor.notes;
  if length(pg_catalog.btrim(coalesce(v_merged.notes, ''))) > 0 then
    v_notes := pg_catalog.concat_ws(
      E'\n\n',
      nullif(pg_catalog.btrim(coalesce(v_survivor.notes, '')), ''),
      'מפרופיל שמוזג ב-' || pg_catalog.to_char(v_now, 'DD.MM.YYYY') || E':\n'
        || pg_catalog.btrim(v_merged.notes));
    v_res := v_res || jsonb_build_object('notes', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'concatenated',
      'kept', pg_catalog.to_jsonb(v_notes),
      'overwritten', pg_catalog.to_jsonb(v_survivor.notes)));
  end if;

  -- REFUSAL WINS. Two people, one of whom said no, is one person who said no.
  v_consent := v_survivor.marketing_consent and v_merged.marketing_consent;
  if v_consent then
    -- GREATEST ignores nulls unless every argument is null, which is the
    -- behaviour wanted: the later of the two dates, or the only one there is.
    v_consent_at := greatest(v_survivor.marketing_consent_at, v_merged.marketing_consent_at);
  else
    -- A date with no consent behind it is a claim nobody can defend.
    v_consent_at := null;
  end if;

  if v_consent is distinct from v_survivor.marketing_consent
     or v_consent_at is distinct from v_survivor.marketing_consent_at then
    v_res := v_res || jsonb_build_object('marketing_consent', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'refusal_wins',
      'kept', pg_catalog.to_jsonb(v_consent),
      'overwritten', pg_catalog.to_jsonb(v_survivor.marketing_consent)));
    v_res := v_res || jsonb_build_object('marketing_consent_at', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'refusal_wins',
      'kept', pg_catalog.to_jsonb(v_consent_at),
      'overwritten', pg_catalog.to_jsonb(v_survivor.marketing_consent_at)));
  end if;

  -- THE BLOCK WINS, and both reasons are kept: a person blocked for damage
  -- does not become unblocked by being recognised twice.
  v_blocked := v_survivor.is_blocked or v_merged.is_blocked;
  if v_blocked then
    v_block_why := nullif(pg_catalog.concat_ws(
      ' · ',
      nullif(pg_catalog.btrim(coalesce(v_survivor.blocked_reason, '')), ''),
      nullif(pg_catalog.btrim(coalesce(v_merged.blocked_reason, '')), '')
    ), '');
  else
    v_block_why := null;
  end if;

  if v_blocked is distinct from v_survivor.is_blocked
     or v_block_why is distinct from v_survivor.blocked_reason then
    v_res := v_res || jsonb_build_object('is_blocked', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'block_wins',
      'kept', pg_catalog.to_jsonb(v_blocked),
      'overwritten', pg_catalog.to_jsonb(v_survivor.is_blocked)));
    v_res := v_res || jsonb_build_object('blocked_reason', jsonb_build_object(
      'taken_from', 'rule',
      'rule', 'block_wins',
      'kept', pg_catalog.to_jsonb(v_block_why),
      'overwritten', pg_catalog.to_jsonb(v_survivor.blocked_reason)));
  end if;

  /* ── the merged row leaves the unique index FIRST ────────────────────── */
  --
  -- Order is load-bearing, not tidiness. `guests_organization_phone_idx` is
  -- unique over (organization_id, phone_e164) where the row is live, and it is
  -- checked per statement. If the survivor took the merged guest's telephone
  -- number while both rows were live, the index would refuse it. Soft-deleting
  -- the merged row first makes room; undo does exactly this in reverse.

  update public.guests
     set deleted_at = v_now,
         deleted_by = v_actor,
         merged_into_guest_id = p_survivor_guest_id
   where id = p_merged_guest_id
  returning version into v_version;

  v_moved := v_moved || jsonb_build_object('guests', jsonb_build_array(
    jsonb_build_object('id', p_merged_guest_id, 'role', 'merged',
                       'from', null, 'version', v_version)));

  update public.guests
     set full_name            = v_full_name,
         first_name           = v_first_name,
         last_name            = v_last_name,
         email                = v_email,
         phone                = v_phone,
         phone_alt            = v_phone_alt,
         language             = v_language,
         tags                 = v_tags,
         notes                = v_notes,
         marketing_consent    = v_consent,
         marketing_consent_at = v_consent_at,
         is_blocked           = v_blocked,
         blocked_reason       = v_block_why,
         updated_by           = v_actor
   where id = p_survivor_guest_id
  returning version into v_version;

  v_moved := jsonb_set(v_moved, '{guests}',
    (v_moved->'guests') || jsonb_build_array(
      jsonb_build_object('id', p_survivor_guest_id, 'role', 'survivor',
                         'from', null, 'version', v_version)));

  -- ק40-10 · A→B then B→C. Everything that pointed at the merged guest now
  -- points at the survivor, so an old id resolves in one hop however long the
  -- chain gets.
  --
  -- One statement with a data-modifying CTE, rather than a FOR loop over the
  -- UPDATE: a FOR loop over a query opens a cursor, and a cursor may not carry
  -- a data-modifying CTE.
  with repointed as (
    update public.guests
       set merged_into_guest_id = p_survivor_guest_id
     where organization_id = p_organization_id
       and merged_into_guest_id = p_merged_guest_id
       and id <> p_merged_guest_id
    returning id, version)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'role', 'chain',
           'from', p_merged_guest_id, 'version', r.version)), '[]'::jsonb)
    into v_rows
  from repointed r;

  v_moved := jsonb_set(v_moved, '{guests}', (v_moved->'guests') || v_rows);

  /* ── every table that carries a guest_id ─────────────────────────────── */

  foreach v_table in array c_tables loop
    execute pg_catalog.format(
      'with moved as (
         update public.%I t
            set guest_id = $1
          where t.guest_id = $2 and t.organization_id = $3
         returning t.id, t.version)
       select coalesce(
         jsonb_agg(jsonb_build_object(
           ''id'', mv.id, ''from'', $2, ''version'', mv.version)),
         ''[]''::jsonb)
       from moved mv', v_table)
    into v_rows
    using p_survivor_guest_id, p_merged_guest_id, p_organization_id;

    v_moved := v_moved || jsonb_build_object(v_table, v_rows);
  end loop;

  insert into public.guest_merges (
    organization_id, survivor_guest_id, merged_guest_id,
    field_resolutions, moved, reason,
    performed_by, performed_at, undo_deadline)
  values (
    p_organization_id, p_survivor_guest_id, p_merged_guest_id,
    v_res, v_moved, pg_catalog.btrim(p_reason),
    v_actor, v_now, v_now + interval '30 days')
  returning id into v_merge_id;

  return v_merge_id;
end $$;

comment on function public.guest_merge_apply(uuid, uuid, uuid, integer, integer, jsonb, text) is
  'Joins two guest rows into one and records exactly what it did. SECURITY DEFINER because the person merging holds guest.update and guest.delete and need not hold booking.update or review.manage, and the alternative — a service-role client in the request path — puts a credential that bypasses every policy into a screen. Membership and BOTH permissions are therefore checked explicitly inside. Nothing is deleted: the merged row is soft-deleted, points at the survivor, and keeps every column this function refused to copy — no document number, no date of birth, no address.';

revoke all on function public.guest_merge_apply(uuid, uuid, uuid, integer, integer, jsonb, text)
  from public, anon;
grant execute on function public.guest_merge_apply(uuid, uuid, uuid, integer, integer, jsonb, text)
  to authenticated, service_role;


-- ============================================================================
-- 7 · guest_merge_undo
-- ============================================================================
-- ח40-14 and ח40-15. Puts back exactly what `moved` and `field_resolutions`
-- recorded, and refuses — naming what changed — rather than overwriting work
-- somebody has done since. An undo that silently discards two weeks of edits
-- is worse than no undo at all.

create or replace function public.guest_merge_undo(
  p_merge_id uuid,
  p_reason   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g           public.guest_merges%rowtype;
  v_survivor  public.guests%rowtype;
  v_first     uuid;
  v_second    uuid;
  v_table     text;
  v_entry     jsonb;
  v_changed   text[] := '{}'::text[];
  v_actor     uuid := (select auth.uid());
  v_res       jsonb;
  v_current   integer;
begin
  if p_merge_id is null then
    raise exception 'GUEST_MERGE_UNDO_INCOMPLETE: a merge is required'
      using errcode = 'check_violation';
  end if;

  if length(pg_catalog.btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'GUEST_MERGE_UNDO_NEEDS_A_REASON: an undo is explained or it does not happen'
      using errcode = 'check_violation';
  end if;

  select * into g from public.guest_merges where id = p_merge_id for update;
  if not found then
    raise exception 'GUEST_MERGE_UNDO_NOT_FOUND: no such merge'
      using errcode = 'no_data_found';
  end if;

  if g.organization_id not in (select public.my_organizations()) then
    raise exception 'GUEST_MERGE_UNDO_FORBIDDEN: not a member of this organization'
      using errcode = '42501';
  end if;

  if not (public.has_permission(g.organization_id, 'guest.update')
          and public.has_permission(g.organization_id, 'guest.delete')) then
    raise exception
      'GUEST_MERGE_UNDO_FORBIDDEN: undoing a merge requires guest.update and guest.delete together'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'GUEST_MERGE_UNDO_FORBIDDEN: an undo is performed by a person, not by a job'
      using errcode = '42501';
  end if;

  if g.undone_at is not null then
    raise exception 'GUEST_MERGE_UNDO_ALREADY_DONE: this merge was already undone'
      using errcode = 'check_violation';
  end if;

  -- ק40-08 · The window is a promise about how far back the product can see,
  -- not a preference. Past it, a person has to look at what actually happened.
  if pg_catalog.now() > g.undo_deadline then
    raise exception
      'GUEST_MERGE_UNDO_EXPIRED: the 30 day window closed on %', g.undo_deadline
      using errcode = 'check_violation';
  end if;

  v_first  := least(g.survivor_guest_id, g.merged_guest_id);
  v_second := greatest(g.survivor_guest_id, g.merged_guest_id);
  perform 1 from public.guests where id = v_first  for update;
  perform 1 from public.guests where id = v_second for update;

  select * into v_survivor from public.guests where id = g.survivor_guest_id;
  if not found then
    raise exception 'GUEST_MERGE_UNDO_NOT_FOUND: the surviving profile is gone'
      using errcode = 'no_data_found';
  end if;

  -- A survivor that has itself since been merged cannot be unwound from
  -- underneath: undoing this one would leave the restored guest pointing at a
  -- profile that no longer exists on its own. The later merge is undone first.
  if v_survivor.merged_into_guest_id is not null then
    raise exception
      'GUEST_MERGE_UNDO_CHAINED: the surviving profile has since been merged into %; undo that first',
      v_survivor.merged_into_guest_id
      using errcode = 'check_violation';
  end if;

  /* ── nothing may have moved since (ח40-15) ───────────────────────────── */

  for v_table in select jsonb_object_keys(g.moved) loop
    for v_entry in select jsonb_array_elements(g.moved->v_table) loop
      execute pg_catalog.format(
        'select version from public.%I where id = $1', v_table)
      into v_current
      using (v_entry->>'id')::uuid;

      if v_current is null then
        v_changed := v_changed || (v_table || ' ' || (v_entry->>'id') || ' (gone)');
      elsif v_current <> (v_entry->>'version')::integer then
        v_changed := v_changed || (v_table || ' ' || (v_entry->>'id'));
      end if;
    end loop;
  end loop;

  if pg_catalog.array_length(v_changed, 1) is not null then
    raise exception
      'GUEST_MERGE_UNDO_ROWS_CHANGED: these have been edited since the merge and must be handled by hand: %',
      pg_catalog.array_to_string(v_changed, ', ')
      using errcode = 'check_violation';
  end if;

  /* ── the survivor's overwritten values, then the merged row ──────────── */
  --
  -- Same ordering argument as the merge, in reverse. The survivor gives back
  -- the telephone number BEFORE the merged row comes back to life, or
  -- `guests_organization_phone_idx` refuses the un-delete.

  v_res := g.field_resolutions;

  update public.guests set
    full_name = case when v_res ? 'full_name'
                     then v_res->'full_name'->>'overwritten' else full_name end,
    first_name = case when v_res ? 'first_name'
                      then v_res->'first_name'->>'overwritten' else first_name end,
    last_name = case when v_res ? 'last_name'
                     then v_res->'last_name'->>'overwritten' else last_name end,
    email = case when v_res ? 'email'
                 then (v_res->'email'->>'overwritten')::extensions.citext else email end,
    phone = case when v_res ? 'phone'
                 then v_res->'phone'->>'overwritten' else phone end,
    phone_alt = case when v_res ? 'phone_alt'
                     then v_res->'phone_alt'->>'overwritten' else phone_alt end,
    language = case when v_res ? 'language'
                    then v_res->'language'->>'overwritten' else language end,
    tags = case when jsonb_typeof(v_res->'tags'->'overwritten') = 'array'
                then coalesce(
                  (select pg_catalog.array_agg(t)
                     from jsonb_array_elements_text(v_res->'tags'->'overwritten') as t),
                  '{}'::text[])
                else tags end,
    notes = case when v_res ? 'notes'
                 then v_res->'notes'->>'overwritten' else notes end,
    marketing_consent = case when v_res ? 'marketing_consent'
                             then (v_res->'marketing_consent'->>'overwritten')::boolean
                             else marketing_consent end,
    marketing_consent_at = case when v_res ? 'marketing_consent_at'
                                then (v_res->'marketing_consent_at'->>'overwritten')::timestamptz
                                else marketing_consent_at end,
    is_blocked = case when v_res ? 'is_blocked'
                      then (v_res->'is_blocked'->>'overwritten')::boolean
                      else is_blocked end,
    blocked_reason = case when v_res ? 'blocked_reason'
                          then v_res->'blocked_reason'->>'overwritten'
                          else blocked_reason end,
    updated_by = v_actor
  where id = g.survivor_guest_id;

  -- The merged row was live and unmerged before the merge — `guest_merge_apply`
  -- refuses to merge a row that is not — so this restores it rather than
  -- guessing at it.
  update public.guests
     set deleted_at = null,
         deleted_by = null,
         merged_into_guest_id = null,
         updated_by = v_actor
   where id = g.merged_guest_id;

  -- The chain, back where it pointed.
  for v_entry in
    select jsonb_array_elements(coalesce(g.moved->'guests', '[]'::jsonb))
  loop
    if v_entry->>'role' = 'chain' then
      update public.guests
         set merged_into_guest_id = (v_entry->>'from')::uuid,
             updated_by = v_actor
       where id = (v_entry->>'id')::uuid;
    end if;
  end loop;

  /* ── every row that moved, back to the guest it named ────────────────── */

  for v_table in select jsonb_object_keys(g.moved) loop
    continue when v_table = 'guests';

    execute pg_catalog.format(
      'update public.%I t
          set guest_id = e.from_guest
         from (select (x->>''id'')::uuid as id, (x->>''from'')::uuid as from_guest
                 from jsonb_array_elements($1) as x) e
        where t.id = e.id and t.organization_id = $2', v_table)
    using g.moved->v_table, g.organization_id;
  end loop;

  update public.guest_merges
     set undone_at = pg_catalog.now(),
         undone_by = v_actor,
         undo_reason = pg_catalog.btrim(p_reason)
   where id = p_merge_id;
end $$;

comment on function public.guest_merge_undo(uuid, text) is
  'Puts back exactly the row ids in guest_merges.moved and the values in field_resolutions, or refuses. It refuses when the 30 day window has closed, when the merge was already undone, when the survivor has itself since been merged, and — the one that matters — when any row it would rewrite has changed since the merge, naming every one of them. An undo that silently discards work done since is worse than no undo.';

revoke all on function public.guest_merge_undo(uuid, text) from public, anon;
grant execute on function public.guest_merge_undo(uuid, text) to authenticated, service_role;


-- ============================================================================
-- 8 · Row level security
-- ============================================================================
-- Both floors, on both tables. `can(actor, grant, resource)` runs in the
-- service layer; this is the one underneath it, and neither is a substitute
-- for the other.

alter table public.leads enable row level security;
alter table public.leads force  row level security;

revoke all on public.leads from anon, authenticated;
grant select, insert, update on public.leads to authenticated, service_role;

-- No DELETE. A lead is soft-deleted, because "who enquired and never got an
-- answer" is the measurement this table exists for and a row that can be
-- removed is a measurement that can be improved by removing rows. There is
-- therefore no delete policy either: a policy governing a privilege nobody
-- holds reads as though the privilege exists.
revoke delete, truncate on public.leads from authenticated, service_role;

-- `property_id is null or in scope`, in all three. A lead that names no
-- property is the ordinary case — somebody rang about August — and dropping
-- the null branch would hide most of the table from everybody, which is the
-- opposite of what a pipeline screen is for.

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'lead.view')
  );

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'lead.create')
  );

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'lead.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'lead.update')
  );


alter table public.guest_merges enable row level security;
alter table public.guest_merges force  row level security;

revoke all on public.guest_merges from anon, authenticated;

-- 🔒 SELECT and nothing else, to anybody. `guest_merge_apply` and
-- `guest_merge_undo` are SECURITY DEFINER and own every write to this table.
-- The consequence is the point: a person holding every grant in the catalogue
-- still cannot write a merge record that did not happen, cannot change one
-- that did, and cannot remove one. The row that says who decided is the only
-- thing standing between "the histories of two people were joined" and "the
-- histories of two people were joined by nobody".
grant select on public.guest_merges to authenticated, service_role;
revoke insert, update, delete, truncate on public.guest_merges
  from authenticated, service_role;

drop policy if exists guest_merges_select on public.guest_merges;
create policy guest_merges_select on public.guest_merges
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest.view')
  );


-- ============================================================================
-- 9 · Rehearsal
-- ============================================================================
-- Exercised, not asserted. Every check below RUNS the thing it is checking.
--
-- The behavioural half runs against TEMPORARY tables created with
-- `like public.<table> including all`, which the server fills in from its own
-- catalogue — so the CHECK constraints, defaults and generated columns being
-- exercised are the real ones rather than a copy typed out here. The real
-- trigger function is attached. What LIKE does not copy is foreign keys and
-- row level security, which is why this needs no seeded organization and why
-- those two are checked structurally instead.

do $$
declare
  v_org       constant uuid := '00000000-0000-4000-8000-000000000000';
  v_status    text;
  v_phone     text;
  v_email     text;
  v_stamp     timestamptz;
  v_first     timestamptz;
  v_version   integer;
  v_offending text;
  v_cfg       text;
  v_tables    text[];
  v_name      text;
begin
  /* ── leads · the constraints, run against real inserts ───────────────── */

  execute 'drop table if exists pg_temp.leads_rehearsal';
  execute 'create temp table leads_rehearsal (like public.leads including all)';
  execute 'create trigger rehearsal_is_governed
             before insert or update on pg_temp.leads_rehearsal
             for each row execute function public.tg_lead_is_governed()';

  -- ח40-20 · no telephone and no email is not a lead.
  begin
    execute 'insert into pg_temp.leads_rehearsal (organization_id, source)
             values ($1, $2)'
      using v_org, 'website'::public.lead_source;
    raise exception 'a lead was recorded with no way to answer it';
  exception when check_violation then null; end;

  -- And a telephone box holding punctuation is the same thing, because the
  -- constraint is written against the generated column.
  begin
    execute 'insert into pg_temp.leads_rehearsal
               (organization_id, source, raw_phone) values ($1, $2, $3)'
      using v_org, 'phone'::public.lead_source, ' -- ';
    raise exception 'a lead was recorded with a telephone number that is not one';
  exception when check_violation then null; end;

  -- ח40-02 · the normalisation is the database's, and it is the same one
  -- guests.phone_e164 uses. Proven by writing what a person types.
  execute 'insert into pg_temp.leads_rehearsal
             (organization_id, source, raw_name, raw_phone, raw_email)
           values ($1, $2, $3, $4, $5)'
    using v_org, 'whatsapp'::public.lead_source, 'דוד כהן',
          '050-123-4567', '  Dana@Example.COM ';

  execute 'select phone_e164, email_normalized, status::text, status_changed_at
             from pg_temp.leads_rehearsal'
    into v_phone, v_email, v_status, v_stamp;

  if v_phone <> '+972501234567' then
    raise exception 'a typed telephone number did not become the deduplication key: %', v_phone;
  end if;
  if v_email <> 'dana@example.com' then
    raise exception 'the candidate email key is not comparable: %', v_email;
  end if;
  if v_status <> 'new' or v_stamp is null then
    raise exception 'a new lead did not start at new with a stamp';
  end if;

  -- A lead cannot be born anywhere but `new`.
  begin
    execute 'insert into pg_temp.leads_rehearsal
               (organization_id, source, raw_phone, status)
             values ($1, $2, $3, $4)'
      using v_org, 'website'::public.lead_source, '0521111111',
            'booked'::public.lead_status;
    raise exception 'a lead arrived already booked, which is a conversion nobody worked';
  exception when check_violation then null; end;

  -- ח40-22 · first_response_at is written once and then restored.
  execute 'update pg_temp.leads_rehearsal
             set status = $1, first_response_at = $2'
    using 'contacted'::public.lead_status, pg_catalog.now();
  execute 'select first_response_at, version from pg_temp.leads_rehearsal'
    into v_first, v_version;
  if v_first is null then
    raise exception 'answering a lead recorded no response time';
  end if;
  if v_version <> 2 then
    raise exception 'the version did not move, so optimistic locking is blind here';
  end if;

  execute 'update pg_temp.leads_rehearsal set first_response_at = $1'
    using pg_catalog.now() + interval '1 hour';
  execute 'select first_response_at from pg_temp.leads_rehearsal' into v_stamp;
  if v_stamp is distinct from v_first then
    raise exception 'the first response time could be rewritten, so the median lies';
  end if;

  -- §4.1 · an illegal transition is refused.
  begin
    execute 'update pg_temp.leads_rehearsal set status = $1'
      using 'booked'::public.lead_status;
    raise exception 'a lead jumped from contacted straight to booked';
  exception when check_violation then null; end;

  -- ח40-21 · lost needs a reason, and `other` needs a note.
  begin
    execute 'update pg_temp.leads_rehearsal set status = $1'
      using 'lost'::public.lead_status;
    raise exception 'a lead was closed with no reason, so the breakdown means nothing';
  exception when check_violation then null; end;

  begin
    execute 'update pg_temp.leads_rehearsal set status = $1, lost_reason = $2'
      using 'lost'::public.lead_status, 'other'::public.lead_lost_reason;
    raise exception 'a lead was closed as "other" with nothing written down';
  exception when check_violation then null; end;

  execute 'update pg_temp.leads_rehearsal set status = $1, lost_reason = $2'
    using 'lost'::public.lead_status, 'dates_unavailable'::public.lead_lost_reason;

  -- ק40-14 · reopening clears the reason, so a lost-reason breakdown never
  -- counts a lead that is being worked again.
  execute 'update pg_temp.leads_rehearsal set status = $1'
    using 'contacted'::public.lead_status;
  execute 'select lost_reason::text from pg_temp.leads_rehearsal' into v_status;
  if v_status is not null then
    raise exception 'a reopened lead kept its closing reason';
  end if;

  -- "A lead that became a booking stops being a lead", with nothing to point
  -- at. The move to `interested` is deliberately OUTSIDE the block below: a
  -- caught exception rolls the whole block back, so putting it inside would
  -- leave the row on `contacted` and the next statement would be testing a
  -- transition nobody meant to test.
  execute 'update pg_temp.leads_rehearsal set status = $1'
    using 'interested'::public.lead_status;

  begin
    execute 'update pg_temp.leads_rehearsal set status = $1'
      using 'booked'::public.lead_status;
    raise exception 'a lead was booked without naming the stay it became';
  exception when check_violation then null; end;

  -- And once booked it is final.
  execute 'update pg_temp.leads_rehearsal set status = $1, booking_id = $2'
    using 'booked'::public.lead_status, v_org;
  begin
    execute 'update pg_temp.leads_rehearsal set status = $1'
      using 'lost'::public.lead_status;
    raise exception 'a booked lead was reopened, so it is in the funnel twice';
  exception when check_violation then null; end;

  -- Dates and party size.
  begin
    execute 'insert into pg_temp.leads_rehearsal
               (organization_id, source, raw_phone,
                requested_check_in, requested_check_out)
             values ($1, $2, $3, $4, $5)'
      using v_org, 'website'::public.lead_source, '0523333333',
            '2026-05-10'::date, '2026-05-10'::date;
    raise exception 'an enquiry asked for a stay of no nights';
  exception when check_violation then null; end;

  begin
    execute 'insert into pg_temp.leads_rehearsal
               (organization_id, source, raw_phone, party_adults)
             values ($1, $2, $3, 0)'
      using v_org, 'website'::public.lead_source, '0524444444';
    raise exception 'an enquiry was recorded for nobody';
  exception when check_violation then null; end;

  execute 'drop table pg_temp.leads_rehearsal';

  /* ── guest_merges · the constraints, run ─────────────────────────────── */

  execute 'drop table if exists pg_temp.guest_merges_rehearsal';
  execute 'create temp table guest_merges_rehearsal
             (like public.guest_merges including all)';

  -- ק40-09
  begin
    execute 'insert into pg_temp.guest_merges_rehearsal
               (organization_id, survivor_guest_id, merged_guest_id, reason,
                performed_by, undo_deadline)
             values ($1, $2, $2, $3, $2, pg_catalog.now() + interval ''30 days'')'
      using v_org, v_org, 'the same person twice';
    raise exception 'a guest was merged into itself';
  exception when check_violation then null; end;

  -- §8 · a reason is a sentence, not a keystroke.
  begin
    execute 'insert into pg_temp.guest_merges_rehearsal
               (organization_id, survivor_guest_id, merged_guest_id, reason,
                performed_by, undo_deadline)
             values ($1, $2, $3, ''ok'', $2,
                     pg_catalog.now() + interval ''30 days'')'
      using v_org, v_org, '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a merge was recorded with no explanation anybody can read';
  exception when check_violation then null; end;

  -- An undo with no author is not an undo.
  execute 'insert into pg_temp.guest_merges_rehearsal
             (organization_id, survivor_guest_id, merged_guest_id, reason,
              performed_by, undo_deadline)
           values ($1, $2, $3, $4, $2, pg_catalog.now() + interval ''30 days'')'
    using v_org, v_org, '00000000-0000-4000-8000-000000000001'::uuid,
          'same telephone number, entered twice at the desk';

  begin
    execute 'update pg_temp.guest_merges_rehearsal set undone_at = pg_catalog.now()';
    raise exception 'a merge was undone by nobody, for no reason';
  exception when check_violation then null; end;

  begin
    execute 'update pg_temp.guest_merges_rehearsal
               set undone_at = pg_catalog.now(), undone_by = $1, undo_reason = ''no'''
      using v_org;
    raise exception 'a merge was undone with no explanation anybody can read';
  exception when check_violation then null; end;

  -- The window is not optional.
  begin
    execute 'update pg_temp.guest_merges_rehearsal
               set undo_deadline = performed_at - interval ''1 day''';
    raise exception 'a merge was recorded with an undo window that had already closed';
  exception when check_violation then null; end;

  execute 'drop table pg_temp.guest_merges_rehearsal';

  /* ── the guard that keeps the merge honest ───────────────────────────── */

  v_tables := public.tables_carrying_guest_id();

  -- Six today. Not asserted as a number — asserted as the six, so that a table
  -- added and a table removed cannot cancel out.
  foreach v_name in array array['bookings', 'conversations', 'guest_messages',
                                'guest_reviews', 'leads', 'store_orders'] loop
    if v_name <> all (v_tables) then
      raise exception
        'the guard cannot see public.%, which carries guest_id', v_name;
    end if;
  end loop;

  -- Moved, plus knowingly frozen. A table appearing outside BOTH lists is the
  -- finding this block exists for: it means somebody added a `guest_id`
  -- without deciding what a merge does with it, and the merge would refuse at
  -- run time for a reason nobody would connect to their migration.
  --
  -- `discount_redemptions` is here rather than in the moved list because 0073
  -- makes it append-only; see `c_frozen` on `guest_merge_apply` for why that
  -- decides it.
  select pg_catalog.string_agg(t, ', ') into v_offending
  from pg_catalog.unnest(v_tables) as t
  where t <> all (array['bookings', 'conversations', 'guest_messages',
                        'guest_reviews', 'leads', 'store_orders',
                        'discount_redemptions']);
  if v_offending is not null then
    raise exception
      'these carry guest_id and the merge neither moves nor knowingly freezes them: %',
      v_offending;
  end if;

  /* ── the definer functions, exercised ────────────────────────────────── */

  for v_cfg in
    select pg_catalog.array_to_string(p.proconfig, ',')
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('guest_merge_apply', 'guest_merge_undo',
                        'tables_carrying_guest_id', 'tg_lead_is_governed')
  loop
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception 'a leads or merge function has a mutable search_path';
    end if;
  end loop;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('guest_merge_apply', 'guest_merge_undo')
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon may merge two people''s histories together';
  end if;

  -- The membership guard, RUN. As the migration role there is no auth.uid(),
  -- so my_organizations() is empty and every id is foreign — which is exactly
  -- the case that must be refused. If this ever stops raising, the function
  -- has stopped checking membership, and SECURITY DEFINER has left nothing
  -- else checking it.
  begin
    perform public.guest_merge_apply(
      v_org,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      null, null, '{}'::jsonb,
      'a reason long enough to be a sentence');
    raise exception 'the merge accepted an organization the caller is not in';
  exception when insufficient_privilege then null; end;

  -- And the refusals that come before membership, so that a caller cannot use
  -- the error to learn whether an organization exists.
  begin
    perform public.guest_merge_apply(
      v_org, v_org, v_org, null, null, '{}'::jsonb,
      'a reason long enough to be a sentence');
    raise exception 'a guest could be merged into itself through the door';
  exception when check_violation then null; end;

  begin
    perform public.guest_merge_apply(
      v_org,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      null, null, '{}'::jsonb, 'too short');
    raise exception 'a merge was accepted with no explanation';
  exception when check_violation then null; end;

  begin
    perform public.guest_merge_undo(
      '00000000-0000-4000-8000-000000000009'::uuid, 'x');
    raise exception 'an undo was accepted with no explanation';
  exception when check_violation then null; end;

  /* ── what LIKE does not copy: privileges and row level security ──────── */

  foreach v_name in array array['leads', 'guest_merges'] loop
    if not exists (
      select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception '% is not forced', v_name;
    end if;

    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = v_name
        and privilege_type in ('DELETE', 'TRUNCATE')
        and grantee in ('authenticated', 'service_role', 'anon', 'PUBLIC')
    ) then
      raise exception 'rows can be deleted from %, so the record is erasable', v_name;
    end if;

    select pg_catalog.string_agg(distinct grantee::text, ', ') into v_offending
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = v_name
      and grantee in ('anon', 'PUBLIC');
    if v_offending is not null then
      raise exception '% is reachable by: %', v_name, v_offending;
    end if;

    -- Every policy asks both questions. A policy that named the tenant and
    -- forgot the permission would let anybody in the organization read the
    -- customer list, which is the difference between a permission model and a
    -- shared account.
    select pg_catalog.string_agg(p.polname, ', ') into v_offending
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    where c.relname = v_name
      and (
        coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      ) not like '%my_organizations%';
    if v_offending is not null then
      raise exception 'policies on % without a tenant boundary: %', v_name, v_offending;
    end if;

    select pg_catalog.string_agg(p.polname, ', ') into v_offending
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    where c.relname = v_name
      and (
        coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
      ) not like '%has_permission%';
    if v_offending is not null then
      raise exception 'policies on % that ask for no permission: %', v_name, v_offending;
    end if;
  end loop;

  -- Nobody but the two definer functions may write a merge record. Filtered by
  -- grantee, because the table owner's own privileges appear in this view and
  -- the owner is who the definer functions run as.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'guest_merges'
      and privilege_type in ('INSERT', 'UPDATE')
      and grantee in ('authenticated', 'service_role', 'anon', 'PUBLIC')
  ) then
    raise exception
      'a merge record can be written outside guest_merge_apply, so it proves nothing';
  end if;

  if exists (select 1 from public.leads)
     or exists (select 1 from public.guest_merges) then
    raise exception 'the rehearsal left a row behind';
  end if;
end $$;
