-- ============================================================================
-- 0063_unified_inbox.sql — ESTIA · the conversation spine
--
-- Second of the four modules the Market Leadership Program names and the
-- product did not have.
--
-- ── What was there, and why the screen refused to pretend ──────────────────
--
-- `/inbox` existed, and its `_lib/queries.ts` header is the specification for
-- this migration. It says, in its own words: the grants `message.view`,
-- `message.send`, `message.assign` and `template.manage` are in the catalogue;
-- `empty-presets.ts` carries a finished "no open conversations" state with an
-- illustration; the menu has an item — and there is no messages table, no
-- threads table and no conversations table anywhere, so nothing could ever
-- arrive in one.
--
-- It then refused to render that empty state, because the sentence asserts two
-- things and both were false: that the mailbox works, and that this business
-- has had no conversations. It showed three honestly-labelled lists instead —
-- a guest's own words on a booking, a guest request that became work, a team
-- note — and said plainly that none of them is a thread.
--
-- This is the table that makes the empty state true.
--
-- ── AN OUTBOUND MESSAGE CARRIES NO BODY ────────────────────────────────────
--
-- The central decision, and it is structural rather than conventional.
--
-- `guest_messages` (0053) already owns what the business SENT: the wording,
-- the channel, the dedupe key, the provider's message id, whether quiet hours
-- deferred it, and what actually happened — `sent`, `failed`,
-- `not_configured`. Copying that text into the thread would create a second
-- answer to "what did we tell this guest", and the two would diverge the very
-- first time a send failed: the thread would show a message and the truth
-- would be that nothing left the building.
--
-- So `conversation_messages` stores an outbound message as a REFERENCE —
-- `guest_message_id` not null, `body` null — enforced by a CHECK. The thread
-- reads the outcome from the row that owns it. Inbound is the mirror image:
-- `body` not null, `guest_message_id` null, because nothing else in the schema
-- records an inbound message and until now a guest's reply had nowhere to live.
--
-- This is the rule Autopilot was held to — sit ABOVE the engine, never beside
-- it — expressed as two constraints instead of a paragraph somebody can
-- forget. `src/lib/messaging` is not touched by this work at all.
--
-- ── A thread does not need a guest ─────────────────────────────────────────
--
-- `guest_id` is nullable and that is the point. A website enquiry arrives from
-- somebody who has never stayed and has no guest row. Refusing to thread it
-- until they become a guest would mean the inbox cannot hold the conversations
-- that matter most — the ones before a booking exists. The contact columns
-- carry who they are until a guest row does, and
-- `conversations_has_somebody_to_talk_to` refuses a thread with no identity of
-- any kind.
--
-- ── Read is per person ─────────────────────────────────────────────────────
--
-- `conversation_reads` is keyed by `(conversation_id, user_id)` and its policy
-- pins `user_id = auth.uid()`. A manager opening a thread must not mark it
-- read for three colleagues who have not seen it. That is how a shared mailbox
-- quietly loses messages, and it is the most common way they fail.
--
-- Depends on 0062 (the composite keys), 0009 (guests), 0053 (guest_messages),
-- and the site and guest-request tables.
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies
-- ============================================================================

