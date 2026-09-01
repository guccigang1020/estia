-- ============================================================================
-- 0031_payment_collection.sql — ESTIA · what a guest must do before a booking
--                               is confirmed, and how the money actually
--                               arrives
--
-- What this closes
--   `PAYMENT_COLLECTION_POLICIES` and `CONFIRMATION_REQUIREMENTS` are frozen in
--   src/lib/contracts/states.ts and the database had never heard of either.
--   The product could therefore hold exactly one opinion about confirmation —
--   whatever the booking screen happened to do — and a business that confirms
--   by telephone and takes a bank transfer had nowhere to say so.
--
--   The majority of Israeli guesthouses are that business. So this file is
--   written around a rule that shows up in every constraint below: **manual
--   collection is first-class, and live card processing is the special case.**
--   `payment_collection_settings` defaults to policy `none` with no
--   requirements, which is a complete and legitimate configuration, not an
--   unfinished one. `live_payments_enabled` defaults to false and cannot be
--   true without a named provider — so "is there a live-payment CTA to render"
--   is a fact this schema can answer rather than something a screen guesses.
--
-- ── `payment.policy_manage` is added to the catalogue here ──────────────────
--
--   src/lib/authz/permissions.ts has carried the grant since the contracts
--   landed; `public.permissions` has not, and `role_permissions.permission_code`
--   is a foreign key onto that table. Until this file runs,
--   `has_permission(org, 'payment.policy_manage')` is false for every human
--   alive and every policy below would admit nobody. Seeded the way 0025 seeds
--   `agent.membership.manage`: one catalogue row, then the two derived roles
--   re-derived. `grantsForSystemRole()` gives it to `organization_owner` and
--   `administrator` and to nobody else, which is checked in the rehearsal.
--
--   It is deliberately not an entitlement. src/lib/plans/entitlements.ts says
--   why at length: gating this behind a `payments` package would mean a
--   customer who never takes a card cannot say how they take money.
--
-- ── Why the guest reaches this through two functions and not through RLS ────
--
--   A guest is a stranger to the organization — no account, no membership, no
--   role. Every policy in this schema is `organization_id in (select
--   public.my_organizations())`, and `my_organizations()` reads active
--   memberships. A guest has none and must not be given one.
--
--   0027 already settled the shape for exactly this problem: possession of a
--   secret, rather than a grant, decides that a row may be read or written,
--   and it happens inside a SECURITY DEFINER function whose every refusal is
--   spelled out. The secret here is `bookings.guest_token` — 32 CSPRNG bytes,
--   unique, created by 0009 precisely so that a guest portal link is a
--   capability rather than an id somebody can walk.
--
--   `guest_collection_context()` returns facts and never a decision. The
--   resolver in src/lib/payments/resolver.ts is the single place that turns
--   settings plus override plus what has been paid into "what must happen
--   next", and a second opinion computed in plpgsql is precisely the drift
--   this product has been bitten by before. The function is a reader; it does
--   not know what a policy means.
--
-- ── Money ──────────────────────────────────────────────────────────────────
--
--   Integer agorot throughout, and percentages in basis points — 3000 is 30%,
--   never 30 — matching `properties.tax_rate_bps` rather than inventing a
--   second unit for the same idea two tables apart.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0002 (permissions, roles,
--   role_permissions), 0004 (my_organizations, has_permission), 0008
--   (property_in_scope, and the composite keys below), 0009 (bookings, and
--   `guest_token` above all), 0010 (payments, payment_status, payment_method),
--   0012 (the catalogue this extends and the derivation it re-runs), 0014 (the
--   rule that a function in `public` is an API surface until its grants say
--   otherwise), 0016 (payments.captured_agorot, purpose, channel).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Types — transcribed from src/lib/contracts/states.ts
-- ============================================================================
-- Same strings, same order. That file states the rule and 0010 already follows
-- it for the payment vocabularies; these two are the same contract, arriving
-- late.

-- PAYMENT_COLLECTION_POLICIES, in order.
do $$ begin
  create type public.payment_collection_policy as enum (
    'none',
    'manual',
    'deposit',
    'full',
    'schedule',
    'after_approval',
    'custom'
  );
exception when duplicate_object then null;
end $$;

comment on type public.payment_collection_policy is
  'Transcribed from PAYMENT_COLLECTION_POLICIES in src/lib/contracts/states.ts, in the same order. `none` is a legitimate and common answer — a great many Israeli villas confirm by telephone and take the money on arrival — and no screen may treat it as unfinished configuration.';

-- CONFIRMATION_REQUIREMENTS, in order.
do $$ begin
  create type public.confirmation_requirement as enum (
    'manager_approval',
    'guest_confirmation',
    'contract_signed',
    'deposit_recorded',
    'deposit_paid_live',
    'full_payment'
  );
