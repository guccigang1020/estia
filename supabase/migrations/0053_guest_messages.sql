-- ============================================================================
-- 0053_guest_messages.sql — ESTIA · what was said to a guest, and what was not
--
-- What this is for
--   Autopilot can decide a guest should be reminded to pay, told how to get
--   in, or asked for a review — and until now had no way to say any of it.
--   Five of its external-communication actions resolved to nothing.
--
--   `src/lib/messaging` is the domain command layer that closes that, and this
--   is the one table it needed. `notifyAssignee` and `notifyTeam` need NO
--   schema: they are `route()` → `dispatch()` over the notifications engine
--   from 0043, wrapped in an operation. A guest is the case that engine cannot
--   carry — no Actor, no membership, no preference row, no bell panel — so
--   only the guest side gets storage.
--
-- The vocabulary is reused, not copied
--   `channel` is `public.notification_channel` and `outcome` is
--   `public.notification_delivery_status`, both from 0043. So "there is no
--   second notification vocabulary" is true at the database and not merely in
--   the TypeScript. `not_configured` and `suppressed` therefore mean exactly
--   what they mean over there: the first is a business missing a transport,
--   the second is a person having said no. Merging them would tell a
--   guesthouse to buy an SMS gateway its own staff switched off.
--
-- The constraint worth arguing about
--   `guest_messages_never_claims_delivery` forbids the value `delivered`
--   outright. Nothing in this product can confirm a guest RECEIVED anything —
--   there is no transport, and no transport that exists supplies a receipt
--   ESTIA reads. Expressing that as a CHECK rather than as a convention puts
--   it where it cannot be forgotten by the next person writing an adapter at
--   two in the morning. Drop it the day a provider supplies real delivery
--   receipts, and not before.
--
-- Why rows exist for messages that never left
--   A business cannot act on an integration it does not know it is missing.
--   `guest_messages_unsent_idx` is the index behind "ESTIA would have sent 14
--   messages and nothing is connected", which is the only honest argument for
--   connecting something.
--
-- A gap this table does NOT close, recorded here because it matters
--   Nothing in this codebase releases a DEFERRED message when the quiet-hours
--   window opens. `guest_messages_due_idx` exists for the sweep that should do
--   it; until that sweep is written, a message held by quiet hours is a
--   message that never goes — which is worse than the gate it passed through.
--   `notification_deliveries` in 0043 has the identical hole. Reported by the
--   agent that built the module as the highest-severity thing it was leaving.
--
-- Depends on
--   0009 (bookings, guests and their composite unique keys), 0043 (the
--   notification channel and delivery-status enums), 0004 (my_organizations,
--   has_permission, property_in_scope).
-- ============================================================================

set search_path = public, extensions;

