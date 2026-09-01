-- ============================================================================
-- 0034_guest_journey.sql — ESTIA · what happens after the link is opened
--
-- What this is for
--   0033 built the door: a capability URL, one SECURITY DEFINER projection, and
--   a guest who reaches exactly one booking without an account. It stopped
--   there deliberately — it could say *who* the visitor is and nothing about
--   what they are supposed to *do*. This is the journey behind that door:
--   confirm, sign, complete details, learn where the house is, ask for towels,
--   say you have left.
--
-- ── The one rule this file is organised around ─────────────────────────────
--
--   **A guest has no account, therefore a guest never gets a policy.**
--
--   0033 said it once and it holds for every table below. Every policy in this
--   schema is `organization_id in (select public.my_organizations())`, and
--   `my_organizations()` reads memberships. A guest has none. So there is not
--   one `to anon` policy in this migration, and there must never be: a policy
--   admitting `anon` to `guest_requests` admits `anon` to every organization's
--   guest requests, and the WHERE clause that was supposed to narrow it is a
--   thing the *client* sends.
--
--   Everything a guest writes therefore goes through a SECURITY DEFINER
--   function that takes the token as its first argument, and **every one of
--   them re-resolves the token itself** through `public.guest_link_booking`.
--   Not one of them accepts a booking id. That is the whole design: there is
--   no argument a guest could tamper with that names somebody else's booking,
--   because there is no argument that names a booking at all.
--
--   `guest_link_booking` is the single implementation of "is this token good
--   right now" — the same four refusals as 0033, in the same order — and it is
--   revoked from `anon`, `authenticated`, `public` and `service_role`. It
--   returns a whole `bookings` row and must never be reachable from outside.
--   Only the definer functions below call it, and they run as their owner.
--
-- ── What is gated in SQL, and what is left to the application ──────────────
--
--   Secrets are gated here. The access code, the address, the directions and
--   the wifi password are decided by `arrival_release`, and the function
--   returns SQL NULL for every one of them until the policy allows it. Not
--   "returns them with a flag beside them" — a flag is a thing a template
--   forgets, and the first time it is forgotten somebody's door code is on a
--   page a forwarded link opens a month before arrival. The value is not in
--   the payload at all.
--
--   Presentation is not gated here. Which step is dominant, how a price change
--   is worded, whether four nights reads as "4 לילות" — that is
--   `src/lib/guest-journey`, where it can be unit-tested against a table of
--   cases instead of against a live database.
--
--   The dividing line, stated once: **if disclosing it early would harm
--   somebody, it is decided in this file.**
--
-- ── Idempotency, and why almost none of it is a client-supplied key ────────
--
--   A guest on a telephone with one bar of signal taps confirm twice. Every
--   guest-facing write below is idempotent on something the *domain* already
--   makes unique, rather than on a key the client invents:
--
--     confirmation   unique (booking_id, booking_version) — confirming
--                    version 4 twice is one confirmation of version 4, and the
--                    second tap returns the first one's row.
--     signature      unique (booking_id) where superseded_at is null — there is
--                    one live signature per booking by construction.
--     details        primary key (booking_id) — an upsert.
--     checkout       `coalesce(declared_at, now())` — the second tap is a no-op.
--     request        unique (booking_id, client_key) — the ONE place a key is
--                    supplied, because two genuine requests for towels an hour
--                    apart are two requests and no column can tell them apart.
--                    The key is minted when the compose form opens, not when it
--                    is submitted, so a double-tap shares one and a second
--                    request does not.
--
--   The stale-version refusal is the other half. `guest_portal_confirm` takes
--   the version the guest was *looking at*; if the booking has moved since, it
--   raises `guest_confirmation_stale` rather than recording approval of terms
--   nobody showed them. That is the reconfirmation law in one line of plpgsql.
--
-- ── Two things this deliberately does not do ───────────────────────────────
--
--   **It does not read payments.** `after_deposit` and `after_full_payment`
--   are real release policies and the resolver behind them belongs to the
--   payment-collection module, which is being written in parallel and whose
--   tables are not in this database. So the gate reads two timestamps on
--   `booking_guest_journey` — `deposit_settled_at`, `payment_settled_at` —
--   which that module stamps. Until it does they are null and the gate stays
--   *shut*, which is the correct direction to fail: an address not shown is a
--   telephone call, and an address shown early is a stranger at the door.
--   `manual_released_at` is always available as the operator's override, so no
--   business is ever stuck behind an unwritten module.
--
--   **It does not create a task table.** A guest request becomes a row in
--   `public.tasks` — the canonical engine from 0011 — and `guest_requests`
--   holds only what a guest is allowed to see about it. Staff names,
--   assignment, internal notes and the completion note stay on the task and
--   are never projected back.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission, property_in_scope), 0008 (properties: house_rules,
--   cancellation_policy_text, default_check_in_time, default_check_out_time,
--   timezone), 0009 (bookings, booking_status), 0011 (tasks, task_type's
--   `guest_request` member, task_status), 0014 (a function in `public` is an
--   API surface until its grants say otherwise), 0033 (guest_token as a live
--   capability, and the four refusals this file repeats).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies
-- ============================================================================
-- These are the guest journey's own, not shared contracts. They are not in
-- `src/lib/contracts` for the reason that file gives for what belongs there: a
-- vocabulary lives in the frozen contracts when two modules would otherwise
-- each define it and drift. Nothing outside the guest journey has an opinion
-- about what "release the address after the deposit" means.

-- GUEST_CONTRACT_MODES, in order.
--
-- `disabled` is first and is the default, because it is the honest default:
-- most Israeli guesthouses do not put a contract in front of a guest, and a
-- product that shipped `optional` would show every one of them a step they
-- never asked for. When this is `disabled` there is no contract row, no
-- contract screen and no contract line in the progress list — see §7 and §10.
do $$ begin
  create type public.guest_contract_mode as enum (
    'disabled',
    'optional',
    'mandatory'
  );
exception when duplicate_object then null;
end $$;

-- GUEST_ARRIVAL_RELEASE, in order of how much has to have happened first.
--
-- `immediate` exists and is not a hole: a business with nothing to withhold —
-- a published address, a key in a lockbox, a code that is the same every week
-- — must be able to say so, and forcing it to pick a condition it does not
-- have would mean the address never appears at all.
do $$ begin
  create type public.guest_arrival_release as enum (
    'immediate',
    'after_confirmation',
    'after_contract',
    'after_deposit',
    'after_full_payment',
    'hours_before',
    'manual'
  );
exception when duplicate_object then null;
end $$;

-- GUEST_REQUEST_CATEGORIES, in order.
do $$ begin
  create type public.guest_request_category as enum (
    'towels',
    'linen',
    'cleaning',
    'maintenance',
    'equipment',
    'other'
  );
exception when duplicate_object then null;
end $$;