do $$ begin
  create type public.conversation_status as enum
    ('open', 'waiting_on_guest', 'waiting_on_us', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.conversation_origin as enum
    ('site_request', 'guest_request', 'staff', 'inbound_channel');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.conversation_channel as enum
    ('email', 'sms', 'whatsapp', 'site_form', 'portal', 'phone', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2 · The thread
-- ============================================================================

create table if not exists public.conversations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  property_id          uuid,
  guest_id             uuid,
  contact_name         text,
  contact_phone        text,
  contact_email        text,
  subject              text,
  status               public.conversation_status not null default 'open',
  origin               public.conversation_origin not null,
  site_request_id      uuid,
  guest_request_id     uuid,
  assigned_to_user_id  uuid references auth.users (id) on delete set null,
  last_message_at      timestamptz,
  last_inbound_at      timestamptz,
  opened_at            timestamptz not null default now(),
  opened_by            uuid references auth.users (id) on delete set null,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              integer not null default 1,
  constraint conversations_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete set null (property_id),
  constraint conversations_guest_fkey foreign key (guest_id, organization_id)
    references public.guests (id, organization_id) on delete set null (guest_id),
  constraint conversations_site_request_fkey foreign key (site_request_id, organization_id)
    references public.site_booking_requests (id, organization_id) on delete set null (site_request_id),
  constraint conversations_guest_request_fkey foreign key (guest_request_id, organization_id)
    references public.guest_requests (id, organization_id) on delete set null (guest_request_id),
  constraint conversations_id_organization_key unique (id, organization_id),
  constraint conversations_has_somebody_to_talk_to check (
    guest_id is not null
    or contact_email is not null
    or contact_phone is not null
    or contact_name is not null
  ),
  constraint conversations_closed_stamp
    check ((status = 'closed') = (closed_at is not null)),
  constraint conversations_origin_names_its_source check (
    (origin = 'site_request') = (site_request_id is not null)
    and (origin = 'guest_request') = (guest_request_id is not null)
  )
);

comment on table public.conversations is
  'One thread. The product copy in empty-presets.ts already states the intent — every enquiry from the site, WhatsApp or email arrives in one thread per guest, so nobody has to hunt for what was said on another channel — and this is the table that finally makes that sentence true.';
comment on column public.conversations.guest_id is
  'Null on purpose. A website enquiry arrives from somebody who has never stayed and has no guest row, and refusing to thread it until they become a guest would mean the inbox cannot hold the conversations that matter most: the ones before a booking exists. The contact columns carry who they are until a guest row does.';
comment on constraint conversations_origin_names_its_source on public.conversations is
  'The origin and the foreign key agree in both directions. An origin of site_request with no site_request_id is a thread that claims a provenance it cannot show.';

create index if not exists conversations_org_status_idx
  on public.conversations (organization_id, status, last_message_at desc);
create index if not exists conversations_guest_idx
  on public.conversations (organization_id, guest_id) where guest_id is not null;
create index if not exists conversations_assigned_idx
  on public.conversations (organization_id, assigned_to_user_id)
  where assigned_to_user_id is not null;
-- "Who is waiting on us, longest first" is the only question this screen is
-- really for, so it gets its own partial index rather than a filter over the
-- whole table.
create index if not exists conversations_waiting_idx
  on public.conversations (organization_id, last_inbound_at)
  where status in ('open', 'waiting_on_us');

drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch
  before update on public.conversations
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · The messages, stored differently in each direction
-- ============================================================================

create table if not exists public.conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  conversation_id  uuid not null,
  direction        public.message_direction not null,
  channel          public.conversation_channel not null,
  body             text,
  guest_message_id uuid,
  author_user_id   uuid references auth.users (id) on delete set null,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  constraint conversation_messages_conversation_fkey
    foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete cascade,
  constraint conversation_messages_guest_message_fkey
    foreign key (guest_message_id, organization_id)
    references public.guest_messages (id, organization_id) on delete set null (guest_message_id),
  constraint conversation_messages_id_organization_key unique (id, organization_id),
  constraint conversation_messages_outbound_is_a_reference check (
    direction = 'inbound'
    or (guest_message_id is not null and body is null)
  ),
  constraint conversation_messages_inbound_has_words check (
    direction = 'outbound'
    or (body is not null and length(btrim(body)) > 0 and guest_message_id is null)
  ),
  constraint conversation_messages_body_is_bounded
    check (body is null or length(body) <= 20000)
);

comment on table public.conversation_messages is
  'Both directions, and they are stored differently on purpose. See the two CHECK constraints.';
comment on constraint conversation_messages_outbound_is_a_reference on public.conversation_messages is
  'AN OUTBOUND MESSAGE CARRIES NO BODY. guest_messages already owns what the business sent — its wording, its channel, its dedupe key, its delivery outcome and whether quiet hours held it back. Copying the text here would create a second answer to what did we tell this guest, and the two would diverge the first time a send failed: the thread would show the message and the truth would be that nothing left the building. So the thread REFERENCES the row and reads the outcome from it. This is the rule Autopilot was held to — sit above the engine, never beside it — made structural.';
comment on constraint conversation_messages_inbound_has_words on public.conversation_messages is
  'An inbound message carries its own body, because nothing else in the schema records one. Until this table existed a guest could reply and the reply had nowhere to live.';

create index if not exists conversation_messages_thread_idx
  on public.conversation_messages (organization_id, conversation_id, occurred_at);
create index if not exists conversation_messages_guest_message_idx
  on public.conversation_messages (organization_id, guest_message_id)
  where guest_message_id is not null;