do $$ begin
  create type public.guest_message_kind as enum (
    'payment_reminder', 'arrival_info', 'review_request'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.guest_messages (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  -- Null only if a booking somehow names no property. Otherwise this is what
  -- property_in_scope() is asked about on every read.
  property_id           uuid references public.properties (id) on delete cascade,
  booking_id            uuid not null,
  guest_id              uuid not null,
  kind                  public.guest_message_kind not null,
  channel               public.notification_channel not null,
  subject               text,
  -- Composed at send time and STORED, never re-rendered. A message about a
  -- booking since cancelled must still say what it said.
  body                  text not null,
  recipient_masked      text,
  outcome               public.notification_delivery_status not null,
  -- English, for a diagnostic. The Hebrew a person reads comes from labels.
  outcome_detail        text,
  provider              text,
  provider_message_id   text,
  scheduled_for         timestamptz,
  correlation_id        uuid,
  dedupe_key            text not null,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  settled_at            timestamptz,
  version               integer not null default 1,

  -- Composite, so a message can never name another tenant's booking or guest.
  -- organization_id on its own cannot say that.
  constraint guest_messages_booking_fk foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint guest_messages_guest_fk foreign key (guest_id, organization_id)
    references public.guests (id, organization_id) on delete cascade,

  -- One intent, one row. What makes a redelivered Autopilot action a failed
  -- insert instead of a second message to the same guest.
  constraint guest_messages_dedupe_key unique (organization_id, dedupe_key),

  -- A guest has no session and no device registration, so `in_app` and `push`
  -- are meaningless here even though the shared enum carries them.
  constraint guest_messages_channel_is_outward
    check (channel in ('email', 'sms', 'whatsapp')),
  constraint guest_messages_body_not_blank check (length(btrim(body)) > 0),
  constraint guest_messages_dedupe_not_blank check (length(btrim(dedupe_key)) > 0),
  -- A deferral with no time is a message that never goes. Mirrors 0043.
  constraint guest_messages_deferred_has_time
    check (outcome <> 'deferred' or scheduled_for is not null),
  constraint guest_messages_scheduled_only_when_deferred
    check (outcome = 'deferred' or scheduled_for is null),
  constraint guest_messages_sent_has_provider
    check (outcome <> 'sent' or provider is not null),
  -- Nothing was attempted, so nothing may carry a provider's id.
  constraint guest_messages_not_configured_has_no_id
    check (outcome <> 'not_configured' or provider_message_id is null),
  constraint guest_messages_never_claims_delivery check (outcome <> 'delivered'),
  constraint guest_messages_version_positive check (version >= 1)
);

comment on table public.guest_messages is
  'One outward message to a guest, including the ones that never left the building. `not_configured` rows are the point: a business cannot act on an integration it does not know it is missing, and the count is the argument for connecting one.';
comment on column public.guest_messages.outcome is
  'public.notification_delivery_status, reused rather than copied. `not_configured` is the business missing a transport; `suppressed` is a person having said no. Merging them would tell a guesthouse to buy an SMS gateway its own staff switched off.';
comment on column public.guest_messages.recipient_masked is
  'Masked before it is stored, never after. This table would otherwise be the one place every guest telephone number is listed together, and an operations screen reads it.';
comment on column public.guest_messages.dedupe_key is
  'bookingId:kind:channel:idempotencyKey. Unique per organization, so a redelivered Autopilot action is a failed insert rather than a second message.';
comment on constraint guest_messages_never_claims_delivery on public.guest_messages is
  'NOTHING in this product can confirm a guest received anything. This is the honesty rule expressed where it cannot be forgotten. Drop it the day a provider supplies real delivery receipts — not before.';

drop trigger if exists guest_messages_touch on public.guest_messages;
create trigger guest_messages_touch
  before update on public.guest_messages
  for each row execute function public.tg_touch_row();

create index if not exists guest_messages_booking_idx
  on public.guest_messages (organization_id, booking_id, created_at desc);
create index if not exists guest_messages_guest_idx
  on public.guest_messages (organization_id, guest_id, created_at desc);

-- The "we would have sent 14 messages and nothing is connected" read.
create index if not exists guest_messages_unsent_idx
  on public.guest_messages (organization_id, created_at desc)
  where outcome in ('not_configured', 'failed');

-- What a release sweep would scan. Nothing sweeps this yet — see the header.
create index if not exists guest_messages_due_idx
  on public.guest_messages (scheduled_for)
  where outcome = 'deferred';

create index if not exists guest_messages_property_idx
  on public.guest_messages (organization_id, property_id)
  where property_id is not null;


-- ============================================================================
-- Row level security
-- ============================================================================
-- No delete policy and no delete grant. What was and was not said to a guest
-- is a record, and the party most interested in removing it is the party who
-- sent the wrong thing.

alter table public.guest_messages enable row level security;
alter table public.guest_messages force  row level security;

revoke all on public.guest_messages from anon, authenticated;
grant select, insert, update on public.guest_messages to authenticated;
grant select, insert, update on public.guest_messages to service_role;
revoke delete, truncate on public.guest_messages from authenticated, service_role;

drop policy if exists guest_messages_select on public.guest_messages;
create policy guest_messages_select on public.guest_messages
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.view')
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
  );

-- The operation asserting `message.send` is the first floor; this is the
-- second, and the second does not trust the first.
drop policy if exists guest_messages_insert on public.guest_messages;
create policy guest_messages_insert on public.guest_messages
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.send')
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
  );

-- Updatable only so a deferred row can be released and a sent row settled.
drop policy if exists guest_messages_update on public.guest_messages;
create policy guest_messages_update on public.guest_messages
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.send')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.send')
  );


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  if to_regclass('public.guest_messages') is null then
    raise exception 'guest_messages missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'guest_messages_never_claims_delivery'
      and conrelid = 'public.guest_messages'::regclass
  ) then
    raise exception
      'guest_messages could record a message as delivered, and nothing in this product can confirm a guest received anything';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'guest_messages_dedupe_key'
      and conrelid = 'public.guest_messages'::regclass
  ) then
    raise exception
      'guest_messages has no dedupe key, so a redelivered action could message the same guest twice';
  end if;

  select string_agg(name, ', ') into missing
  from (values ('guest_messages_booking_fk'), ('guest_messages_guest_fk')) as t(name)
  where not exists (
    select 1 from pg_constraint
    where conname = t.name and conrelid = 'public.guest_messages'::regclass
  );
  if missing is not null then
    raise exception 'composite tenant keys missing: %', missing;
  end if;

  if not (select c.relrowsecurity and c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'guest_messages') then
    raise exception 'RLS not enabled and forced on guest_messages';
  end if;

  select string_agg(distinct grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'guest_messages'
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception
      'delete is granted on guest correspondence: %', missing;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'guest_messages' and grantee = 'anon'
  ) then
    raise exception 'anon holds privileges on guest_messages';
  end if;
end $$;