-- GUEST_REQUEST_STATES, in order.
--
-- Three states and a cancellation, and that is the entire vocabulary a guest is
-- shown. `public.task_status` has nine, and the difference between `assigned`
-- and `accepted` is a fact about the business's staffing that a guest asking
-- for towels is not owed and could not act on. §11 maps the nine onto these
-- four in one place, so the mapping cannot drift between two screens.
do $$ begin
  create type public.guest_request_state as enum (
    'received',
    'in_progress',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

-- GUEST_LINK_CHANNELS, in order.
--
-- `copy` is a first-class member rather than a fallback. A business with no
-- WhatsApp integration configured is not a business that cannot send a link;
-- it is a business whose owner pastes it into WhatsApp themselves, and
-- recording that as a real send is what makes "sent and never opened" true for
-- them too.
do $$ begin
  create type public.guest_link_channel as enum (
    'whatsapp',
    'sms',
    'email',
    'copy'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 2 · What the business requires of a guest
-- ============================================================================
-- One row per organization, and optionally one per property. The property row
-- wins where it exists; §7 resolves the pair so that no screen has to.
--
-- Two partial unique indexes rather than `unique nulls not distinct`: the
-- latter needs the reader to already know that a null property_id is a real key
-- value here, and the pair below says it out loud.

create table if not exists public.guest_journey_settings (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null
    references public.organizations (id) on delete cascade,
  -- Null is the organization-wide default, not a missing value.
  property_id                 uuid,

  -- ── The steps ───────────────────────────────────────────────────────────
  contract_mode               public.guest_contract_mode not null
                                default 'disabled',
  require_guest_confirmation  boolean not null default true,

  -- Which details are collected, as a list of field names the application
  -- knows. Empty means the details step does not exist — §7 will not emit a
  -- step with nothing in it.
  required_detail_fields      text[] not null default '{}',
  optional_detail_fields      text[] not null default '{}',

  -- ── Arrival ─────────────────────────────────────────────────────────────
  arrival_release             public.guest_arrival_release not null
                                default 'after_confirmation',
  -- Only read when arrival_release is 'hours_before'.
  arrival_release_hours       integer not null default 24,

  -- ── During the stay ─────────────────────────────────────────────────────
  during_stay_topics          text[] not null
                                default '{wifi,guide,access,checkout}',
  requests_enabled            boolean not null default true,
  request_categories          public.guest_request_category[] not null
                                default '{towels,linen,cleaning,maintenance,equipment,other}',

  -- ── Leaving ─────────────────────────────────────────────────────────────
  checkout_declaration_enabled boolean not null default true,
  review_enabled              boolean not null default false,
  review_url                  text,
  rebook_enabled              boolean not null default false,

  -- ── After a change ──────────────────────────────────────────────────────
  -- Which changes invalidate an approval the guest already gave. Defaulted to
  -- all four, because the failure this prevents — a guest who agreed to ₪7,500
  -- being treated as having agreed to ₪8,000 — is not one to make a business
  -- opt into avoiding.
  reconfirmation_triggers     text[] not null
                                default '{dates,guests,price,cancellation}',

  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users (id) on delete set null,
  version                     integer not null default 1,

  constraint guest_journey_settings_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guest_journey_settings_hours_sane check (
    arrival_release_hours between 0 and 720
  ),
  -- A review step that cannot link anywhere is an empty step.
  constraint guest_journey_settings_review_has_url check (
    not review_enabled or length(btrim(coalesce(review_url, ''))) > 0
  ),
  constraint guest_journey_settings_version_positive check (version >= 1)
);

create unique index if not exists guest_journey_settings_org_default_key
  on public.guest_journey_settings (organization_id)
  where property_id is null;

create unique index if not exists guest_journey_settings_property_key
  on public.guest_journey_settings (organization_id, property_id)
  where property_id is not null;

comment on table public.guest_journey_settings is
  'What this business asks of a guest: whether there is a contract, which details are collected, when the address is released, what may be requested during a stay. Every step ships off or optional — a guesthouse that confirms by telephone must see no steps at all, and a portal full of things nobody switched on is how a simple business decides the product is not for them.';
comment on column public.guest_journey_settings.property_id is
  'Null is the organization-wide default, not a missing value. A property row overrides it wholesale rather than field by field, because a half-inherited policy is one nobody can predict from the screen.';
comment on column public.guest_journey_settings.reconfirmation_triggers is
  'Which changes void an approval the guest already gave. All four by default: a guest who agreed to ₪7,500 has not agreed to ₪8,000, and that must not be something a business has to opt into.';

drop trigger if exists guest_journey_settings_touch on public.guest_journey_settings;
create trigger guest_journey_settings_touch
  before update on public.guest_journey_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · What a guest is eventually told
-- ============================================================================
-- Per property, because this is a fact about a house. `house_rules` and
-- `cancellation_policy_text` are NOT duplicated here — 0008 already has both on
-- `properties` and §9 reads them from there. A second copy of the cancellation
-- policy is a second answer to a question that reaches a guest.

create table if not exists public.guest_journey_content (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null
    references public.organizations (id) on delete cascade,
  property_id            uuid not null,

  -- Released by arrival_release. SQL NULL in the payload until then — §9.
  address_note           text,
  directions             text,
  map_url                text,
  access_instructions    text,
  access_code            text,
  parking                text,

  -- Released once the stay has begun.
  wifi_network           text,
  wifi_password          text,
  property_guide         text,
  emergency_contact      text,

  -- Released with the checkout step.
  checkout_instructions  text,

  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  version                integer not null default 1,

  constraint guest_journey_content_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guest_journey_content_property_key
    unique (organization_id, property_id),
  constraint guest_journey_content_version_positive check (version >= 1)
);

comment on table public.guest_journey_content is
  'The words a guest eventually reads: how to get there, how to get in, the wifi, how to leave. Split from `properties` because these are disclosed on a schedule and the property row is read by screens with no idea one exists — `access_code` sitting on `properties` would be one careless select away from a staff list, and here it is returned by exactly one function that checks a policy first.';
comment on column public.guest_journey_content.access_code is
  'A door code. Returned as SQL NULL — not as a value with a flag beside it — until arrival_release allows it, because a flag is what a template forgets. booking_guest_journey.access_code overrides it per stay, which is what a business rotating codes between guests actually needs.';

drop trigger if exists guest_journey_content_touch on public.guest_journey_content;
create trigger guest_journey_content_touch
  before update on public.guest_journey_content
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · The contract
-- ============================================================================
-- A template, and — separately and immutably — what was actually signed.
--
-- The separation is the point of the whole section. A signature that pointed at
-- a template row would mean the terms a guest agreed to in March are whatever
-- the template says today, and the first time anybody edits it every historical
-- signature silently changes meaning. So `booking_contract_signatures` stores
-- the title and the body as text, copied at the moment of signing, and the
-- template reference is kept only so somebody can ask which template it came
-- from. INSERT and UPDATE are revoked from `service_role` and INSERT from
-- `authenticated` — §12.

create table if not exists public.guest_contract_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid,

  title            text not null,
  body             text not null,
  -- Bumped by whoever edits. Copied onto every signature so a dispute can name
  -- the revision rather than a date.
  revision         integer not null default 1,
  is_active        boolean not null default true,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint guest_contract_templates_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guest_contract_templates_title_not_blank
    check (length(btrim(title)) > 0),
  constraint guest_contract_templates_body_not_blank
    check (length(btrim(body)) > 0),
  constraint guest_contract_templates_revision_positive check (revision >= 1),
  constraint guest_contract_templates_version_positive check (version >= 1)
);

create unique index if not exists guest_contract_templates_org_active_key
  on public.guest_contract_templates (organization_id)
  where property_id is null and is_active;

create unique index if not exists guest_contract_templates_property_active_key
  on public.guest_contract_templates (organization_id, property_id)
  where property_id is not null and is_active;

comment on table public.guest_contract_templates is
  'The terms as they stand today. One active template per organization, or per property where a property differs. Editing this changes what the NEXT guest signs and nothing that has already been signed — see booking_contract_signatures, which stores the text rather than a pointer to this row.';

drop trigger if exists guest_contract_templates_touch on public.guest_contract_templates;
create trigger guest_contract_templates_touch
  before update on public.guest_contract_templates
  for each row execute function public.tg_touch_row();


create table if not exists public.booking_contract_signatures (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null
    references public.organizations (id) on delete cascade,
  booking_id          uuid not null,

  -- Which template it came from. Nullable and ON DELETE SET NULL: a deleted
  -- template must not take a signature with it, and the frozen text below is
  -- the evidence regardless.
  template_id         uuid references public.guest_contract_templates (id)
                        on delete set null,
  template_revision   integer,

  -- The terms, frozen. Not a pointer. This is the whole reason §4 has two
  -- tables rather than one.
  contract_title      text not null,
  contract_body       text not null,

  -- Who signed, plus what the request looked like. The identifier is optional
  -- because many businesses do not ask for one, and a mandatory column would
  -- make them invent a value.
  signer_name         text not null,
  signer_id_number    text,
  -- A typed name. The product does not draw signatures: a canvas scribble
  -- stored as an image would suggest an evidentiary weight it does not have.
  signature_text      text not null,

  signed_at           timestamptz not null default now(),
  -- What the booking said at the moment of signing. A signature against
  -- version 4 is not a signature against version 9.
  booking_version     integer not null,
  signed_ip           inet,
  signed_user_agent   text,

  -- Set when the booking changed enough that the signature no longer covers it.
  -- Never deleted: the old signature is the evidence of what was agreed before.
  superseded_at       timestamptz,
  superseded_reason   text,

  constraint booking_contract_signatures_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint booking_contract_signatures_name_not_blank
    check (length(btrim(signer_name)) > 0),
  constraint booking_contract_signatures_body_not_blank
    check (length(btrim(contract_body)) > 0),
  constraint booking_contract_signatures_signature_not_blank
    check (length(btrim(signature_text)) > 0),
  constraint booking_contract_signatures_version_positive
    check (booking_version >= 1),
  constraint booking_contract_signatures_superseded_pair check (
    (superseded_at is null and superseded_reason is null)
    or superseded_at is not null
  )
);

-- One live signature per booking. This is also the idempotency guarantee: a
-- guest who taps sign twice hits this index on the second tap, and §10 turns
-- the collision into "already signed" rather than into an error.
create unique index if not exists booking_contract_signatures_live_key
  on public.booking_contract_signatures (booking_id)
  where superseded_at is null;

create index if not exists booking_contract_signatures_booking_idx
  on public.booking_contract_signatures (booking_id, signed_at desc);

comment on table public.booking_contract_signatures is
  'What was actually signed, as text, at the moment it was signed. Append-only and never updated except to mark it superseded — a signature that could be edited is not evidence of anything. The title and body are copies rather than a template reference precisely so that editing the template in April does not retroactively change what a guest agreed to in March.';


-- ============================================================================
-- 5 · The guest's own approval
-- ============================================================================
-- Append-only, one row per act of confirming. Reconfirmation after a change is
-- a NEW row, not an update — the record of what was approved and when is the
-- only thing that can settle "but I never agreed to that", and an UPDATE would
-- overwrite the very sentence in dispute.

create table if not exists public.booking_guest_confirmations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null
    references public.organizations (id) on delete cascade,
  booking_id           uuid not null,

  confirmed_at         timestamptz not null default now(),
  -- The version the guest was looking at. `guest_portal_confirm` refuses when
  -- this does not match the live row, which is what stops a confirmation
  -- landing against terms nobody showed them.
  booking_version      integer not null,

  -- The terms as displayed, frozen. Dates, heads, money and the cancellation
  -- wording. The delta on a reconfirmation screen is computed against this and
  -- nothing else, so it survives any later edit to any of them.
  snapshot             jsonb not null,

  -- Enough to distinguish two devices without identifying a person. Never the
  -- token — see the note at the head of src/lib/guest-portal/session.ts.
  confirmed_ip         inet,
  confirmed_user_agent text,

  superseded_at        timestamptz,
  superseded_reason    text,

  constraint booking_guest_confirmations_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  -- Idempotency, as a domain fact rather than as a client-supplied key.
  -- Confirming version 4 twice is one confirmation of version 4.
  constraint booking_guest_confirmations_version_key
    unique (booking_id, booking_version),
  constraint booking_guest_confirmations_version_positive
    check (booking_version >= 1),
  constraint booking_guest_confirmations_snapshot_object
    check (jsonb_typeof(snapshot) = 'object')
);