exception when duplicate_object then null;
end $$;

comment on type public.confirmation_requirement is
  'Transcribed from CONFIRMATION_REQUIREMENTS in src/lib/contracts/states.ts. Stored as an array rather than a single column because the real answers are combinations: "contract signed AND deposit recorded" is the common one.';

-- Not from the frozen contract, and deliberately not an extension of
-- PAYMENT_METHODS. A *channel* is what a business tells a guest to do — "bank
-- transfer to this account", "hand a cheque to the manager" — and a *method*
-- is what the payment record says money arrived as. Two of these have no
-- method of their own: a cheque is recorded as `other` and a card terminal in
-- the lobby is recorded as `card`. Widening PAYMENT_METHODS to make them line
-- up would change a frozen vocabulary that four other modules read, to record
-- a distinction only this table cares about. The mapping lives in
-- src/lib/payments/channels.ts and is asserted there.
do $$ begin
  create type public.manual_payment_channel as enum (
    'bank_transfer',
    'cash',
    'bit',
    'paybox',
    'cheque',
    'external_terminal',
    'other'
  );
exception when duplicate_object then null;
end $$;

comment on type public.manual_payment_channel is
  'How a business accepts money that moves outside the product. Deliberately not PAYMENT_METHODS: `cheque` and `external_terminal` are things a guest is asked to do, and they are recorded as the methods `other` and `card` respectively. See PAYMENT_METHOD_FOR_CHANNEL in src/lib/payments/channels.ts.';

do $$ begin
  create type public.payment_proof_review as enum (
    'pending',
    'accepted',
    'rejected'
  );
exception when duplicate_object then null;
end $$;

comment on type public.payment_proof_review is
  'Whether somebody has looked at an uploaded transfer receipt. `pending` is not a failure state — it is the ordinary condition of a proof that arrived at 23:40.';


-- ============================================================================
-- 2 · The permission
-- ============================================================================
-- Seeded before the policies below, because every one of them names it and a
-- policy referencing a permission code that is not in the catalogue admits
-- nobody at all — including the owner.

insert into public.permissions (code, kind, permission_group, is_owner_only, sort_order)
values ('payment.policy_manage', 'action'::public.permission_kind, 'finance', false, 485)
on conflict (code) do nothing;

-- The two derived roles, re-derived. 0012 explains the shape: the derivation
-- is a query over the catalogue rather than a list, so a permission added
-- today reaches both without anybody editing a file. That statement ran before
-- this row existed, so it is run again.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.organization_id is null
  and r.code = 'organization_owner'
  and p.code = 'payment.policy_manage'
  and not p.is_platform
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.organization_id is null
  and r.code = 'administrator'
  and p.code = 'payment.policy_manage'
  and not (p.is_platform or p.is_owner_only)
on conflict do nothing;


-- ============================================================================
-- 3 · payment_collection_settings — the organization's default
-- ============================================================================
-- One row per organization. The absence of a row is not an error and is not a
-- prompt: it means the defaults below, which are `none` and no requirements,
-- and the resolver treats a missing row and a default row identically.

create table if not exists public.payment_collection_settings (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,

  policy                    public.payment_collection_policy not null default 'none',
  -- An empty array means a manager's approval alone, which is the product's
  -- oldest behaviour and stays available. See CONFIRMATION_REQUIREMENTS.
  requirements              public.confirmation_requirement[] not null default '{}'::public.confirmation_requirement[],

  -- ── The deposit, when there is one ───────────────────────────────────────
  -- Basis points, matching properties.tax_rate_bps. 3000 is 30%, never 30.
  -- At most one of the two is set: "30% or ₪2,500, whichever" is a rule
  -- nobody agreed on and two columns both filled is how a screen picks the
  -- wrong one silently.
  deposit_percent_bps       integer,
  deposit_fixed_agorot      integer,
  -- How long before arrival the rest is expected. Null means "no stated
  -- deadline", which is different from zero.
  balance_due_days_before   integer,

  -- ── Live processing ──────────────────────────────────────────────────────
  -- The single fact the guest page checks before it will render a "pay now"
  -- button. Never a credential: the provider's keys live in the secret store,
  -- and this column holds only the provider's name so that the product can
  -- say "no provider is configured" without reading a secret to find out.
  live_payments_enabled     boolean not null default false,
  live_provider             text,

  -- Free text shown to the guest above whatever action the policy calls for.
  guest_instructions        text,

  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  constraint payment_collection_settings_organization_key unique (organization_id),

  constraint payment_collection_settings_percent_range check (
    deposit_percent_bps is null
    or (deposit_percent_bps > 0 and deposit_percent_bps <= 10000)
  ),
  constraint payment_collection_settings_fixed_positive check (
    deposit_fixed_agorot is null or deposit_fixed_agorot > 0
  ),
  -- One shape of deposit or the other, never both.
  constraint payment_collection_settings_deposit_single check (
    deposit_percent_bps is null or deposit_fixed_agorot is null
  ),
  -- A deposit policy that names no deposit is a screen that asks the guest for
  -- an unspecified amount of money.
  constraint payment_collection_settings_deposit_stated check (
    policy <> 'deposit'::public.payment_collection_policy
    or deposit_percent_bps is not null
    or deposit_fixed_agorot is not null
  ),
  constraint payment_collection_settings_due_days_range check (
    balance_due_days_before is null
    or (balance_due_days_before >= 0 and balance_due_days_before <= 365)
  ),
  -- Live payments switched on with nothing behind them is the exact state the
  -- guest page must never see, because it would render a CTA that leads
  -- nowhere.
  constraint payment_collection_settings_provider_present check (
    not live_payments_enabled or (live_provider is not null and length(btrim(live_provider)) > 0)
  ),
  constraint payment_collection_settings_provider_not_blank check (
    live_provider is null or length(btrim(live_provider)) > 0
  ),
  constraint payment_collection_settings_version_positive check (version >= 1)
);

