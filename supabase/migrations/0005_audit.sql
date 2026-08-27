-- ============================================================================
-- 0005_audit.sql — ESTIA foundation · the audit trail
--
-- What this does
--   Creates audit_events: who did what, to which record, in which
--   organization, with the before and after values.
--
--   Two things this table insists on.
--
--   First, it says what happened, not that something happened. The summary
--   column carries a sentence a human can read in a support call —
--   "שי שינה מחיר הזמנה מ-₪5,200 ל-₪4,700" — because "booking updated" is
--   worth nothing six months later.
--
--   Second, actions are attributable to a kind of actor, not only to a user
--   id. As soon as background jobs and AI agents act on a customer's data,
--   "the system did it" stops being an acceptable answer: actor_type
--   distinguishes a person from a scheduled job, from an AI agent, from ESTIA
--   staff, and actor_label keeps the human-readable name even after the
--   underlying account is gone.
--
--   The table is append-only. Not by convention — by revoked privileges and a
--   trigger that raises on UPDATE and DELETE. A trail that can be edited is
--   not a trail.
--
-- Depends on
--   0001_identity.sql (organizations), 0004_rls.sql (my_organizations,
--   has_permission).
-- ============================================================================

set search_path = public, extensions;


-- ── Types ───────────────────────────────────────────────────────────────────

do $$ begin
  create type public.audit_actor_type as enum (
    'user',
    'system',
    'ai_agent',
    'platform_staff'
  );
exception when duplicate_object then null;
end $$;

comment on type public.audit_actor_type is
  'Who performed the action: a person, an automated job, an AI agent acting on the customer behalf, or ESTIA staff. AI actions must be attributable, so they are a first-class actor rather than a system event.';


-- ── audit_events ────────────────────────────────────────────────────────────

create table if not exists public.audit_events (
  id               uuid primary key default gen_random_uuid(),

  -- RESTRICT, not CASCADE. Deleting an organization must not be able to erase
  -- what was done inside it; closing an account is a status change.
  organization_id  uuid not null references public.organizations (id) on delete restrict,

  -- SET NULL, not CASCADE, for the same reason at the level of a person:
  -- removing a member never removes their history. actor_label survives the
  -- id so the row still reads as a sentence about a named human.
  actor_user_id    uuid references auth.users (id) on delete set null,
  actor_type       public.audit_actor_type not null default 'user',
  actor_label      text not null,

  action           text not null,
  resource_type    text not null,
  resource_id      text,
  property_id      uuid,

  before           jsonb,
  after            jsonb,

  -- The sentence a human reads.
  summary          text not null,
  -- Why, when the action required a stated reason: a refund, a deletion, an
  -- export of customer data.
  reason           text,

  occurred_at      timestamptz not null default now(),
  ip               inet,
  user_agent       text,
  request_id       text,

  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  constraint audit_events_actor_label_not_blank check (length(btrim(actor_label)) > 0),
  constraint audit_events_action_not_blank check (length(btrim(action)) > 0),
  constraint audit_events_resource_type_not_blank check (length(btrim(resource_type)) > 0),
  constraint audit_events_summary_not_blank check (length(btrim(summary)) > 0)
);

comment on table public.audit_events is
  'Append-only record of every consequential action: actor, action, resource, before, after, time and correlation id. Rows are never updated or deleted — the privileges are revoked and a trigger refuses both. Deliberately carries no version/updated_at, because nothing may ever update it.';
comment on column public.audit_events.actor_type is
  'user | system | ai_agent | platform_staff. An AI agent acting on a customer data is named as such, never folded into "system".';
comment on column public.audit_events.actor_label is
  'Human-readable name of the actor at the time of the action. Kept denormalised so the trail still reads correctly after the account is removed.';
comment on column public.audit_events.resource_id is
  'Identifier of the affected record. Text rather than uuid because audited things are not always rows in this database — a payment at the processor, a reservation at a channel, a generated file.';
comment on column public.audit_events.property_id is
  'The property the action touched, when it had one. Foreign key deferred until the properties table exists.';
comment on column public.audit_events.summary is
  'What happened, in a sentence a person can read: "שי שינה מחיר הזמנה מ-5,200 ל-4,700", not "booking updated".';
comment on column public.audit_events.request_id is
  'Correlation id, so the events of one request or one background job can be read together.';


-- ── Append-only ─────────────────────────────────────────────────────────────
-- Privileges first: no role may issue UPDATE or DELETE against this table.
-- Then a trigger, because the table owner is not bound by grants and a
-- migration written in a hurry should have to argue with the database.

revoke all on public.audit_events from anon, authenticated;
grant select, insert on public.audit_events to authenticated;

revoke update, delete, truncate on public.audit_events from service_role;
grant select, insert on public.audit_events to service_role;

create or replace function public.tg_audit_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

comment on function public.tg_audit_events_append_only() is
  'Refuses UPDATE and DELETE on audit_events. Statement-level, so a statement that would have matched no rows is refused just as loudly as one that would have matched many.';

drop trigger if exists audit_events_no_update on public.audit_events;
create trigger audit_events_no_update
  before update on public.audit_events
  for each statement execute function public.tg_audit_events_append_only();

drop trigger if exists audit_events_no_delete on public.audit_events;
create trigger audit_events_no_delete
  before delete on public.audit_events
  for each statement execute function public.tg_audit_events_append_only();


-- ── Row level security ──────────────────────────────────────────────────────
-- Reading the trail is a permission, not a consequence of membership: it
-- contains before and after values from across the whole organization,
-- including money and guest details that most roles are not entitled to see.
--
-- There is no UPDATE and no DELETE policy, matching the revoked privileges —
-- two independent refusals for the same thing.

alter table public.audit_events enable row level security;
alter table public.audit_events force  row level security;

drop policy if exists audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'audit.view')
  );

-- Writing an event is not privileged — every action a member is allowed to
-- take records one — but it must land in their own organization, and a member
-- may not sign an event with somebody else's name.
drop policy if exists audit_events_insert on public.audit_events;
create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (
      actor_user_id is null
      or actor_user_id = (select auth.uid())
    )
  );


-- ── Indexes ─────────────────────────────────────────────────────────────────

-- The common query: this organization's trail, newest first.
create index if not exists audit_events_organization_occurred_at_idx
  on public.audit_events (organization_id, occurred_at desc);

-- The second most common: the history of one record.
create index if not exists audit_events_resource_idx
  on public.audit_events (organization_id, resource_type, resource_id, occurred_at desc);

-- What did this person do, and what happened during this request.
create index if not exists audit_events_actor_idx
  on public.audit_events (organization_id, actor_user_id, occurred_at desc)
  where actor_user_id is not null;
create index if not exists audit_events_request_idx
  on public.audit_events (request_id) where request_id is not null;
create index if not exists audit_events_property_idx
  on public.audit_events (property_id, occurred_at desc) where property_id is not null;