create index if not exists booking_guest_confirmations_booking_idx
  on public.booking_guest_confirmations (booking_id, confirmed_at desc);

comment on table public.booking_guest_confirmations is
  'Each time the guest said yes, against which version of the booking, and to exactly what. Append-only: a reconfirmation is a new row, because the record of what was approved is the only thing that can settle a dispute and an UPDATE would erase the half being disputed.';
comment on column public.booking_guest_confirmations.snapshot is
  'The terms as they were displayed — dates, heads, total, cancellation wording. The reconfirmation delta is computed against this frozen copy, so "מחיר קודם ₪7,500 / מחיר חדש ₪8,000" stays true however many times the price moves afterwards.';


-- ============================================================================
-- 6 · Details, requests, sends, and the journey's own state
-- ============================================================================

create table if not exists public.booking_guest_details (
  booking_id       uuid primary key,
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,

  -- Only the fields the operator asked for. A jsonb object rather than thirty
  -- nullable columns, because the *set* is configuration — one business wants a
  -- תעודת זהות and an arrival time, another wants a car registration for the
  -- gate, and neither should carry the other's empty columns. The application
  -- validates the keys against `required_detail_fields`.
  fields           jsonb not null default '{}'::jsonb,

  submitted_at     timestamptz,
  updated_at       timestamptz not null default now(),

  constraint booking_guest_details_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint booking_guest_details_fields_object
    check (jsonb_typeof(fields) = 'object')
);

comment on table public.booking_guest_details is
  'What the guest filled in. Keyed on the booking so the write is an upsert and a double submission is one row. jsonb rather than columns because which details are collected is configuration: a business asking for a car registration and one asking for a תעודת זהות should not each carry the other''s empty column.';


create table if not exists public.guest_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  booking_id       uuid not null,
  property_id      uuid not null,

  category         public.guest_request_category not null,
  body             text,

  -- What the guest is shown. Derived from the task by §11 and stored, so the
  -- portal never has to read `tasks` — which it could not do anyway, having no
  -- membership.
  state            public.guest_request_state not null default 'received',

  -- The operational half. ON DELETE SET NULL rather than cascade: a deleted
  -- task must not erase the fact that a guest asked.
  task_id          uuid,

  -- The one client-supplied idempotency key in this migration. See the header.
  client_key       text not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,

  constraint guest_requests_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint guest_requests_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint guest_requests_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete set null (task_id),
  constraint guest_requests_client_key_unique unique (booking_id, client_key),
  constraint guest_requests_client_key_not_blank
    check (length(btrim(client_key)) > 0),
  constraint guest_requests_body_length
    check (length(coalesce(body, '')) <= 2000)
);

create index if not exists guest_requests_booking_idx
  on public.guest_requests (booking_id, created_at desc);
create index if not exists guest_requests_org_state_idx
  on public.guest_requests (organization_id, state, created_at desc);
create index if not exists guest_requests_task_idx
  on public.guest_requests (task_id, organization_id);

comment on table public.guest_requests is
  'What a guest asked for during their stay, and only what a guest may be told about it. The work itself is a row in public.tasks — the canonical engine — and this table deliberately carries no assignee, no internal note and no completion note: התקבלה, בטיפול, הושלמה is the entire vocabulary a guest sees, and it is stored here rather than derived at render time so that no screen is ever one join away from a staff name.';
comment on column public.guest_requests.client_key is
  'Minted when the compose form opens, not when it is submitted. A double-tap therefore shares a key and produces one request, while a second genuine request for towels an hour later carries a new one and produces a second — which no combination of category, body and timestamp could distinguish.';


create table if not exists public.guest_link_sends (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  booking_id       uuid not null,

  channel          public.guest_link_channel not null,
  -- Masked before it is written. Enough to recognise the number you sent to,
  -- not enough to make this table a contact list.
  recipient_masked text,
  sent_at          timestamptz not null default now(),
  sent_by          uuid references auth.users (id) on delete set null,
  -- Whether this send followed a rotation, so "we sent it three times" and "we
  -- sent three different links" stay distinguishable in the journey tab.
  after_rotation   boolean not null default false,

  constraint guest_link_sends_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade
);

create index if not exists guest_link_sends_booking_idx
  on public.guest_link_sends (booking_id, sent_at desc);

comment on table public.guest_link_sends is
  'Every time the link went out, through which channel and by whom. Append-only. The recipient is masked on the way in: this table would otherwise become the one place in the schema where every guest telephone number is listed together, which is a different asset from a guest record and a more attractive one.';


create table if not exists public.booking_guest_journey (
  booking_id           uuid primary key,
  organization_id      uuid not null
    references public.organizations (id) on delete cascade,

  -- Overrides guest_journey_content.access_code for this stay.
  access_code          text,

  -- The operator's override, and the escape hatch that means no business is
  -- ever stuck behind a release condition it cannot satisfy.
  manual_released_at   timestamptz,
  manual_released_by   uuid references auth.users (id) on delete set null,

  -- ── PORT · stamped by the payment-collection module ─────────────────────
  -- Null until that module writes them, and the gate stays shut while they
  -- are. See the header: shut is the correct direction to fail here.
  deposit_settled_at   timestamptz,
  payment_settled_at   timestamptz,

  -- The guest said they had gone. Not the same as the business checking them
  -- out, which is `bookings.status`, and deliberately kept apart from it.
  checkout_declared_at timestamptz,

  details_completed_at timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint booking_guest_journey_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade
);

comment on table public.booking_guest_journey is
  'One row per booking holding the journey state that is not an append-only record of something the guest did. deposit_settled_at and payment_settled_at are a PORT: the payment-collection module stamps them and this module only reads them, which is what lets the arrival gate honour "after the deposit" without this file knowing anything about how money is taken.';
comment on column public.booking_guest_journey.checkout_declared_at is
  'The guest pressed "יצאנו מהנכס". Deliberately not bookings.status: it is a helpful signal to housekeeping, not evidence the unit is empty, and collapsing the two would let somebody with no account move a booking through the state machine.';


-- The send counters, which belong to the guest_link_* family 0033 put on
-- `bookings` rather than to the journey state above. `guest_link_sent_at`
-- against `guest_link_first_opened_at` is the whole "sent and never opened"
-- question, and splitting the two halves across two tables would make the one
-- query the journey tab exists to answer into a join.
alter table public.bookings
  add column if not exists guest_link_sent_at timestamptz,
  add column if not exists guest_link_send_count integer not null default 0;

comment on column public.bookings.guest_link_sent_at is
  'When the link was last sent. Sits beside guest_link_first_opened_at from 0033 on purpose: "sent and never opened" and "opened three times and not confirmed" are the two questions the journey tab exists to answer, and they are one row apart.';

alter table public.bookings
  drop constraint if exists bookings_guest_link_send_count_sane;
alter table public.bookings
  add constraint bookings_guest_link_send_count_sane
  check (guest_link_send_count >= 0);


-- ============================================================================
-- 7 · Resolving a token, once
-- ============================================================================
-- The single implementation of "is this token good right now". The same four
-- refusals as 0033, in the same order, because two implementations of that
-- question is how one of them ends up admitting a revoked link.
--
-- It returns a whole `bookings` row and is therefore revoked from everybody.
-- Only the SECURITY DEFINER functions below call it, and they run as the owner.

