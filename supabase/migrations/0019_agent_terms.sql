-- ============================================================================
-- 0019_agent_terms.sql — ESTIA · what an agent *is*, inside one organization
--
-- What this does
--   Two tables the agent domain has been carrying in its head:
--
--     1. `agent_organization_settings` — the commercial terms of one agent in
--        one organization. `memberships` holds the relationship and none of
--        the terms, so `AgentSettingsStore` in src/lib/agents/repository.ts has
--        four methods and no storage, and all four raise
--        SchemaNotProvisionedError.
--     2. `agent_invitations` — an agent invited by telephone number who has not
--        accepted yet.
--
-- ── Why the ladders are columns and not one jsonb blob ──────────────────────
--
--   `AgentAccess` in src/lib/agents/access.ts is a discriminated union, and the
--   thing that makes it a union rather than five loose fields is a rule
--   crossing the ladders:
--
--     · below the price rung of the calendar ladder, the price level must be
--       `none`; from that rung upward it must not be;
--     · guest data is a question only at the booking rung;
--     · amendments, cancellation and a payment link exist only at the booking
--       rung — the type says `?: never` below it, and the header explains that
--       omission would not have been enough.
--
--   Every one of those is a CHECK constraint over enumerated scalars. Held as
--   jsonb they would be a shape nothing enforces, and the first incoherent
--   combination — `calendar: 'availability'` beside `price: 'net'` — is an
--   agent shown the rate the owner actually receives. The columns are also the
--   ones a business genuinely queries: "which of my agents can see net rates"
--   is a report, not a blob scan.
--
--   `rule` on `agent_commission_rules` is jsonb for the opposite reason — a
--   tiered rule is an open-ended structure with no fixed arity. The ladders
--   have exactly five positions and three positions and four positions.
--
-- ── The one field deliberately not stored ───────────────────────────────────
--
--   `AgentOrganizationSettings.status` is a `MembershipStatus`, and it is
--   **not a column here**. It belongs to `memberships`, and that is where it
--   stays. A copy would be a second answer to "is this agent active", the two
--   would disagree the first day somebody was suspended through the team
--   screen, and the disagreement would be an outsider still holding live
--   inventory access. It is the same argument 0010 makes for keeping payment
--   state out of `invoices` and the one src/lib/persistence/agents.ts makes
--   for refusing a second hold ledger.
--
--   The row therefore names its membership through a composite foreign key on
--   `(membership_id, organization_id, agent_user_id)`, so the terms cannot
--   point at a membership belonging to a different person or a different
--   tenant, and the adapter reads the status by embedding that membership.
--
-- ── Why `agent_invitations` is a table and not columns on `invitations` ─────
--
--   They share a word and almost nothing else.
--
--     · **Different identity.** `invitations.email` is `citext NOT NULL` with a
--       format CHECK and a live-uniqueness index on
--       `(organization_id, email)`. An agent is identified by a phone number —
--       src/lib/agents/phone.ts exists to say so at length — and an agent
--       invitation frequently has no email at all. Extending the table means
--       making `email` nullable, which removes a guarantee every existing
--       caller of `invitations` relies on, and re-partitioning its uniqueness
--       index around a column that is null for half the rows.
--     · **Different grant.** `invitations.role_id` is `NOT NULL` and points at
--       a role. An `AgentInvitation` grants two *ladders*, chosen before the
--       person accepts, and no role at all. Storing a ladder in a role column
--       is not possible; adding seven ladder columns to `invitations` makes
--       them meaningless for every ordinary staff invitation in the table.
--     · **Different delivery.** `invitations.token_hash` is `NOT NULL` and
--       `UNIQUE`: a staff invitation is a link. An agent invitation is an SMS
--       or WhatsApp message to the identity key, and the login code that
--       follows goes to the same number — there is no token to hash. A
--       `NOT NULL UNIQUE` column would have to be filled with something
--       invented.
--     · **Different outcome vocabulary.** `invitations` records the outcome as
--       two nullable timestamps with a single-outcome CHECK. `AgentInvitation`
--       has an explicit four-value `status`, including `expired`, which is a
--       state the timestamp pair cannot express at all.
--
--   Four `NOT NULL` columns would have to be weakened and seven added, and
--   roughly half of the resulting table would be conditionally meaningful. A
--   row where half the columns only apply sometimes is the shape that produces
--   a quietly wrong answer — here, an invitation read back with an invented
--   access ladder, and an agent arriving holding permissions nobody granted.
--
-- Depends on
--   0001 (organizations, memberships, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units), 0012 (agent.view, agent.invite,
--   agent.manage, agent.scope.manage, agent_limits.manage), 0015 (agencies).
--
-- Followed by
--   0020_phone_identity.sql, which adds the lookup that finds the person
--   behind the number an invitation is addressed to.
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- Types — transcribed from src/lib/authz/roles.ts and src/lib/agents/access.ts
-- ============================================================================