-- ============================================================================
-- 4 · Who has actually seen it
-- ============================================================================

create table if not exists public.conversation_reads (
  conversation_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id),
  constraint conversation_reads_conversation_fkey
    foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete cascade
);

comment on table public.conversation_reads is
  'Read is per PERSON, not per organization. A manager opening a thread must not mark it read for the three colleagues who have not seen it — that is how an inbox quietly loses messages, and it is the single most common way shared mailboxes fail.';

create index if not exists conversation_reads_user_idx
  on public.conversation_reads (organization_id, user_id, last_read_at);


-- ============================================================================
-- 5 · Row level security
-- ============================================================================

alter table public.conversations         enable row level security;
alter table public.conversations         force  row level security;
alter table public.conversation_messages enable row level security;
alter table public.conversation_messages force  row level security;
alter table public.conversation_reads    enable row level security;
alter table public.conversation_reads    force  row level security;

revoke all on public.conversations         from anon, authenticated;
revoke all on public.conversation_messages from anon, authenticated;
revoke all on public.conversation_reads    from anon, authenticated;

grant select, insert, update on public.conversations         to authenticated, service_role;
grant select, insert         on public.conversation_messages to authenticated, service_role;
grant select, insert, update on public.conversation_reads    to authenticated, service_role;

-- A message is never edited or withdrawn. What was said was said, and a thread
-- somebody can quietly rewrite is not a record of a conversation.
revoke delete, truncate on public.conversation_messages from authenticated, service_role;

-- `property_id is null or in scope`, in every policy. A thread that names no
-- property is a general enquiry and belongs to whoever may read messages; one
-- that names a property obeys the same scope every other row of that property
-- does. Omitting the null branch would hide every website enquiry from
-- everybody, which is the half of the inbox with the most money in it.

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'message.view')
  );

drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'message.send')
  );

-- `message.assign` finally has something to write to. It was in the catalogue
-- with nothing to point at, which the old screen said out loud.
drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (public.has_permission(organization_id, 'message.send')
         or public.has_permission(organization_id, 'message.assign'))
  )
  with check (
    organization_id in (select public.my_organizations())
    and (public.has_permission(organization_id, 'message.send')
         or public.has_permission(organization_id, 'message.assign'))
  );

drop policy if exists conversation_messages_select on public.conversation_messages;
create policy conversation_messages_select on public.conversation_messages
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.view')
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_messages.conversation_id
        and c.organization_id = conversation_messages.organization_id
        and (c.property_id is null
             or public.property_in_scope(c.property_id, c.organization_id))
    )
  );

drop policy if exists conversation_messages_insert on public.conversation_messages;
create policy conversation_messages_insert on public.conversation_messages
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'message.send')
  );

drop policy if exists conversation_reads_select on public.conversation_reads;
create policy conversation_reads_select on public.conversation_reads
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );

drop policy if exists conversation_reads_write on public.conversation_reads;
create policy conversation_reads_write on public.conversation_reads
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  )
  with check (
    organization_id in (select public.my_organizations())
    and user_id = (select auth.uid())
  );


-- ============================================================================
-- 6 · Rehearsal
-- ============================================================================

do $$
declare
  offending text;
begin
  if to_regclass('public.conversations') is null
     or to_regclass('public.conversation_messages') is null
     or to_regclass('public.conversation_reads') is null then
    raise exception 'inbox tables missing';
  end if;

  -- The module's central rule. Without it there are two answers to what the
  -- business told a guest, and they diverge the first time a send fails.
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversation_messages_outbound_is_a_reference'
      and conrelid = 'public.conversation_messages'::regclass
  ) then
    raise exception
      'an outbound message could carry its own body, creating a second answer to what the business told a guest';
  end if;

  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'conversation_reads'
      and p.polname = 'conversation_reads_write'
      and pg_get_expr(p.polwithcheck, p.polrelid) like '%auth.uid()%'
  ) then
    raise exception
      'one person could mark a thread read for a colleague who has not seen it';
  end if;

  select string_agg(c.relname, ', ') into offending
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('conversations', 'conversation_messages', 'conversation_reads')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if offending is not null then
    raise exception 'RLS not enabled and forced on: %', offending;
  end if;

  select string_agg(distinct table_name, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon'
    and table_name in ('conversations', 'conversation_messages', 'conversation_reads');
  if offending is not null then
    raise exception 'anon holds privileges on: %', offending;
  end if;
end $$;