create or replace function public.guest_link_booking(p_token text)
returns public.bookings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if p_token is null or length(btrim(p_token)) < 32 then
    raise exception 'guest_link_not_found'
      using hint = 'הקישור אינו תקין. בקש מבית האירוח לשלוח קישור חדש.',
            errcode = 'P0002';
  end if;

  select * into v_booking
  from public.bookings
  where guest_token = p_token;

  if not found then
    raise exception 'guest_link_not_found'
      using hint = 'לא מצאנו את ההזמנה. ייתכן שהקישור הועתק חלקית.',
            errcode = 'P0002';
  end if;

  if v_booking.deleted_at is not null then
    raise exception 'guest_link_not_found'
      using hint = 'ההזמנה אינה זמינה עוד.', errcode = 'P0002';
  end if;

  if v_booking.guest_link_revoked_at is not null then
    raise exception 'guest_link_revoked'
      using hint = 'הקישור בוטל. פנה לבית האירוח לקבלת קישור חדש.',
            errcode = 'P0004';
  end if;

  if v_booking.guest_link_expires_at is not null
     and v_booking.guest_link_expires_at <= now() then
    raise exception 'guest_link_expired'
      using hint = 'תוקף הקישור פג. פנה לבית האירוח לקבלת קישור חדש.',
            errcode = 'P0005';
  end if;

  return v_booking;
end;
$$;

comment on function public.guest_link_booking(text) is
  'The one implementation of "is this token good right now", repeating 0033''s four refusals in 0033''s order. Returns the whole bookings row and is therefore revoked from anon, authenticated, public and service_role — it is reachable only from the SECURITY DEFINER functions in this migration, which run as its owner. Every guest-facing write calls this rather than accepting a booking id, which is why no argument a guest controls can name somebody else''s stay.';


-- A malformed forwarded address must never be the reason a guest's
-- confirmation fails to record. Defined before its callers for readability;
-- plpgsql would not have minded either way.
create or replace function public.try_cast_inet(p_value text)
returns inet
language plpgsql
immutable
as $$
begin
  return p_value::inet;
exception when others then
  return null;
end;
$$;

comment on function public.try_cast_inet(text) is
  'Returns null where a direct cast would raise. A guest behind a proxy that sends a malformed X-Forwarded-For must still be able to confirm their booking.';


-- The effective settings for a booking: the property row where there is one,
-- otherwise the organization default, otherwise the shipped defaults. Resolved
-- here so that no screen and no second function has to know the precedence.
create or replace function public.guest_journey_effective_settings(
  p_organization_id uuid,
  p_property_id uuid
)
returns public.guest_journey_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings public.guest_journey_settings%rowtype;
begin
  select * into v_settings
  from public.guest_journey_settings
  where organization_id = p_organization_id
    and property_id = p_property_id;

  if found then return v_settings; end if;

  select * into v_settings
  from public.guest_journey_settings
  where organization_id = p_organization_id
    and property_id is null;

  if found then return v_settings; end if;

  -- Never configured. The shipped defaults, which are deliberately the
  -- quietest possible journey: no contract, no details, confirmation only.
  v_settings.organization_id := p_organization_id;
  v_settings.property_id := null;
  v_settings.contract_mode := 'disabled';
  v_settings.require_guest_confirmation := true;
  v_settings.required_detail_fields := '{}'::text[];
  v_settings.optional_detail_fields := '{}'::text[];
  v_settings.arrival_release := 'after_confirmation';
  v_settings.arrival_release_hours := 24;
  v_settings.during_stay_topics := '{wifi,guide,access,checkout}'::text[];
  v_settings.requests_enabled := true;
  v_settings.request_categories :=
    '{towels,linen,cleaning,maintenance,equipment,other}'::public.guest_request_category[];
  v_settings.checkout_declaration_enabled := true;
  v_settings.review_enabled := false;
  v_settings.rebook_enabled := false;
  v_settings.reconfirmation_triggers :=
    '{dates,guests,price,cancellation}'::text[];
  return v_settings;
end;
$$;

comment on function public.guest_journey_effective_settings(uuid, uuid) is
  'Property row, else organization default, else the shipped defaults — which are the quietest journey the product can offer: confirmation only, no contract, no details. A business that has never opened the settings screen still gets a working portal, and it shows their guest nothing they did not ask for.';


-- ============================================================================
-- 8 · When the address may be shown
-- ============================================================================
-- Its own function because it is the security decision in this migration, and a
-- security decision buried two hundred lines inside a projection is one nobody
-- reviews. It answers one question and returns one boolean.