-- CALENDAR_LEVELS.
do $$ begin
  create type public.agent_calendar_level as enum (
    'none',
    'availability',
    'availability_price',
    'availability_hold',
    'availability_booking'
  );
exception when duplicate_object then null;
end $$;

comment on type public.agent_calendar_level is
  'How much of the diary an external seller reaches. Ordered: each rung contains the one below it. The rung is what decides whether the other two ladders may be anything but none.';

-- PRICE_LEVELS. `none` is a member here and is refused by CHECK from the price
-- rung upward — the ladder itself has five positions and the coherence rule is
-- what removes one of them in context.
do $$ begin
  create type public.agent_price_level as enum (
    'none',
    'public',
    'agent',
    'net',
    'net_commission'
  );
exception when duplicate_object then null;
end $$;

comment on type public.agent_price_level is
  'Which price an external seller is shown. net and net_commission expose what the business actually receives, which is why the rung is stored per relationship and never per person.';

-- GUEST_DATA_LEVELS. The ladder stops at the email deliberately: identity
-- documents, payment detail and internal notes are not rungs.
do $$ begin
  create type public.agent_guest_data_level as enum ('none', 'name', 'phone', 'email');
exception when duplicate_object then null;
end $$;

-- AGENT_AMENDMENTS. A set, not a ladder — no ordering between them is true.
do $$ begin
  create type public.agent_amendment as enum (
    'guest_details',
    'guest_count',
    'extras',
    'dates',
    'price'
  );
exception when duplicate_object then null;
end $$;

comment on type public.agent_amendment is
  'What an agent may change on a booking they made. Deliberately a set and not a ladder: a business may let an agent move dates and never touch money, or exactly the reverse.';

-- AGENT_CANCELLATION_KINDS.
do $$ begin
  create type public.agent_cancellation_kind as enum (
    'never',
    'until_paid',
    'hours_before_arrival',
    'requires_approval'
  );
exception when duplicate_object then null;
end $$;

-- AgentInventoryScope.
do $$ begin
  create type public.agent_inventory_scope_kind as enum (
    'all_properties',
    'properties',
    'units'
  );
exception when duplicate_object then null;
end $$;

comment on type public.agent_inventory_scope_kind is
  'Which inventory exists for this agent. all_properties is stored as a kind rather than as a list of every property id, because a list is a snapshot and an agent given everything must still reach the property bought next month.';

do $$ begin
  create type public.agent_invitation_status as enum (
    'pending',
    'accepted',
    'expired',
    'revoked'
  );
exception when duplicate_object then null;
end $$;


-- ── A key the settings row can point at ─────────────────────────────────────
-- `memberships` is unique on its id alone. The composite key lets the terms
-- name a membership together with the organization and the person it belongs
-- to, so a settings row cannot be attached to somebody else's membership by
-- quoting its id. 0011 added `bookings_id_organization_key` for the same
-- reason.

do $$ begin
  alter table public.memberships
    add constraint memberships_id_organization_user_key unique (id, organization_id, user_id);
exception when duplicate_object or duplicate_table then null;
end $$;


-- ============================================================================
-- agent_organization_settings
-- ============================================================================