comment on table public.payment_collection_settings is
  'The organization default for what a guest must do before a booking is confirmed. One row per organization; no row means the column defaults, which are policy `none` and no requirements — a complete configuration, not an unfinished one.';
comment on column public.payment_collection_settings.live_payments_enabled is
  'Whether a live-payment call to action may be rendered at all. False by default and constrained to require a named provider, so a guest page can answer "is there anywhere to send this person" from one boolean instead of guessing.';
comment on column public.payment_collection_settings.live_provider is
  'The provider name, and never a credential. Keys belong in the secret store; this column exists so the product can say "no provider is configured" without reading one.';
comment on column public.payment_collection_settings.deposit_percent_bps is
  'Basis points. 3000 is 30%, never 30 — the same unit as properties.tax_rate_bps, because two units for one idea is how a deposit gets collected at a hundredth of its rate.';

drop trigger if exists payment_collection_settings_touch on public.payment_collection_settings;
create trigger payment_collection_settings_touch
  before update on public.payment_collection_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · payment_collection_overrides — this booking is different
-- ============================================================================
-- The default may be a 30% deposit and this booking may be "no deposit, the
-- manager approved it". That is ordinary — a returning family, a corporate
-- account, a friend of the owner — and a product that cannot express it sends
-- the negotiation to WhatsApp, where the sale leaves the system.
--
-- One row per booking. The history of who changed it and to what lives in
-- `audit_events`, which is the one place in this product that keeps before and
-- after with an actor and a reason; a second history here would be a second
-- answer to the same question.

create table if not exists public.payment_collection_overrides (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null,
  property_id               uuid not null,
  booking_id                uuid not null,

  policy                    public.payment_collection_policy not null,
  requirements              public.confirmation_requirement[] not null default '{}'::public.confirmation_requirement[],
  deposit_percent_bps       integer,
  deposit_fixed_agorot      integer,
  balance_due_days_before   integer,

  -- Not nullable, and checked for content. An override with no stated reason
  -- is an unexplained discount on the record of a booking somebody will one
  -- day be asked about.
  reason                    text not null,

  set_by                    uuid references auth.users (id) on delete set null,
  set_at                    timestamptz not null default now(),

  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  -- One foreign key, three facts: the booking exists, it is in this property,
  -- and that property is in this organization.
  constraint payment_collection_overrides_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,

  constraint payment_collection_overrides_booking_key unique (booking_id),

  constraint payment_collection_overrides_reason_stated check (
    length(btrim(reason)) >= 3
  ),
  constraint payment_collection_overrides_percent_range check (
    deposit_percent_bps is null
    or (deposit_percent_bps > 0 and deposit_percent_bps <= 10000)
  ),
  constraint payment_collection_overrides_fixed_positive check (
    deposit_fixed_agorot is null or deposit_fixed_agorot > 0
  ),
  constraint payment_collection_overrides_deposit_single check (
    deposit_percent_bps is null or deposit_fixed_agorot is null
  ),
  constraint payment_collection_overrides_deposit_stated check (
    policy <> 'deposit'::public.payment_collection_policy
    or deposit_percent_bps is not null
    or deposit_fixed_agorot is not null
  ),
  constraint payment_collection_overrides_due_days_range check (
    balance_due_days_before is null
    or (balance_due_days_before >= 0 and balance_due_days_before <= 365)
  ),
  constraint payment_collection_overrides_version_positive check (version >= 1)
);

comment on table public.payment_collection_overrides is
  'What this one booking asks of its guest, when it is not what the organization asks of everybody. One row per booking; the history of changes is audit_events, which already keeps actor, before, after and reason together.';