create or replace function public.guest_arrival_released(
  p_booking public.bookings,
  p_settings public.guest_journey_settings,
  p_journey public.booking_guest_journey,
  p_confirmed boolean,
  p_signed boolean,
  p_check_in_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_settings.arrival_release
    when 'immediate'          then true
    when 'after_confirmation' then p_confirmed
    when 'after_contract'     then p_signed
    when 'after_deposit'      then p_journey.deposit_settled_at is not null
    when 'after_full_payment' then p_journey.payment_settled_at is not null
    when 'hours_before'       then
      now() >= p_check_in_at
        - make_interval(hours => p_settings.arrival_release_hours)
    when 'manual'             then p_journey.manual_released_at is not null
    else false
  end
  -- The override, on every branch. Without it a business that chose
  -- `after_deposit` before the payment module exists could never show an
  -- address at all, and the workaround would be to change the policy — which
  -- would then be wrong for every other booking.
  or p_journey.manual_released_at is not null
  -- A guest standing in the doorway is past the argument. Withholding the door
  -- code from somebody the business has already checked in is not a policy, it
  -- is a support call at eleven at night.
  or p_booking.status in ('checked_in', 'in_house', 'checkout_pending',
                          'checked_out', 'inspection', 'deposit_release',
                          'completed', 'review_requested');
$$;

comment on function public.guest_arrival_released(public.bookings, public.guest_journey_settings, public.booking_guest_journey, boolean, boolean, timestamptz) is
  'Whether the address, directions and access code may be disclosed. Its own function because it is the security decision in this migration, and one buried inside a two-hundred-line projection is one nobody reviews. Two unconditional overrides: the operator''s manual release, and a guest the business has already checked in — withholding a door code from somebody standing at the door is not a policy.';


-- ============================================================================
-- 9 · What the portal reads
-- ============================================================================
-- One round trip, one projection, everything gated. The guest-facing companion
-- to 0033's `guest_portal_session`: that one answers "whose booking is this",
-- this one answers "and what happens next".
--
-- Note what is NOT in the output, for the same reason 0033 listed it: no
-- internal_notes, no attribution, no margin, no cost, no owner payout, no agent
-- commission, no staff name, no task assignee, no other booking. The request
-- list carries `state` and never the task it came from.

create or replace function public.guest_portal_journey(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_booking     public.bookings%rowtype;
  v_settings    public.guest_journey_settings%rowtype;
  v_journey     public.booking_guest_journey%rowtype;
  v_content     public.guest_journey_content%rowtype;
  v_property    public.properties%rowtype;
  v_confirm     public.booking_guest_confirmations%rowtype;
  v_signature   public.booking_contract_signatures%rowtype;
  v_details     public.booking_guest_details%rowtype;
  v_template    public.guest_contract_templates%rowtype;
  v_check_in_at timestamptz;
  v_released    boolean;
  v_in_stay     boolean;
  v_confirmed   boolean;
  v_signed      boolean;
  v_requests    jsonb;
begin
  -- Re-resolved here. This function does not trust that a layout, a page or a
  -- caller checked; there is no code path into the projection that skips it.
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  select * into v_journey from public.booking_guest_journey
  where booking_id = v_booking.id;
  -- Absent is not an error: a booking acquires a journey row the first time
  -- anything is stamped on it, and until then every field is null, which is
  -- exactly what an unstarted journey means.
  if not found then
    v_journey.booking_id := v_booking.id;
    v_journey.organization_id := v_booking.organization_id;
  end if;

  select * into v_property from public.properties
  where id = v_booking.property_id
    and organization_id = v_booking.organization_id;

  select * into v_content from public.guest_journey_content
  where organization_id = v_booking.organization_id
    and property_id = v_booking.property_id;

  select * into v_confirm from public.booking_guest_confirmations
  where booking_id = v_booking.id and superseded_at is null
  order by confirmed_at desc limit 1;
  v_confirmed := v_confirm.id is not null;

  select * into v_signature from public.booking_contract_signatures
  where booking_id = v_booking.id and superseded_at is null
  limit 1;
  v_signed := v_signature.id is not null;

  select * into v_details from public.booking_guest_details
  where booking_id = v_booking.id;

  if v_settings.contract_mode <> 'disabled' and not v_signed then
    select * into v_template from public.guest_contract_templates
    where organization_id = v_booking.organization_id
      and is_active
      and (property_id = v_booking.property_id or property_id is null)
    order by (property_id is not null) desc
    limit 1;
  end if;

  v_check_in_at := (v_booking.check_in
      + coalesce(v_booking.arrival_time, v_property.default_check_in_time,
                 '15:00'::time))
    at time zone coalesce(v_property.timezone, 'Asia/Jerusalem');

  v_released := public.guest_arrival_released(
    v_booking, v_settings, v_journey, v_confirmed, v_signed, v_check_in_at);

  -- During-stay content opens when the stay does, by the calendar or by the
  -- status, whichever comes first — an early check-in is ordinary, and a guest
  -- sitting on the sofa should not be told the wifi is not available yet.
  v_in_stay := v_booking.status in ('checked_in', 'in_house', 'checkout_pending')
    or (current_date >= v_booking.check_in
        and current_date < v_booking.check_out);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',          r.id,
    'category',    r.category,
    'body',        r.body,
    'state',       r.state,
    'createdAt',   r.created_at,
    'completedAt', r.completed_at
  ) order by r.created_at desc), '[]'::jsonb)
  into v_requests
  from public.guest_requests r
  where r.booking_id = v_booking.id;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'contractMode',              v_settings.contract_mode,
      'requireGuestConfirmation',  v_settings.require_guest_confirmation,
      'requiredDetailFields',      to_jsonb(v_settings.required_detail_fields),
      'optionalDetailFields',      to_jsonb(v_settings.optional_detail_fields),
      'arrivalRelease',            v_settings.arrival_release,
      'arrivalReleaseHours',       v_settings.arrival_release_hours,
      'duringStayTopics',          to_jsonb(v_settings.during_stay_topics),
      'requestsEnabled',           v_settings.requests_enabled,
      'requestCategories',         to_jsonb(v_settings.request_categories),
      'checkoutDeclarationEnabled', v_settings.checkout_declaration_enabled,
      'reviewEnabled',             v_settings.review_enabled,
      'reviewUrl',                 v_settings.review_url,
      'rebookEnabled',             v_settings.rebook_enabled,
      'reconfirmationTriggers',    to_jsonb(v_settings.reconfirmation_triggers)
    ),

    -- The live terms, for the delta. Every one of these is already in 0033's
    -- projection; none of them is a new disclosure.
    'current', jsonb_build_object(
      'bookingVersion',    v_booking.version,
      'status',            v_booking.status,
      'checkIn',           v_booking.check_in,
      'checkOut',          v_booking.check_out,
      'adults',            v_booking.adults,
      'children',          v_booking.children,
      'infants',           v_booking.infants,
      'totalAgorot',       v_booking.total_agorot,
      'currency',          v_booking.currency,
      'cancellationTerms', v_property.cancellation_policy_text,
      'inStay',            v_in_stay
    ),

    'confirmation', case when v_confirmed then jsonb_build_object(
      'confirmedAt',    v_confirm.confirmed_at,
      'bookingVersion', v_confirm.booking_version,
      'snapshot',       v_confirm.snapshot
    ) else null end,

    'contract', jsonb_build_object(
      'mode', v_settings.contract_mode,
      -- The template is offered only while there is something to sign. After
      -- signing, the frozen text is the only contract that exists here.
      'template', case
        when v_settings.contract_mode <> 'disabled' and not v_signed
             and v_template.id is not null
        then jsonb_build_object('title', v_template.title,
                                'body',  v_template.body)
        else null end,
      'signature', case when v_signed then jsonb_build_object(
        'signedAt',       v_signature.signed_at,
        'signerName',     v_signature.signer_name,
        'title',          v_signature.contract_title,
        'body',           v_signature.contract_body,
        'bookingVersion', v_signature.booking_version
      ) else null end
    ),

    'details', jsonb_build_object(
      'submittedAt', v_details.submitted_at,
      'fields',      coalesce(v_details.fields, '{}'::jsonb)
    ),

    -- Every field below is SQL NULL until the policy allows it. Not a value
    -- with a flag beside it — see §3.
    'arrival', jsonb_build_object(
      'released',           v_released,
      'checkInTime',        coalesce(v_booking.arrival_time,
                                     v_property.default_check_in_time),
      'addressNote',        case when v_released then v_content.address_note end,
      'addressLine1',       case when v_released then v_property.address_line1 end,
      'addressLine2',       case when v_released then v_property.address_line2 end,
      -- The city is not gated. It is on the booking confirmation the guest
      -- already has and in the property's public listing; withholding it would
      -- be theatre rather than protection.
      'city',               v_property.city,
      'directions',         case when v_released then v_content.directions end,
      'mapUrl',             case when v_released then v_content.map_url end,
      'parking',            case when v_released then v_content.parking end,
      'accessInstructions', case when v_released
                                 then v_content.access_instructions end,
      'accessCode',         case when v_released
                                 then coalesce(v_journey.access_code,
                                               v_content.access_code) end
    ),

    'stay', jsonb_build_object(
      'inStay',           v_in_stay,
      'wifiNetwork',      case when v_in_stay then v_content.wifi_network end,
      'wifiPassword',     case when v_in_stay then v_content.wifi_password end,
      'propertyGuide',    case when v_in_stay then v_content.property_guide end,
      'houseRules',       v_property.house_rules,
      'emergencyContact', case when v_in_stay
                               then v_content.emergency_contact end
    ),

    'requests', v_requests,

    'checkout', jsonb_build_object(
      'checkOutTime', v_property.default_check_out_time,
      'instructions', case when v_in_stay
                            or v_booking.status in ('checkout_pending',
                                                    'checked_out')
                           then v_content.checkout_instructions end,
      'declaredAt',   v_journey.checkout_declared_at,
      'enabled',      v_settings.checkout_declaration_enabled
    )
  );
end;
$$;

comment on function public.guest_portal_journey(text) is
  'Everything the portal renders after 0033 has said whose booking it is, in one round trip and with every secret gated. The address, the directions and the access code come back as SQL NULL until guest_arrival_released says otherwise; the wifi password until the stay has begun. It re-resolves the token itself rather than trusting that the layout did.';


-- ============================================================================
-- 10 · What a guest may write
-- ============================================================================
-- Five functions, each taking the token, each re-resolving it, none taking a
-- booking id. Every one is idempotent on a domain fact — see the header — so a
-- double tap on a bad connection produces one of whatever it is.