create table if not exists public.agent_organization_settings (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  agent_user_id             uuid not null references auth.users (id) on delete cascade,
  -- The membership this agent acts through. There is no second identity.
  membership_id             uuid not null,

  -- ── Ladder one: access ───────────────────────────────────────────────────
  access_calendar           public.agent_calendar_level not null default 'none',
  access_price              public.agent_price_level not null default 'none',
  access_guest_data         public.agent_guest_data_level not null default 'none',
  access_amendments         public.agent_amendment[] not null default '{}'::public.agent_amendment[],
  access_cancellation_kind  public.agent_cancellation_kind not null default 'never',
  access_cancellation_hours integer,
  access_payment_link       boolean not null default false,

  -- ── Ladder two: inventory reach ──────────────────────────────────────────
  inventory_kind            public.agent_inventory_scope_kind not null default 'all_properties',
  inventory_property_ids    uuid[] not null default '{}'::uuid[],
  inventory_unit_ids        uuid[] not null default '{}'::uuid[],

  -- ── The discount cap ─────────────────────────────────────────────────────
  -- numeric, not double precision and not basis points. `AgentDiscountCap`
  -- carries `maxPercent` as a plain number and src/lib/agents/discounts.ts
  -- compares it with an explicit epsilon, so the stored value has to be the
  -- same number the domain compares — a bps column would put a conversion in
  -- the adapter that nothing else on this row needs, and rounding it there is
  -- how a 7.5% cap becomes a 7% cap. numeric is exact, which is the property a
  -- float lacks; 0 is meaningful and is the conservative default.
  discount_max_percent      numeric(6,3) not null default 0,
  discount_max_agorot       integer,

  -- ── The hold limits ──────────────────────────────────────────────────────
  -- Five scalars, from DEFAULT_AGENT_HOLD_LIMITS in src/lib/agents/holds.ts.
  -- The defaults are that record's values and are deliberately small: they are
  -- what a brand-new agent gets before they have proved anything.
  hold_max_concurrent       integer not null default 3,
  hold_max_per_day          integer not null default 10,
  hold_max_extensions       integer not null default 1,
  hold_default_minutes      integer not null default 30,
  hold_max_minutes          integer not null default 120,

  -- 0–100. Widens the hold limits as the agent performs.
  reputation_score          integer not null default 0,

  -- Set when the agent sells under an agency's agreement.
  agency_id                 uuid references public.agencies (id) on delete restrict,
  internal_note             text,

  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  -- One set of terms per agent per organization. The same person selling for
  -- five competing businesses has five of these rows and no shared state
  -- between them, which is the whole point of putting the terms on the
  -- relationship rather than on the person.
  constraint agent_organization_settings_agent_key
    unique (organization_id, agent_user_id),
  -- And one per membership, from the other direction.
  constraint agent_organization_settings_membership_key
    unique (membership_id),
  constraint agent_organization_settings_membership_fkey
    foreign key (membership_id, organization_id, agent_user_id)
    references public.memberships (id, organization_id, user_id) on delete cascade,

  -- ── The cross-ladder rule, as three constraints ──────────────────────────
  -- Below the price rung a price level is refused; from it upward `none` is
  -- refused. Written as a CASE with an exhaustive ELSE so a member added to
  -- the calendar enum later fails closed rather than falling through.
  constraint agent_organization_settings_price_coherent check (
    case access_calendar
      when 'none'                 then access_price = 'none'
      when 'availability'         then access_price = 'none'
      when 'availability_price'   then access_price <> 'none'
      when 'availability_hold'    then access_price <> 'none'
      when 'availability_booking' then access_price <> 'none'
      else false
    end
  ),
  -- Guest data is a question only at the booking rung.
  constraint agent_organization_settings_guest_data_coherent check (
    access_calendar = 'availability_booking' or access_guest_data = 'none'
  ),
  -- Amendments, cancellation and the payment link exist only at the booking
  -- rung. This is the `?: never` in `WithoutBookingRights`, at the floor.
  constraint agent_organization_settings_booking_rights_coherent check (
    access_calendar = 'availability_booking'
    or (
      access_amendments = '{}'::public.agent_amendment[]
      and access_cancellation_kind = 'never'
      and access_payment_link = false
    )
  ),
  -- An hours-based cancellation policy has hours, and no other kind does.
  constraint agent_organization_settings_cancellation_hours_pair check (
    (access_cancellation_kind = 'hours_before_arrival') = (access_cancellation_hours is not null)
  ),
  constraint agent_organization_settings_cancellation_hours_positive check (
    access_cancellation_hours is null or access_cancellation_hours > 0
  ),

  -- ── The inventory scope, shaped like its union ───────────────────────────
  -- Each variant carries exactly the ids it needs and no others, mirroring
  -- `invitations_scope_shape` in 0001. The named lists must be non-empty:
  -- unlike the scope arrays on `agent_commission_rules`, an empty list here
  -- has no second meaning to preserve — "everything" is a kind of its own —
  -- so an empty list is only an agent configured to sell nothing, which is a
  -- mistake wearing the shape of a configuration.
  constraint agent_organization_settings_inventory_shape check (
    case inventory_kind
      when 'properties' then
        array_length(inventory_property_ids, 1) is not null
        and inventory_unit_ids = '{}'::uuid[]
      when 'units' then
        array_length(inventory_unit_ids, 1) is not null
        and inventory_property_ids = '{}'::uuid[]
      when 'all_properties' then
        inventory_property_ids = '{}'::uuid[]
        and inventory_unit_ids = '{}'::uuid[]
      else false
    end
  ),

  constraint agent_organization_settings_discount_percent_range check (
    discount_max_percent >= 0 and discount_max_percent <= 100
  ),
  constraint agent_organization_settings_discount_agorot_nonnegative check (
    discount_max_agorot is null or discount_max_agorot >= 0
  ),

  -- Hold limits. Zero extensions is a real arrangement — a hold gets its
  -- window and no more — so the floor is 0 and not 1.
  constraint agent_organization_settings_hold_counts_nonnegative check (
    hold_max_concurrent >= 0
    and hold_max_per_day >= 0
    and hold_max_extensions >= 0
  ),
  constraint agent_organization_settings_hold_minutes_positive check (
    hold_default_minutes > 0 and hold_max_minutes > 0
  ),
  -- The default window cannot exceed the ceiling on any one window. Without
  -- this the agent who chooses nothing is handed more than the agent who
  -- chooses the maximum.
  constraint agent_organization_settings_hold_default_within_max check (
    hold_default_minutes <= hold_max_minutes
  ),

  constraint agent_organization_settings_reputation_range check (
    reputation_score between 0 and 100
  ),
  constraint agent_organization_settings_version_positive check (version >= 1)
);