comment on column public.payment_collection_overrides.reason is
  'Required and checked for content. An override with no reason is an unexplained exception on a booking somebody will be asked about later.';

create index if not exists payment_collection_overrides_organization_idx
  on public.payment_collection_overrides (organization_id, set_at desc);

drop trigger if exists payment_collection_overrides_touch on public.payment_collection_overrides;
create trigger payment_collection_overrides_touch
  before update on public.payment_collection_overrides
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · payment_manual_channels — how money actually arrives
-- ============================================================================
-- Not a fallback. Bank transfer, Bit and cash are how most of the businesses
-- this product is for are paid, and the instruction text is the part that does
-- the work: an IBAN, a phone number for Bit, "ask for Dana at the desk".

create table if not exists public.payment_manual_channels (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,

  channel             public.manual_payment_channel not null,
  enabled             boolean not null default true,
  -- What the guest is called on to see. Null means the channel's own Hebrew
  -- name from src/lib/payments/channels.ts, which is the right default and is
  -- not copied into every row.
  display_name        text,
  -- The account number, the Bit phone, the name to ask for. This is the whole
  -- point of the row.
  instructions        text,
  sort_order          integer not null default 0,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint payment_manual_channels_unique unique (organization_id, channel),
  constraint payment_manual_channels_display_not_blank check (
    display_name is null or length(btrim(display_name)) > 0
  ),
  -- An enabled channel with no instructions tells the guest to pay and not
  -- where. Refused at the floor rather than caught by a form, because the
  -- guest page renders whatever is here.
  constraint payment_manual_channels_instructions_present check (
    not enabled
    or channel = 'cash'::public.manual_payment_channel
    or (instructions is not null and length(btrim(instructions)) > 0)
  ),
  constraint payment_manual_channels_version_positive check (version >= 1)
);

comment on table public.payment_manual_channels is
  'The channels a business accepts money through outside the product, with the instruction text a guest is actually shown. First-class rather than a fallback: bank transfer, Bit and cash are how most Israeli guesthouses are paid.';
comment on constraint payment_manual_channels_instructions_present on public.payment_manual_channels is
  'An enabled channel must say where the money goes. `cash` is exempt because "cash on arrival" needs no account number.';

create index if not exists payment_manual_channels_organization_idx
  on public.payment_manual_channels (organization_id, sort_order, channel);

drop trigger if exists payment_manual_channels_touch on public.payment_manual_channels;
create trigger payment_manual_channels_touch
  before update on public.payment_manual_channels
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · payment_proofs — the screenshot of the transfer
-- ============================================================================
-- This product has no file storage layer. Rather than invent half of one, the
-- table stores a reference and nothing else: `storage_key` is opaque here and
-- is interpreted by whatever implements the `ProofStorage` port declared in
-- src/lib/payments/storage.ts. The size, the type and the digest are recorded
-- because they are what a person needs to decide whether the thing at the
-- other end of the key is the thing that was uploaded.
--
-- No bytes are stored in Postgres. A receipt is a photograph and a bytea
-- column would put a megabyte of JPEG behind every row of a table the finance
-- screen lists.

create table if not exists public.payment_proofs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  property_id         uuid not null,
  booking_id          uuid not null,

  storage_key         text not null,
  file_name           text not null,
  content_type        text not null,
  byte_size           integer not null,
  -- Hex sha-256 where the uploader computed one. Optional because a guest's
  -- browser may not have, and refusing the receipt over a missing digest is
  -- worse than accepting it without.
  checksum_sha256     text,

  -- True when this arrived through the guest link rather than from a member of
  -- staff. Kept explicit rather than inferred from a null actor, because
  -- "nobody recorded who" and "the guest did" are different facts.
  submitted_by_guest  boolean not null default true,
  submitted_by        uuid references auth.users (id) on delete set null,
  submitted_at        timestamptz not null default now(),
  note                text,

  review              public.payment_proof_review not null default 'pending',
  reviewed_at         timestamptz,
  reviewed_by         uuid references auth.users (id) on delete set null,
  review_note         text,

  -- Set when somebody records the payment this proof is evidence for. Nullable
  -- forever: a rejected proof never gets one.
  payment_id          uuid,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint payment_proofs_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,
  constraint payment_proofs_payment_fkey
    foreign key (payment_id, organization_id)
    references public.payments (id, organization_id) on delete set null,

  -- The same file uploaded twice through a retried request is one proof.
  constraint payment_proofs_storage_key_unique unique (organization_id, storage_key),

  constraint payment_proofs_storage_key_not_blank check (length(btrim(storage_key)) > 0),
  constraint payment_proofs_file_name_not_blank check (length(btrim(file_name)) > 0),
  constraint payment_proofs_content_type_not_blank check (length(btrim(content_type)) > 0),
  -- 20 MB. A photograph of a bank screen is under two.
  constraint payment_proofs_byte_size_range check (byte_size > 0 and byte_size <= 20971520),
  constraint payment_proofs_checksum_format check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  -- A guest submission has no user behind it, and a staff submission does.
  constraint payment_proofs_submitter_consistent check (
    (submitted_by_guest and submitted_by is null)
    or (not submitted_by_guest and submitted_by is not null)
  ),
  -- A decided proof has a moment and a decider.
  constraint payment_proofs_review_stamped check (
    review = 'pending'::public.payment_proof_review
    or (reviewed_at is not null and reviewed_by is not null)
  ),
  constraint payment_proofs_version_positive check (version >= 1)
);