-- ── Confirming ────────────────────────────────────────────────────────────
-- Takes the version the guest was looking at, and refuses when the booking has
-- moved. That refusal is the reconfirmation law: an approval recorded against
-- terms nobody displayed is worse than no approval, because it looks like
-- consent.
create or replace function public.guest_portal_confirm(
  p_token text,
  p_booking_version integer,
  p_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_property public.properties%rowtype;
  v_existing public.booking_guest_confirmations%rowtype;
  v_row      public.booking_guest_confirmations%rowtype;
  v_snapshot jsonb;
begin
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  if not v_settings.require_guest_confirmation then
    raise exception 'guest_confirmation_not_required'
      using hint = 'ההזמנה הזו אינה דורשת אישור שלך.', errcode = 'P0006';
  end if;

  if v_booking.status in ('cancelled', 'no_show') then
    raise exception 'guest_booking_not_confirmable'
      using hint = 'ההזמנה בוטלה ולא ניתן לאשר אותה. פנה לבית האירוח.',
            errcode = 'P0006';
  end if;

  -- The stale refusal, and it names the live version so the caller can show the
  -- delta and ask again rather than merely failing.
  if p_booking_version is distinct from v_booking.version then
    raise exception 'guest_confirmation_stale'
      using hint = 'ההזמנה עודכנה מאז שפתחת את הדף. רענן כדי לראות את השינוי ולאשר מחדש.',
            errcode = 'P0008',
            detail = v_booking.version::text;
  end if;

  -- Idempotent by construction: the second tap finds the first tap's row.
  select * into v_existing from public.booking_guest_confirmations
  where booking_id = v_booking.id and booking_version = v_booking.version;

  if found then
    return jsonb_build_object('confirmationId', v_existing.id,
                              'confirmedAt', v_existing.confirmed_at,
                              'bookingVersion', v_existing.booking_version,
                              'created', false);
  end if;

  select * into v_property from public.properties
  where id = v_booking.property_id
    and organization_id = v_booking.organization_id;

  -- Frozen here rather than by the caller: a snapshot the client composed is a
  -- snapshot the client could compose differently.
  v_snapshot := jsonb_build_object(
    'checkIn',           v_booking.check_in,
    'checkOut',          v_booking.check_out,
    'adults',            v_booking.adults,
    'children',          v_booking.children,
    'infants',           v_booking.infants,
    'totalAgorot',       v_booking.total_agorot,
    'currency',          v_booking.currency,
    'cancellationTerms', v_property.cancellation_policy_text
  );

  -- Everything confirmed before this act is superseded by it, so the "live"
  -- confirmation is always exactly one row.
  update public.booking_guest_confirmations
  set superseded_at = now(),
      superseded_reason = 'reconfirmed'
  where booking_id = v_booking.id and superseded_at is null;

  insert into public.booking_guest_confirmations (
    organization_id, booking_id, booking_version, snapshot,
    confirmed_ip, confirmed_user_agent
  ) values (
    v_booking.organization_id, v_booking.id, v_booking.version, v_snapshot,
    public.try_cast_inet(p_ip), left(p_user_agent, 500)
  )
  returning * into v_row;

  insert into public.booking_guest_journey (booking_id, organization_id)
  values (v_booking.id, v_booking.organization_id)
  on conflict (booking_id) do nothing;

  return jsonb_build_object('confirmationId', v_row.id,
                            'confirmedAt', v_row.confirmed_at,
                            'bookingVersion', v_row.booking_version,
                            'created', true);
exception
  -- A second tap that raced the SELECT above.
  when unique_violation then
    select * into v_existing from public.booking_guest_confirmations
    where booking_id = v_booking.id and booking_version = v_booking.version;
    return jsonb_build_object('confirmationId', v_existing.id,
                              'confirmedAt', v_existing.confirmed_at,
                              'bookingVersion', v_existing.booking_version,
                              'created', false);
end;
$$;

comment on function public.guest_portal_confirm(text, integer, text, text) is
  'Records the guest''s approval against the version they were shown, and refuses with guest_confirmation_stale when the booking has moved since. Idempotent on (booking_id, booking_version): confirming version 4 twice is one confirmation of version 4, and the second tap returns the first''s row rather than an error.';


-- ── Signing ───────────────────────────────────────────────────────────────
create or replace function public.guest_portal_sign_contract(
  p_token text,
  p_signer_name text,
  p_signature_text text,
  p_signer_id_number text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_template public.guest_contract_templates%rowtype;
  v_existing public.booking_contract_signatures%rowtype;
  v_row      public.booking_contract_signatures%rowtype;
begin
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  -- Disabled means the step does not exist. Not "exists and is refused" — a
  -- business that switched the contract off must have no way for a signature
  -- row to appear against one of its bookings at all.
  if v_settings.contract_mode = 'disabled' then
    raise exception 'guest_contract_disabled'
      using hint = 'אין חוזה לחתימה בהזמנה הזו.', errcode = 'P0006';
  end if;

  if length(btrim(coalesce(p_signer_name, ''))) = 0
     or length(btrim(coalesce(p_signature_text, ''))) = 0 then
    raise exception 'guest_signature_incomplete'
      using hint = 'יש להזין שם מלא וחתימה.', errcode = 'P0006';
  end if;

  select * into v_existing from public.booking_contract_signatures
  where booking_id = v_booking.id and superseded_at is null;

  if found then
    return jsonb_build_object('signatureId', v_existing.id,
                              'signedAt', v_existing.signed_at,
                              'created', false);
  end if;

  select * into v_template from public.guest_contract_templates
  where organization_id = v_booking.organization_id
    and is_active
    and (property_id = v_booking.property_id or property_id is null)
  order by (property_id is not null) desc
  limit 1;

  if not found then
    raise exception 'guest_contract_unavailable'
      using hint = 'נוסח החוזה אינו זמין כרגע. פנה לבית האירוח.',
            errcode = 'P0007';
  end if;

  -- The text is copied, not referenced. This statement is the entire reason §4
  -- has two tables.
  insert into public.booking_contract_signatures (
    organization_id, booking_id, template_id, template_revision,
    contract_title, contract_body, signer_name, signer_id_number,
    signature_text, booking_version, signed_ip, signed_user_agent
  ) values (
    v_booking.organization_id, v_booking.id, v_template.id, v_template.revision,
    v_template.title, v_template.body,
    btrim(p_signer_name), nullif(btrim(coalesce(p_signer_id_number, '')), ''),
    btrim(p_signature_text), v_booking.version,
    public.try_cast_inet(p_ip), left(p_user_agent, 500)
  )
  returning * into v_row;

  insert into public.booking_guest_journey (booking_id, organization_id)
  values (v_booking.id, v_booking.organization_id)
  on conflict (booking_id) do nothing;

  return jsonb_build_object('signatureId', v_row.id,
                            'signedAt', v_row.signed_at,
                            'created', true);
exception
  -- The unique index caught a second tap that raced the SELECT above.
  when unique_violation then
    select * into v_existing from public.booking_contract_signatures
    where booking_id = v_booking.id and superseded_at is null;
    return jsonb_build_object('signatureId', v_existing.id,
                              'signedAt', v_existing.signed_at,
                              'created', false);
end;
$$;

comment on function public.guest_portal_sign_contract(text, text, text, text, text, text) is
  'Freezes the active template''s title and body onto a signature row. Refuses outright when the contract is disabled, because a disabled step must have no way to produce a row. Idempotent through the one-live-signature index, including against a second tap that races the read.';


-- ── Details ───────────────────────────────────────────────────────────────
create or replace function public.guest_portal_save_details(
  p_token text,
  p_fields jsonb,
  p_complete boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_row     public.booking_guest_details%rowtype;
begin
  v_booking := public.guest_link_booking(p_token);

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'guest_details_invalid'
      using hint = 'הפרטים שנשלחו אינם תקינים.', errcode = 'P0006';
  end if;

  -- A cap rather than a schema: which keys are legitimate is configuration, and
  -- the application checks them against required_detail_fields. What this
  -- refuses is a payload being used as storage.
  if length(p_fields::text) > 20000 then
    raise exception 'guest_details_too_large'
      using hint = 'הפרטים ארוכים מדי. קצר את התשובות ונסה שוב.',
            errcode = 'P0006';
  end if;

  insert into public.booking_guest_details (
    booking_id, organization_id, fields, submitted_at, updated_at
  ) values (
    v_booking.id, v_booking.organization_id, p_fields,
    case when p_complete then now() else null end, now()
  )
  on conflict (booking_id) do update
  set fields = excluded.fields,
      -- Never un-submits. A guest correcting one field after completing the
      -- form has not withdrawn the form.
      submitted_at = coalesce(public.booking_guest_details.submitted_at,
                              excluded.submitted_at),
      updated_at = now()
  returning * into v_row;

  insert into public.booking_guest_journey (booking_id, organization_id,
                                            details_completed_at)
  values (v_booking.id, v_booking.organization_id, v_row.submitted_at)
  on conflict (booking_id) do update
  set details_completed_at = coalesce(
        public.booking_guest_journey.details_completed_at,
        excluded.details_completed_at),
      updated_at = now();

  return jsonb_build_object('submittedAt', v_row.submitted_at,
                            'updatedAt', v_row.updated_at);
end;
$$;

comment on function public.guest_portal_save_details(text, jsonb, boolean) is
  'Upsert keyed on the booking, so a double submission is one row. submitted_at is coalesced rather than overwritten: a guest correcting a telephone number after completing the form has not withdrawn the form.';


-- ── Asking for something ──────────────────────────────────────────────────
-- The one function here that writes into another module's table, and it does so
-- through `public.tasks` — the canonical engine — rather than by inventing a
-- second kind of work. What comes back to the guest is `state` and nothing
-- else: no assignee, no note, no name.
create or replace function public.guest_portal_submit_request(
  p_token text,
  p_category text,
  p_body text,
  p_client_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_existing public.guest_requests%rowtype;
  v_category public.guest_request_category;
  v_task_id  uuid;
  v_row      public.guest_requests%rowtype;
  v_title    text;
begin
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  if not v_settings.requests_enabled then
    raise exception 'guest_requests_disabled'
      using hint = 'לא ניתן לשלוח בקשות בהזמנה הזו.', errcode = 'P0006';
  end if;

  if length(btrim(coalesce(p_client_key, ''))) = 0 then
    raise exception 'guest_request_key_missing'
      using hint = 'לא ניתן לשלוח את הבקשה. רענן את הדף ונסה שוב.',
            errcode = 'P0006';
  end if;

  begin
    v_category := p_category::public.guest_request_category;
  exception when invalid_text_representation then
    raise exception 'guest_request_category_unknown'
      using hint = 'סוג הבקשה אינו מוכר. בחר מהרשימה.', errcode = 'P0006';
  end;

  if not (v_category = any (v_settings.request_categories)) then
    raise exception 'guest_request_category_unavailable'
      using hint = 'סוג הבקשה הזה אינו זמין בהזמנה הזו.', errcode = 'P0006';
  end if;

  -- Idempotent on the key the compose form minted. The second tap of one button
  -- finds the first tap's row.
  select * into v_existing from public.guest_requests
  where booking_id = v_booking.id and client_key = btrim(p_client_key);

  if found then
    return jsonb_build_object('requestId', v_existing.id,
                              'state', v_existing.state,
                              'created', false);
  end if;

  v_title := 'בקשת אורח · ' || case v_category
    when 'towels'      then 'מגבות'
    when 'linen'       then 'מצעים'
    when 'cleaning'    then 'ניקיון'
    when 'maintenance' then 'תחזוקה'
    when 'equipment'   then 'ציוד'
    else 'אחר' end;

  -- The canonical engine. `guest_request` is already a member of
  -- public.task_type — 0011 put it there — so this needs no new vocabulary.
  insert into public.tasks (
    organization_id, property_id, unit_id, booking_id,
    task_type, status, priority, title, description
  ) values (
    v_booking.organization_id, v_booking.property_id, v_booking.unit_id,
    v_booking.id,
    'guest_request'::public.task_type, 'new'::public.task_status,
    (case when v_category = 'maintenance' then 'high' else 'normal' end)
      ::public.task_priority,
    v_title, nullif(btrim(coalesce(p_body, '')), '')
  )
  returning id into v_task_id;

  insert into public.guest_requests (
    organization_id, booking_id, property_id, category, body, task_id,
    client_key
  ) values (
    v_booking.organization_id, v_booking.id, v_booking.property_id,
    v_category, nullif(btrim(coalesce(p_body, '')), ''), v_task_id,
    btrim(p_client_key)
  )
  returning * into v_row;

  return jsonb_build_object('requestId', v_row.id,
                            'state', v_row.state,
                            'created', true);
exception
  -- Entering this handler rolls the block back, so the task inserted above goes
  -- with it. A duplicate request must not leave an orphan job on the board.
  when unique_violation then
    select * into v_existing from public.guest_requests
    where booking_id = v_booking.id and client_key = btrim(p_client_key);
    return jsonb_build_object('requestId', v_existing.id,
                              'state', v_existing.state,
                              'created', false);
end;
$$;

comment on function public.guest_portal_submit_request(text, text, text, text) is
  'Turns a guest request into a row in public.tasks — the canonical engine, using the guest_request task_type 0011 already defined — and records beside it only what a guest may be told. Idempotent on the client key the compose form minted when it opened, which is the one thing that can tell a double-tap apart from a second genuine request an hour later.';


-- ── Saying you have gone ──────────────────────────────────────────────────
create or replace function public.guest_portal_declare_checkout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_when     timestamptz;
begin
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  if not v_settings.checkout_declaration_enabled then
    raise exception 'guest_checkout_declaration_disabled'
      using hint = 'ההצהרה על עזיבה אינה פעילה בהזמנה הזו.', errcode = 'P0006';
  end if;

  -- Deliberately does NOT touch bookings.status. A guest declaration is a
  -- signal to housekeeping, not a state transition, and letting it move the
  -- booking would hand the state machine to somebody with no account.
  insert into public.booking_guest_journey (booking_id, organization_id,
                                            checkout_declared_at)
  values (v_booking.id, v_booking.organization_id, now())
  on conflict (booking_id) do update
  set checkout_declared_at = coalesce(
        public.booking_guest_journey.checkout_declared_at, now()),
      updated_at = now()
  returning checkout_declared_at into v_when;

  return jsonb_build_object('declaredAt', v_when);
end;
$$;

comment on function public.guest_portal_declare_checkout(text) is
  'Stamps that the guest said they had left. Idempotent through coalesce, and deliberately does not touch bookings.status — a declaration is a signal to housekeeping, and letting it move the booking would hand the state machine to somebody with no account.';


-- ============================================================================
-- 11 · Keeping the guest's view of a request honest
-- ============================================================================
-- The nine task statuses collapse onto the four a guest sees, in one trigger,
-- so the mapping cannot drift between a portal screen and an operations board.

create or replace function public.tg_guest_request_follow_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.guest_requests
  set state = case new.status
        when 'new'               then 'received'::public.guest_request_state
        when 'assigned'          then 'received'::public.guest_request_state
        when 'accepted'          then 'in_progress'::public.guest_request_state
        when 'in_progress'       then 'in_progress'::public.guest_request_state
        -- `blocked` reads as `in_progress` to the guest on purpose. That the
        -- linen has not arrived is a fact about the business's day, and a guest
        -- told their towels are BLOCKED learns something alarming that they
        -- cannot act on.
        when 'blocked'           then 'in_progress'::public.guest_request_state
        when 'awaiting_approval' then 'in_progress'::public.guest_request_state
        when 'completed'         then 'completed'::public.guest_request_state
        when 'verified'          then 'completed'::public.guest_request_state
        when 'cancelled'         then 'cancelled'::public.guest_request_state
        else state
      end,
      completed_at = case
        when new.status in ('completed', 'verified')
        then coalesce(completed_at, now())
        else completed_at end,
      updated_at = now()
  where task_id = new.id
    and organization_id = new.organization_id;

  return new;
end;
$$;

drop trigger if exists guest_request_follows_task on public.tasks;
create trigger guest_request_follows_task
  after update of status on public.tasks
  for each row
  when (old.status is distinct from new.status)
  execute function public.tg_guest_request_follow_task();

comment on function public.tg_guest_request_follow_task() is
  'Collapses the nine task statuses onto the four a guest sees, in one place, so a portal screen and an operations board cannot come to disagree. `blocked` deliberately reads as בטיפול: that the linen has not arrived is a fact about the business''s day, and a guest told their towels are BLOCKED learns something alarming they cannot act on.';


-- ============================================================================
-- 12 · Row level security
-- ============================================================================
-- Not one policy admits `anon`. See the header: a guest has no membership, so a
-- policy is not a thing that can express their authorization, and everything
-- they write goes through §10 instead.

alter table public.guest_journey_settings      enable row level security;
alter table public.guest_journey_settings      force  row level security;
alter table public.guest_journey_content       enable row level security;
alter table public.guest_journey_content       force  row level security;
alter table public.guest_contract_templates    enable row level security;
alter table public.guest_contract_templates    force  row level security;
alter table public.booking_contract_signatures enable row level security;
alter table public.booking_contract_signatures force  row level security;
alter table public.booking_guest_confirmations enable row level security;
alter table public.booking_guest_confirmations force  row level security;
alter table public.booking_guest_details       enable row level security;
alter table public.booking_guest_details       force  row level security;
alter table public.guest_requests              enable row level security;
alter table public.guest_requests              force  row level security;
alter table public.guest_link_sends            enable row level security;
alter table public.guest_link_sends            force  row level security;
alter table public.booking_guest_journey       enable row level security;
alter table public.booking_guest_journey       force  row level security;

revoke all on public.guest_journey_settings      from anon, authenticated;
revoke all on public.guest_journey_content       from anon, authenticated;
revoke all on public.guest_contract_templates    from anon, authenticated;
revoke all on public.booking_contract_signatures from anon, authenticated;
revoke all on public.booking_guest_confirmations from anon, authenticated;
revoke all on public.booking_guest_details       from anon, authenticated;
revoke all on public.guest_requests              from anon, authenticated;
revoke all on public.guest_link_sends            from anon, authenticated;
revoke all on public.booking_guest_journey       from anon, authenticated;

grant select, insert, update, delete on public.guest_journey_settings      to authenticated;
grant select, insert, update, delete on public.guest_journey_content       to authenticated;
grant select, insert, update, delete on public.guest_contract_templates    to authenticated;
grant select, update                 on public.booking_contract_signatures to authenticated;
grant select, update                 on public.booking_guest_confirmations to authenticated;
grant select                         on public.booking_guest_details       to authenticated;
grant select, update                 on public.guest_requests              to authenticated;
grant select, insert                 on public.guest_link_sends            to authenticated;
grant select, insert, update         on public.booking_guest_journey       to authenticated;

grant select, insert, update, delete on public.guest_journey_settings      to service_role;
grant select, insert, update, delete on public.guest_journey_content       to service_role;
grant select, insert, update, delete on public.guest_contract_templates    to service_role;
grant select                         on public.booking_contract_signatures to service_role;
grant select                         on public.booking_guest_confirmations to service_role;
grant select                         on public.booking_guest_details       to service_role;
grant select, update                 on public.guest_requests              to service_role;
grant select                         on public.guest_link_sends            to service_role;
grant select, insert, update         on public.booking_guest_journey       to service_role;

-- Supabase hands `service_role` everything on a new table by default, and it
-- carries BYPASSRLS. Taking these back is what makes the append-only guarantees
-- above true for a background job as well as for a person — and
-- `booking_contract_signatures` is the one that matters most, because a
-- signature a job could rewrite is not evidence of anything.
revoke insert, update, delete, truncate on public.booking_contract_signatures from service_role;
revoke insert, update, delete, truncate on public.booking_guest_confirmations from service_role;
revoke insert, update, delete, truncate on public.booking_guest_details       from service_role;
revoke insert, delete, truncate         on public.guest_requests              from service_role;
revoke update, delete, truncate         on public.guest_link_sends            from service_role;
revoke delete, truncate                 on public.booking_guest_journey       from service_role;

-- INSERT on the three guest-written tables is withheld from `authenticated`
-- too, and that is the point rather than an oversight: a confirmation, a
-- signature and a set of details are things a GUEST did. A member of staff who
-- could insert one could manufacture a guest's consent from an office chair.
-- The definer functions in §10 are the only writers, and §14 asserts it.


-- ── Policies · configuration ────────────────────────────────────────────────
-- Read on `booking.view`: anybody who works a booking has to be able to see
-- what its guest is being asked for. Write on the grant that already owns the
-- thing being configured — the organization's settings, the property's content,
-- the message templates — rather than on a new permission, because a second
-- name for a right somebody already holds is a right that can be revoked in one
-- place and kept in the other.

drop policy if exists guest_journey_settings_select on public.guest_journey_settings;
create policy guest_journey_settings_select on public.guest_journey_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists guest_journey_settings_write on public.guest_journey_settings;
create policy guest_journey_settings_write on public.guest_journey_settings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'organization.settings.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

drop policy if exists guest_journey_content_select on public.guest_journey_content;
create policy guest_journey_content_select on public.guest_journey_content
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists guest_journey_content_write on public.guest_journey_content;
create policy guest_journey_content_write on public.guest_journey_content
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

drop policy if exists guest_contract_templates_select on public.guest_contract_templates;
create policy guest_contract_templates_select on public.guest_contract_templates
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists guest_contract_templates_write on public.guest_contract_templates;
create policy guest_contract_templates_write on public.guest_contract_templates
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'template.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'template.manage')
  );


-- ── Policies · what the guest did ───────────────────────────────────────────
-- Readable by anybody who may see the booking. Updatable only to mark something
-- superseded, which is why the UPDATE policies exist at all — and there is no
-- INSERT policy on any of the three.

drop policy if exists booking_contract_signatures_select on public.booking_contract_signatures;
create policy booking_contract_signatures_select on public.booking_contract_signatures
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists booking_contract_signatures_update on public.booking_contract_signatures;
create policy booking_contract_signatures_update on public.booking_contract_signatures
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists booking_guest_confirmations_select on public.booking_guest_confirmations;
create policy booking_guest_confirmations_select on public.booking_guest_confirmations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists booking_guest_confirmations_update on public.booking_guest_confirmations;
create policy booking_guest_confirmations_update on public.booking_guest_confirmations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  );

drop policy if exists booking_guest_details_select on public.booking_guest_details;
create policy booking_guest_details_select on public.booking_guest_details
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists guest_requests_select on public.guest_requests;
create policy guest_requests_select on public.guest_requests
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );

-- Staff may cancel a request or correct its state directly; the ordinary path
-- is the trigger in §11, which follows the task.
drop policy if exists guest_requests_update on public.guest_requests;
create policy guest_requests_update on public.guest_requests
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.update')
  );