comment on table public.agent_organization_settings is
  'The commercial terms of one agent inside one organization: the access ladder, the inventory reach, the discount cap, the hold limits and the reputation score. memberships holds the relationship and none of this. There is deliberately no type, preset or model column — the four presets in src/lib/agents/access.ts are seed values that stop existing the moment one is chosen, and a stored type is an invitation to write code that silently breaks every manual edit an owner makes.';
comment on column public.agent_organization_settings.membership_id is
  'The membership this agent acts through, named together with its organization and user so the terms cannot be attached to somebody else''s membership. The agent''s status is read from that row and is deliberately not copied here: two copies of "is this agent active" disagree the first day somebody is suspended, and the disagreement is an outsider holding live inventory access.';
comment on column public.agent_organization_settings.access_price is
  'Which price this agent sees. Refused unless the calendar rung is availability_price or above, and required from that rung upward — the cross-ladder rule in src/lib/agents/access.ts, enforced here rather than trusted.';
comment on column public.agent_organization_settings.discount_max_percent is
  'The discount ceiling, as the percentage the domain compares. numeric and not float: src/lib/agents/discounts.ts tests it with an epsilon, and a value that cannot equal itself makes that comparison a coin toss. 0 is meaningful and is the default — this agent may not discount at all.';
comment on column public.agent_organization_settings.reputation_score is
  '0–100. Widens the hold limits as the agent performs; see src/lib/agents/holds.ts. It never widens the access or inventory ladders — performance earns time, not reach.';

create index if not exists agent_organization_settings_organization_idx
  on public.agent_organization_settings (organization_id);