comment on table public.payment_proofs is
  'A guest uploading evidence that a transfer landed. Stores a reference and never the bytes: `storage_key` is opaque here and is interpreted by whatever implements the ProofStorage port in src/lib/payments/storage.ts.';
comment on column public.payment_proofs.storage_key is
  'Opaque to this schema. There is no file storage layer in this product yet; the port is declared in TypeScript and this column is the only thing the database needs to know about it.';
comment on column public.payment_proofs.submitted_by_guest is
  'Explicit rather than inferred from a null actor: "the guest uploaded this" and "nobody recorded who uploaded this" are different facts and only one of them is fine.';

create index if not exists payment_proofs_booking_idx
  on public.payment_proofs (booking_id, submitted_at desc);
create index if not exists payment_proofs_pending_idx
  on public.payment_proofs (organization_id, submitted_at desc)
  where review = 'pending'::public.payment_proof_review;

drop trigger if exists payment_proofs_touch on public.payment_proofs;
create trigger payment_proofs_touch
  before update on public.payment_proofs
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · Row level security
-- ============================================================================

alter table public.payment_collection_settings  enable row level security;
alter table public.payment_collection_settings  force  row level security;
alter table public.payment_collection_overrides enable row level security;
alter table public.payment_collection_overrides force  row level security;
alter table public.payment_manual_channels      enable row level security;
alter table public.payment_manual_channels      force  row level security;
alter table public.payment_proofs               enable row level security;
alter table public.payment_proofs               force  row level security;

revoke all on public.payment_collection_settings  from anon, authenticated;
revoke all on public.payment_collection_overrides from anon, authenticated;
revoke all on public.payment_manual_channels      from anon, authenticated;
revoke all on public.payment_proofs               from anon, authenticated;

grant select, insert, update on public.payment_collection_settings  to authenticated;
grant select, insert, update, delete on public.payment_collection_overrides to authenticated;
grant select, insert, update, delete on public.payment_manual_channels to authenticated;
grant select, insert, update on public.payment_proofs to authenticated;

grant select, insert, update on public.payment_collection_settings  to service_role;
grant select, insert, update, delete on public.payment_collection_overrides to service_role;
grant select, insert, update, delete on public.payment_manual_channels to service_role;
grant select, insert, update on public.payment_proofs to service_role;

-- Two DELETEs are granted and two are not, and the difference is what the row
-- means. Removing an override restores the organization default and removing a
-- channel stops offering it — both are the honest way to undo the thing. A
-- settings row is one per organization and is edited, never removed. A proof
-- is evidence: it is rejected, which is a state with a date and a decider.
revoke delete, truncate on public.payment_collection_settings from service_role;
revoke delete, truncate on public.payment_proofs              from service_role;


-- ── payment_collection_settings ─────────────────────────────────────────────
-- Readable by anybody in the organization, because every screen that says
-- whether a booking is confirmed has to be able to say why, and the reason is
-- this row. Writable only with `payment.policy_manage`.

drop policy if exists payment_collection_settings_select on public.payment_collection_settings;
create policy payment_collection_settings_select on public.payment_collection_settings
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists payment_collection_settings_insert on public.payment_collection_settings;
create policy payment_collection_settings_insert on public.payment_collection_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  );

drop policy if exists payment_collection_settings_update on public.payment_collection_settings;
create policy payment_collection_settings_update on public.payment_collection_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  );


-- ── payment_collection_overrides ────────────────────────────────────────────
-- Scoped by property as well as by tenant: a member narrowed to one property
-- has no business reading the exceptions granted on another's bookings.

drop policy if exists payment_collection_overrides_select on public.payment_collection_overrides;
create policy payment_collection_overrides_select on public.payment_collection_overrides
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists payment_collection_overrides_insert on public.payment_collection_overrides;
create policy payment_collection_overrides_insert on public.payment_collection_overrides
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.policy_manage')
  );

drop policy if exists payment_collection_overrides_update on public.payment_collection_overrides;
create policy payment_collection_overrides_update on public.payment_collection_overrides
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.policy_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.policy_manage')
  );

drop policy if exists payment_collection_overrides_delete on public.payment_collection_overrides;
create policy payment_collection_overrides_delete on public.payment_collection_overrides
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.policy_manage')
  );