drop policy if exists guest_link_sends_select on public.guest_link_sends;
create policy guest_link_sends_select on public.guest_link_sends
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.view')
  );

-- Sending a link to a guest is sending a message, which the catalogue already
-- separates from editing the booking.
drop policy if exists guest_link_sends_insert on public.guest_link_sends;
create policy guest_link_sends_insert on public.guest_link_sends
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.send')
  );

drop policy if exists booking_guest_journey_select on public.booking_guest_journey;
create policy booking_guest_journey_select on public.booking_guest_journey
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.view')
  );

drop policy if exists booking_guest_journey_write on public.booking_guest_journey;
create policy booking_guest_journey_write on public.booking_guest_journey
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'booking.update')
  );


-- ============================================================================
-- 13 · Who may call the functions
-- ============================================================================
-- Per 0014: a function in `public` is an API surface until its grants say
-- otherwise. `anon` holds EXECUTE on exactly the six guest-facing ones and on
-- nothing else here — and the helper that returns a whole booking row is
-- revoked from everybody, which is the line that keeps §10 safe.

revoke all on function public.guest_link_booking(text)
  from public, anon, authenticated, service_role;

revoke all on function public.guest_journey_effective_settings(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.guest_journey_effective_settings(uuid, uuid)
  to authenticated;

revoke all on function public.guest_arrival_released(
  public.bookings, public.guest_journey_settings,
  public.booking_guest_journey, boolean, boolean, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.try_cast_inet(text)
  from public, anon, authenticated, service_role;

revoke all on function public.tg_guest_request_follow_task()
  from public, anon, authenticated, service_role;

revoke all on function public.guest_portal_journey(text)
  from public, service_role;
grant execute on function public.guest_portal_journey(text)
  to anon, authenticated;

revoke all on function public.guest_portal_confirm(text, integer, text, text)
  from public, service_role;
grant execute on function public.guest_portal_confirm(text, integer, text, text)
  to anon, authenticated;

revoke all on function public.guest_portal_sign_contract(text, text, text, text, text, text)
  from public, service_role;
grant execute on function public.guest_portal_sign_contract(text, text, text, text, text, text)
  to anon, authenticated;

revoke all on function public.guest_portal_save_details(text, jsonb, boolean)
  from public, service_role;
grant execute on function public.guest_portal_save_details(text, jsonb, boolean)
  to anon, authenticated;

revoke all on function public.guest_portal_submit_request(text, text, text, text)
  from public, service_role;
grant execute on function public.guest_portal_submit_request(text, text, text, text)
  to anon, authenticated;

revoke all on function public.guest_portal_declare_checkout(text)
  from public, service_role;
grant execute on function public.guest_portal_declare_checkout(text)
  to anon, authenticated;


-- ============================================================================
-- 14 · Rehearsal
-- ============================================================================
-- Asks the live catalogue what it actually granted, rather than trusting that
-- the statements above did what they read as doing.

do $$
declare
  missing text;
begin
  -- ── The tables ─────────────────────────────────────────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('guest_journey_settings'), ('guest_journey_content'),
    ('guest_contract_templates'), ('booking_contract_signatures'),
    ('booking_guest_confirmations'), ('booking_guest_details'),
    ('guest_requests'), ('guest_link_sends'), ('booking_guest_journey')
  ) as t(name)
  where not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = t.name
  );
  if missing is not null then
    raise exception '0034 tables missing: %', missing;
  end if;

  -- ── The functions ──────────────────────────────────────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('guest_link_booking'), ('guest_journey_effective_settings'),
    ('guest_arrival_released'), ('guest_portal_journey'),
    ('guest_portal_confirm'), ('guest_portal_sign_contract'),
    ('guest_portal_save_details'), ('guest_portal_submit_request'),
    ('guest_portal_declare_checkout'), ('tg_guest_request_follow_task')
  ) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
  );
  if missing is not null then
    raise exception '0034 functions missing: %', missing;
  end if;

  -- ── The column the journey tab's one query depends on ──────────────────
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name = 'guest_link_sent_at'
  ) then
    raise exception 'bookings.guest_link_sent_at missing after 0034';
  end if;

  -- ── The trigger that keeps a guest's view of a request honest ──────────
  if not exists (
    select 1 from pg_trigger
    where tgname = 'guest_request_follows_task' and not tgisinternal
  ) then
    raise exception 'guest_request_follows_task is not installed — a guest would never see a request progress';
  end if;

  -- ── `anon` may call the six ────────────────────────────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('guest_portal_journey'), ('guest_portal_confirm'),
    ('guest_portal_sign_contract'), ('guest_portal_save_details'),
    ('guest_portal_submit_request'), ('guest_portal_declare_checkout')
  ) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  );
  if missing is not null then
    raise exception 'anon cannot execute: % — the guest journey is closed', missing;
  end if;

  -- The line that keeps §10 safe. `guest_link_booking` returns a whole bookings
  -- row; if anon could call it, every column 0033 deliberately withheld would
  -- be one RPC away.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guest_link_booking'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) then
    raise exception 'guest_link_booking is reachable from outside — it returns a whole bookings row';
  end if;

  -- ── No table in this migration is readable by anon ─────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('guest_journey_settings'), ('guest_journey_content'),
    ('guest_contract_templates'), ('booking_contract_signatures'),
    ('booking_guest_confirmations'), ('booking_guest_details'),
    ('guest_requests'), ('guest_link_sends'), ('booking_guest_journey')
  ) as t(name)
  where has_table_privilege('anon', 'public.' || t.name, 'SELECT');
  if missing is not null then
    raise exception 'anon holds SELECT on % — the definer functions are being bypassed', missing;
  end if;

  -- ── Staff cannot manufacture a guest's consent ─────────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('booking_contract_signatures'), ('booking_guest_confirmations'),
    ('booking_guest_details')
  ) as t(name)
  where has_table_privilege('authenticated', 'public.' || t.name, 'INSERT');
  if missing is not null then
    raise exception 'authenticated holds INSERT on % — a member of staff could manufacture a guest''s consent', missing;
  end if;

  -- ── RLS is on, and forced, everywhere ──────────────────────────────────
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('guest_journey_settings', 'guest_journey_content',
                      'guest_contract_templates', 'booking_contract_signatures',
                      'booking_guest_confirmations', 'booking_guest_details',
                      'guest_requests', 'guest_link_sends',
                      'booking_guest_journey')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'row level security is not forced on: %', missing;
  end if;

  -- ── And not one policy admits anon ─────────────────────────────────────
  select string_agg(p.polname, ', ') into missing
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('guest_journey_settings', 'guest_journey_content',
                      'guest_contract_templates', 'booking_contract_signatures',
                      'booking_guest_confirmations', 'booking_guest_details',
                      'guest_requests', 'guest_link_sends',
                      'booking_guest_journey')
    and exists (
      select 1 from pg_roles r
      where r.oid = any (p.polroles) and r.rolname = 'anon'
    );
  if missing is not null then
    raise exception 'a policy admits anon: % — a guest has no membership and must never get a policy', missing;
  end if;
end $$;