create index if not exists agent_organization_settings_agent_idx
  on public.agent_organization_settings (agent_user_id);
create index if not exists agent_organization_settings_agency_idx
  on public.agent_organization_settings (organization_id, agency_id)
  where agency_id is not null;

drop trigger if exists agent_organization_settings_touch on public.agent_organization_settings;
create trigger agent_organization_settings_touch
  before update on public.agent_organization_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- agent_invitations
-- ============================================================================

create table if not exists public.agent_invitations (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,

  -- The identity key. Free text in, E.164 out, generated rather than written
  -- for the reason guests.phone_e164 is generated: no write path can skip it,
  -- and two spellings of one number cannot become two agents.
  phone                     text not null,
  phone_e164                text generated always as (public.normalize_phone_il(phone)) stored,

  display_name              text,
  email                     citext,
  invited_by_user_id        uuid not null references auth.users (id) on delete restrict,

  -- The ladders the agent will start with. Chosen before they accept, and in
  -- the same shape and under the same constraints as the settings row they
  -- become on acceptance.
  access_calendar           public.agent_calendar_level not null default 'none',
  access_price              public.agent_price_level not null default 'none',
  access_guest_data         public.agent_guest_data_level not null default 'none',
  access_amendments         public.agent_amendment[] not null default '{}'::public.agent_amendment[],
  access_cancellation_kind  public.agent_cancellation_kind not null default 'never',
  access_cancellation_hours integer,
  access_payment_link       boolean not null default false,

  inventory_kind            public.agent_inventory_scope_kind not null default 'all_properties',
  inventory_property_ids    uuid[] not null default '{}'::uuid[],
  inventory_unit_ids        uuid[] not null default '{}'::uuid[],

  status                    public.agent_invitation_status not null default 'pending',
  channel                   text not null default 'sms',

  expires_at                timestamptz not null,
  accepted_at               timestamptz,
  accepted_by               uuid references auth.users (id) on delete set null,
  revoked_at                timestamptz,
  revoked_by                uuid references auth.users (id) on delete set null,

  message                   text,
  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  -- A number that does not normalise is not an identity, and an invitation
  -- addressed to it can never be matched to the person who accepts it.
  constraint agent_invitations_phone_normalises check (
    public.normalize_phone_il(phone) is not null
  ),
  constraint agent_invitations_email_format check (
    email is null or (email::text) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- INVITATION_CHANNELS. The identity is the phone; this is only how the
  -- message reaches it.
  constraint agent_invitations_channel check (channel in ('sms', 'whatsapp')),
  constraint agent_invitations_expires_after_creation check (expires_at > created_at),

  -- The status is the outcome, and the timestamps have to agree with it. This
  -- is the pairing `invitations` expresses with two nullable timestamps and a
  -- single-outcome CHECK; here the status is explicit, so the constraint says
  -- so directly and `expired` — which that pair cannot express at all — is a
  -- state like the others.
  constraint agent_invitations_accepted_pair check (
    (status = 'accepted') = (accepted_at is not null)
  ),
  constraint agent_invitations_revoked_pair check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  constraint agent_invitations_accepted_by_pair check (
    accepted_by is null or accepted_at is not null
  ),
  constraint agent_invitations_single_outcome check (
    accepted_at is null or revoked_at is null
  ),

  constraint agent_invitations_price_coherent check (
    case access_calendar
      when 'none'                 then access_price = 'none'
      when 'availability'         then access_price = 'none'
      when 'availability_price'   then access_price <> 'none'
      when 'availability_hold'    then access_price <> 'none'
      when 'availability_booking' then access_price <> 'none'
      else false
    end
  ),
  constraint agent_invitations_guest_data_coherent check (
    access_calendar = 'availability_booking' or access_guest_data = 'none'
  ),
  constraint agent_invitations_booking_rights_coherent check (
    access_calendar = 'availability_booking'
    or (
      access_amendments = '{}'::public.agent_amendment[]
      and access_cancellation_kind = 'never'
      and access_payment_link = false
    )
  ),
  constraint agent_invitations_cancellation_hours_pair check (
    (access_cancellation_kind = 'hours_before_arrival') = (access_cancellation_hours is not null)
  ),
  constraint agent_invitations_cancellation_hours_positive check (
    access_cancellation_hours is null or access_cancellation_hours > 0
  ),
  constraint agent_invitations_inventory_shape check (
    case inventory_kind
      when 'properties' then
        array_length(inventory_property_ids, 1) is not null
        and inventory_unit_ids = '{}'::uuid[]
      when 'units' then
        array_length(inventory_unit_ids, 1) is not null
        and inventory_property_ids = '{}'::uuid[]
      when 'all_properties' then
        inventory_property_ids = '{}'::uuid[]
        and inventory_unit_ids = '{}'::uuid[]
      else false
    end
  ),
  constraint agent_invitations_version_positive check (version >= 1)
);

comment on table public.agent_invitations is
  'An agent invited by telephone number who has not accepted yet. Separate from public.invitations, which is keyed on an email and grants a role: this one is keyed on the identity key and grants two ladders. Extending that table would have meant weakening four NOT NULL columns and adding seven that mean nothing for an ordinary staff invitation — and an invitation read back with an invented access ladder is an agent arriving holding permissions nobody granted.';
comment on column public.agent_invitations.phone_e164 is
  'The normalised identity key, generated from phone. Never written by a caller: normalisation on write is the only version of it that works, because adding it afterwards means merging real people who have already made real bookings.';
comment on column public.agent_invitations.invited_by_user_id is
  'RESTRICT, not SET NULL. Who let an outsider into the business is the first question asked when the answer matters, and a deleted account must not erase it.';

-- At most one live invitation per number per organization. Accepted, revoked
-- and expired rows stay for the history and are excluded, exactly as
-- invitations_one_live_per_email_idx does for staff.
create unique index if not exists agent_invitations_one_live_per_phone_idx
  on public.agent_invitations (organization_id, phone_e164)
  where status = 'pending';

create index if not exists agent_invitations_organization_idx
  on public.agent_invitations (organization_id, status);
-- `findPendingInvitation(organizationId, phoneE164)` is exactly this index.
create index if not exists agent_invitations_phone_idx
  on public.agent_invitations (phone_e164) where status = 'pending';
create index if not exists agent_invitations_pending_expiry_idx
  on public.agent_invitations (expires_at) where status = 'pending';

drop trigger if exists agent_invitations_touch on public.agent_invitations;
create trigger agent_invitations_touch
  before update on public.agent_invitations
  for each row execute function public.tg_touch_row();

-- Who invited an outsider into the business, and which number they invited,
-- are the two facts this row exists to record. A policy cannot compare OLD
-- with NEW, so the immutability that an UPDATE policy cannot express is a
-- trigger. Without it an update that is otherwise legitimate — marking an
-- invitation revoked — could also rewrite the inviter, which is the one edit
-- that launders the answer.
create or replace function public.tg_agent_invitations_immutable_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.invited_by_user_id is distinct from old.invited_by_user_id then
    raise exception 'agent_invitations.invited_by_user_id cannot be changed'
      using errcode = '42501';
  end if;
  if new.phone is distinct from old.phone then
    raise exception 'agent_invitations.phone cannot be changed; revoke this invitation and issue another'
      using errcode = '42501';
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'agent_invitations.organization_id cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.tg_agent_invitations_immutable_origin() is
  'Refuses a change to who invited, which number was invited, or which organization did the inviting. An invitation to a different number is a different invitation; editing the phone in place would move an outstanding offer onto a stranger without any record that it moved.';

revoke all on function public.tg_agent_invitations_immutable_origin() from public, anon, authenticated, service_role;

drop trigger if exists agent_invitations_immutable_origin on public.agent_invitations;
create trigger agent_invitations_immutable_origin
  before update on public.agent_invitations
  for each row execute function public.tg_agent_invitations_immutable_origin();


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.agent_organization_settings enable row level security;
alter table public.agent_organization_settings force  row level security;
alter table public.agent_invitations           enable row level security;
alter table public.agent_invitations           force  row level security;

revoke all on public.agent_organization_settings from anon, authenticated;
revoke all on public.agent_invitations           from anon, authenticated;

grant select, insert, update on public.agent_organization_settings to authenticated;
grant select, insert, update on public.agent_invitations           to authenticated;

grant select, insert, update on public.agent_organization_settings to service_role;
grant select, insert, update on public.agent_invitations           to service_role;

-- Supabase hands service_role everything on a new table and it carries
-- BYPASSRLS, so taking DELETE back is what makes "these rows are not deleted"
-- true for a background job as well.
revoke delete, truncate on public.agent_organization_settings from service_role;
revoke delete, truncate on public.agent_invitations           from service_role;


-- ── Policies · agent_organization_settings ──────────────────────────────────
-- Reading: `agent.view`, or the agent themselves. An agent reading their own
-- terms is not a privilege — it is the discount cap and the hold allowance
-- their day is governed by, and a seller who cannot see their own ceiling
-- discovers it by being refused in front of a customer.
--
-- There is no DELETE policy and no DELETE grant. An agent relationship ends by
-- the membership becoming `removed`; deleting the terms would take with it the
-- record a past commission is argued from.

drop policy if exists agent_organization_settings_select on public.agent_organization_settings;
create policy agent_organization_settings_select on public.agent_organization_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent.view')
      or agent_user_id = (select auth.uid())
    )
  );