-- ── payment_manual_channels ─────────────────────────────────────────────────

drop policy if exists payment_manual_channels_select on public.payment_manual_channels;
create policy payment_manual_channels_select on public.payment_manual_channels
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists payment_manual_channels_insert on public.payment_manual_channels;
create policy payment_manual_channels_insert on public.payment_manual_channels
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  );

drop policy if exists payment_manual_channels_update on public.payment_manual_channels;
create policy payment_manual_channels_update on public.payment_manual_channels
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  );

drop policy if exists payment_manual_channels_delete on public.payment_manual_channels;
create policy payment_manual_channels_delete on public.payment_manual_channels
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.policy_manage')
  );


-- ── payment_proofs ──────────────────────────────────────────────────────────
-- Reading a receipt means reading a guest's bank details, so `payment.view`
-- and property scope, not mere membership. The guest's own upload does not
-- come through here at all — see §8.

drop policy if exists payment_proofs_select on public.payment_proofs;
create policy payment_proofs_select on public.payment_proofs
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.view')
  );

-- Staff uploading on a guest's behalf — the transfer that arrived by email to
-- the office. `submitted_by_guest` must be false and the actor must be
-- themselves, so a staff upload can never be laundered into "the guest sent
-- this".
drop policy if exists payment_proofs_insert on public.payment_proofs;
create policy payment_proofs_insert on public.payment_proofs
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
    and submitted_by_guest = false
    and submitted_by = (select auth.uid())
  );

drop policy if exists payment_proofs_update on public.payment_proofs;
create policy payment_proofs_update on public.payment_proofs
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  );


-- ============================================================================
-- 8 · The guest, who is a stranger
-- ============================================================================
-- 0027's shape, for 0027's reason: the guest has no membership, must not be
-- given one, and holds a secret instead. Both functions take the token and
-- nothing else that identifies a booking, so there is no id to walk.
--
-- Neither function trusts the caller for the organization, the property or the
-- booking. All three are read from the token's own row.

create or replace function public.guest_collection_context(p_guest_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking   record;
  v_settings  jsonb;
  v_override  jsonb;
  v_channels  jsonb;
  v_payments  jsonb;
begin
  if p_guest_token is null or length(btrim(p_guest_token)) = 0 then
    raise exception 'guest token missing'
      using errcode = '22023',
            hint = 'הקישור אינו תקין. בקש מבית האירוח קישור חדש.';
  end if;

  select b.id, b.organization_id, b.property_id, b.status, b.reference,
         b.check_in, b.check_out, b.currency, b.total_agorot, b.deleted_at
    into v_booking
    from public.bookings b
   where b.guest_token = p_guest_token;

  -- One refusal for "no such token" and for "the booking was deleted", because
  -- telling them apart tells a stranger which tokens exist.
  if not found or v_booking.deleted_at is not null then
    raise exception 'guest token not recognised'
      using errcode = '22023',
            hint = 'הקישור אינו תקין או שההזמנה כבר אינה פעילה.';
  end if;

  select to_jsonb(s) - 'metadata' - 'created_by' - 'updated_by'
    into v_settings
    from public.payment_collection_settings s
   where s.organization_id = v_booking.organization_id;

  select to_jsonb(o) - 'metadata' - 'created_by' - 'updated_by' - 'set_by'
    into v_override
    from public.payment_collection_overrides o
   where o.booking_id = v_booking.id;

  -- Only the enabled ones, and only the fields a guest is shown. An internal
  -- note on a disabled channel is not the guest's business.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'channel', c.channel,
               'display_name', c.display_name,
               'instructions', c.instructions,
               'sort_order', c.sort_order
             )
             order by c.sort_order, c.channel
           ),
           '[]'::jsonb
         )
    into v_channels
    from public.payment_manual_channels c
   where c.organization_id = v_booking.organization_id
     and c.enabled;

  -- What has been collected, as three integers. Not the payment rows: a guest
  -- does not need the payer name on somebody else's instalment, the provider
  -- reference or the failure code.
  select jsonb_build_object(
           'captured_agorot', coalesce(sum(p.captured_agorot), 0),
           'refunded_agorot', coalesce(sum(p.amount_refunded_agorot), 0),
           'proof_count', (
             select count(*) from public.payment_proofs pp
              where pp.booking_id = v_booking.id
           )
         )
    into v_payments
    from public.payments p
   where p.booking_id = v_booking.id;

  return jsonb_build_object(
    'booking', jsonb_build_object(
      'id', v_booking.id,
      'reference', v_booking.reference,
      'status', v_booking.status,
      'check_in', v_booking.check_in,
      'check_out', v_booking.check_out,
      'currency', v_booking.currency,
      'total_agorot', v_booking.total_agorot
    ),
    'settings', coalesce(v_settings, 'null'::jsonb),
    'override', coalesce(v_override, 'null'::jsonb),
    'channels', v_channels,
    'collected', v_payments
  );
end $$;

comment on function public.guest_collection_context(text) is
  'Everything the guest portal needs to decide what to show, and no decision. The resolver in src/lib/payments/resolver.ts is the single place that turns these facts into "what must happen next"; a second opinion computed here is exactly the drift the one-resolver rule exists to stop.';


create or replace function public.submit_payment_proof(
  p_guest_token   text,
  p_storage_key   text,
  p_file_name     text,
  p_content_type  text,
  p_byte_size     integer,
  p_note          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking record;
  v_id      uuid;
begin
  if p_guest_token is null or length(btrim(p_guest_token)) = 0 then
    raise exception 'guest token missing'
      using errcode = '22023',
            hint = 'הקישור אינו תקין. בקש מבית האירוח קישור חדש.';
  end if;

  select b.id, b.organization_id, b.property_id, b.deleted_at
    into v_booking
    from public.bookings b
   where b.guest_token = p_guest_token;

  if not found or v_booking.deleted_at is not null then
    raise exception 'guest token not recognised'
      using errcode = '22023',
            hint = 'הקישור אינו תקין או שההזמנה כבר אינה פעילה.';
  end if;

  -- The organization, the property and the booking come from the token's row
  -- and never from an argument. A guest cannot attach a receipt to somebody
  -- else's stay because there is no parameter with which to try.
  insert into public.payment_proofs (
    organization_id, property_id, booking_id,
    storage_key, file_name, content_type, byte_size,
    submitted_by_guest, submitted_by, note
  )
  values (
    v_booking.organization_id, v_booking.property_id, v_booking.id,
    btrim(p_storage_key), btrim(p_file_name), btrim(p_content_type), p_byte_size,
    true, null, nullif(btrim(coalesce(p_note, '')), '')
  )
  -- A retried upload of the same object is one proof. Returning the existing
  -- id rather than raising is what makes the guest's second tap harmless.
  on conflict (organization_id, storage_key) do update
     set updated_at = now()
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'booking_id', v_booking.id);
end $$;

comment on function public.submit_payment_proof(text, text, text, text, integer, text) is
  'A guest attaching evidence that a transfer landed. The organization, property and booking are read from the token row and are not parameters, so there is nothing to point at another guest stay. Idempotent on the storage key: a retried upload is one proof.';


-- ── Who may call them ───────────────────────────────────────────────────────
-- 0014's rule. Supabase grants EXECUTE on a new function in `public` to
-- `anon`, `authenticated` and `service_role` individually, and REVOKE FROM
-- PUBLIC does not take those back.
--
-- `anon` keeps both, and that is the whole point: a guest holding a link has
-- no account, and requiring one would mean asking somebody to register before
-- they can be told where to send a bank transfer. The token is the
-- authorization, exactly as the invitation token is in 0027 — with the
-- difference that these two functions read and write one booking's own rows
-- and cannot grant anybody access to anything.
--
-- `service_role` loses both. Nothing on the server acts as a guest, and a
-- background job that wanted these facts can read the tables directly.

revoke all on function public.guest_collection_context(text)
  from public, service_role;
grant execute on function public.guest_collection_context(text) to anon, authenticated;

revoke all on function public.submit_payment_proof(text, text, text, text, integer, text)
  from public, service_role;
grant execute on function public.submit_payment_proof(text, text, text, text, integer, text)
  to anon, authenticated;


-- ============================================================================
-- 9 · Rehearsal
-- ============================================================================
-- The shape 0026 and 0027 use: assert what this migration assumed, so a schema
-- that has drifted fails here rather than on the evening a guest opens a link.

do $$
declare
  missing text;
  n       integer;