-- Creating the terms is part of admitting the agent, which 0012 calls
-- `agent.invite` and src/lib/agents/operations.ts gates `addAgent` on. That
-- covers `attachExistingUser` too: it creates a membership and never a user.
drop policy if exists agent_organization_settings_insert on public.agent_organization_settings;
create policy agent_organization_settings_insert on public.agent_organization_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.invite')
  );

-- Three grants can edit this row because 0012 deliberately splits what it
-- holds three ways: `agent.manage` for the terms, `agent.scope.manage` for the
-- reach, `agent_limits.manage` for the allowances. A policy cannot see which
-- column changed, so the floor admits any of the three and the second floor —
-- can() in src/lib/authz, which src/lib/agents/operations.ts consults per
-- operation — decides which fields each of them may actually move. That is the
-- division 0004 states in its header, applied rather than restated: this floor
-- guarantees the tenant, the engine above guarantees the field.
--
-- An agent cannot edit their own terms. `agent_user_id = auth.uid()` appears in
-- the read policy and deliberately not here: an agent who could write this row
-- would set their own discount cap.
drop policy if exists agent_organization_settings_update on public.agent_organization_settings;
create policy agent_organization_settings_update on public.agent_organization_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent.manage')
      or public.has_permission(organization_id, 'agent.scope.manage')
      or public.has_permission(organization_id, 'agent_limits.manage')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent.manage')
      or public.has_permission(organization_id, 'agent.scope.manage')
      or public.has_permission(organization_id, 'agent_limits.manage')
    )
  );