begin
  -- The tables this file depends on, and the four it creates.
  select string_agg(name, ', ') into missing
  from (values
    ('organizations'), ('bookings'), ('payments'), ('permissions'),
    ('roles'), ('role_permissions'),
    ('payment_collection_settings'), ('payment_collection_overrides'),
    ('payment_manual_channels'), ('payment_proofs')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
    where n2.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0031: %', missing;
  end if;

  -- The four enums, with the exact members the contracts freeze. A silent
  -- divergence here is a value the application can hold and the database
  -- cannot store.
  if (select array_agg(e.enumlabel order by e.enumsortorder)
        from pg_enum e join pg_type t on t.oid = e.enumtypid
        join pg_namespace n2 on n2.oid = t.typnamespace
       where n2.nspname = 'public' and t.typname = 'payment_collection_policy')
     is distinct from
     array['none','manual','deposit','full','schedule','after_approval','custom']::name[]
  then
    raise exception 'payment_collection_policy does not match PAYMENT_COLLECTION_POLICIES';
  end if;

  if (select array_agg(e.enumlabel order by e.enumsortorder)
        from pg_enum e join pg_type t on t.oid = e.enumtypid
        join pg_namespace n2 on n2.oid = t.typnamespace
       where n2.nspname = 'public' and t.typname = 'confirmation_requirement')
     is distinct from
     array['manager_approval','guest_confirmation','contract_signed',
           'deposit_recorded','deposit_paid_live','full_payment']::name[]
  then
    raise exception 'confirmation_requirement does not match CONFIRMATION_REQUIREMENTS';
  end if;

  if (select array_agg(e.enumlabel order by e.enumsortorder)
        from pg_enum e join pg_type t on t.oid = e.enumtypid
        join pg_namespace n2 on n2.oid = t.typnamespace
       where n2.nspname = 'public' and t.typname = 'manual_payment_channel')
     is distinct from
     array['bank_transfer','cash','bit','paybox','cheque','external_terminal','other']::name[]
  then
    raise exception 'manual_payment_channel does not match MANUAL_PAYMENT_CHANNELS';
  end if;

  -- The permission exists and reached exactly the two roles the engine gives
  -- it to. Too few and the settings screen admits nobody; too many and the
  -- database is more generous than grantsForSystemRole(), which is the
  -- dangerous direction.
  if not exists (
    select 1 from public.permissions where code = 'payment.policy_manage'
  ) then
    raise exception 'payment.policy_manage is not in the permission catalogue';
  end if;

  select count(*) into n
    from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
   where rp.permission_code = 'payment.policy_manage'
     and r.organization_id is null
     and r.is_system;

  if n <> 2 then
    raise exception
      'payment.policy_manage is held by % system roles, expected 2 (organization_owner, administrator)', n;
  end if;

  select string_agg(r.code, ', ' order by r.code) into missing
    from public.roles r
   where r.organization_id is null
     and r.is_system
     and r.code in ('organization_owner', 'administrator')
     and not exists (
       select 1 from public.role_permissions rp
        where rp.role_id = r.id
          and rp.permission_code = 'payment.policy_manage'
     );

  if missing is not null then
    raise exception 'payment.policy_manage did not reach: %', missing;
  end if;

  -- Row level security is on, and forced, on all four. `force` matters because
  -- the tables are owned by the migration role, and an owner is exempt from
  -- its own policies without it.
  select string_agg(c.relname, ', ' order by c.relname) into missing
    from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
   where n2.nspname = 'public'
     and c.relname in ('payment_collection_settings', 'payment_collection_overrides',
                       'payment_manual_channels', 'payment_proofs')
     and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception 'row level security is not enabled and forced on: %', missing;
  end if;

  -- `anon` must not reach the tables. It reaches the two functions and nothing
  -- else, which is the entire guest surface.
  select string_agg(t.name, ', ') into missing
  from (values
    ('payment_collection_settings'), ('payment_collection_overrides'),
    ('payment_manual_channels'), ('payment_proofs')
  ) as t(name)
  where has_table_privilege('anon', 'public.' || t.name, 'SELECT')
     or has_table_privilege('anon', 'public.' || t.name, 'INSERT')
     or has_table_privilege('anon', 'public.' || t.name, 'UPDATE')
     or has_table_privilege('anon', 'public.' || t.name, 'DELETE');

  if missing is not null then
    raise exception 'anon still holds table privileges on: %', missing;
  end if;

  -- And the guest surface exists at all. A rename in one half and not the
  -- other is how the portal renders instructions it cannot then accept a
  -- receipt against.
  select string_agg(name, ', ') into missing
  from (values ('guest_collection_context'), ('submit_payment_proof')) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname = 'public' and p.proname = f.name
  );

  if missing is not null then
    raise exception '0031 functions missing: %', missing;
  end if;

  -- The columns the resolver reads by name. A rename that a `select *` would
  -- have hidden fails here instead.
  select string_agg(t.tbl || '.' || t.col, ', ') into missing
  from (values
    ('payment_collection_settings', 'policy'),
    ('payment_collection_settings', 'requirements'),
    ('payment_collection_settings', 'deposit_percent_bps'),
    ('payment_collection_settings', 'deposit_fixed_agorot'),
    ('payment_collection_settings', 'live_payments_enabled'),
    ('payment_collection_settings', 'live_provider'),
    ('payment_collection_overrides', 'policy'),
    ('payment_collection_overrides', 'requirements'),
    ('payment_collection_overrides', 'reason'),
    ('payment_manual_channels', 'channel'),
    ('payment_manual_channels', 'instructions'),
    ('payment_proofs', 'storage_key'),
    ('payment_proofs', 'review')
  ) as t(tbl, col)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col
  );

  if missing is not null then
    raise exception '0031 columns missing: %', missing;
  end if;
end $$;