-- ── Policies · agent_invitations ────────────────────────────────────────────
-- Acceptance is not expressible here, for the reason 0004 gives about
-- `invitations`: the invitee is a stranger to the organization until the
-- moment they accept, and no policy can admit a caller who is not yet a member
-- of anything. That path is a service-layer transaction which verifies the
-- number, the expiry and the status, and creates the user, the membership and
-- the settings row together.
--
-- Note what a reader of this table gets: the telephone numbers of people the
-- business is recruiting. That is competitive information, so it is behind a
-- grant rather than behind membership.

drop policy if exists agent_invitations_select on public.agent_invitations;
create policy agent_invitations_select on public.agent_invitations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent.view')
      or public.has_permission(organization_id, 'agent.invite')
    )
  );

drop policy if exists agent_invitations_insert on public.agent_invitations;
create policy agent_invitations_insert on public.agent_invitations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.invite')
    and invited_by_user_id = (select auth.uid())
  );

-- Revoking one, or letting it expire. The inviter, the number and the tenant
-- cannot be moved by this policy — not because the policy says so, which it
-- cannot, but because `agent_invitations_immutable_origin` refuses it above.
drop policy if exists agent_invitations_update on public.agent_invitations;
create policy agent_invitations_update on public.agent_invitations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.invite')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.invite')
  );
