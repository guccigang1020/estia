-- ============================================================================
-- 0006_idempotency.sql — ESTIA foundation · retries that cost nothing
--
-- What this does
--   Two things the layers above already assume exist.
--
--   1. `idempotency_keys` — durable storage for the two-phase reservation
--      described in src/lib/service/idempotency.ts. A payment page submitted
--      twice, a webhook delivered twice, a phone that lost signal after the
--      request left and before the answer came back are the same event from
--      the server's side, and all three must produce one charge.
--
--      The whole design rests on one unique constraint. `begin` is a single
--      `insert … on conflict do nothing returning`: the row either appears
--      and the caller holds the key, or it does not and the caller reads what
--      is already there. There is no window between a look and a write,
--      because there is no look — the atomicity is the database's, and
--      application code cannot fake it.
--
--   2. `audit_events.on_behalf_of_user_id` — the column AuditActor has always
--      carried. Without it "ESTIA wrote this headline, and Daniel approved
--      it" collapses into "the system did it", which is the answer the audit
--      trail exists to avoid.
--
-- Depends on
--   0001_identity.sql (organizations, tg_touch_row), 0004_rls.sql
--   (my_organizations), 0005_audit.sql (audit_events).
-- ============================================================================

set search_path = public, extensions;


-- ── idempotency_keys ────────────────────────────────────────────────────────
--
-- Scope is (organization_id, operation, key) and never the key alone. Keys are
-- chosen by clients, and two customers both sending "retry-1" — which is not a
-- hypothetical, it is what a retry loop with a counter produces — must not be
-- able to read each other's results. This is the tenant isolation rule wearing
-- a different hat, and it is enforced twice: by the constraint below, and by
-- the policies further down.
--
-- What is NOT stored here is as deliberate as what is. The request body never
-- lands in this table: it carries guest names, phone numbers and card
-- metadata, and an idempotency row outlives the request by design. Only a
-- fingerprint is kept — the 64-bit FNV-1a digest that src/lib/service computes
-- — which is enough to answer the single question asked of it: is this the
-- same request, or the same key reused for a different one?

create table if not exists public.idempotency_keys (
  id               uuid primary key default gen_random_uuid(),

  -- CASCADE, unlike audit_events. These rows are operational bookkeeping with
  -- a lifetime of hours; there is nothing here worth preserving past the
  -- organization that owns it, and nothing anyone would want to read back.
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  operation        text not null,
  key              text not null,

  -- A hash of the request, not the request. See the note above.
  fingerprint      text not null,

  -- The outcome, once there is one. Nullable, and `completed_at` rather than
  -- this column is the marker of completion: a legitimate result may itself be
  -- JSON null, and 'null'::jsonb is not the same as SQL NULL.
  result           jsonb,

  -- The lifecycle. created_at is when the key was reserved; completed_at is
  -- when the operation that held it finished. A row with completed_at IS NULL
  -- is in flight — someone is running it right now, and a second attempt must
  -- not start.
  completed_at     timestamptz,

  -- See "Expiry" below.
  expires_at       timestamptz not null default (now() + interval '1 hour'),

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  -- THE constraint. Not one of several — the mechanism the whole two-phase
  -- design is built on.
  --
  -- It is a plain unique constraint over exactly the three scope columns, and
  -- each of those words is load-bearing:
  --
  --   · exactly three — adding expires_at or created_at to it would let two
  --     rows share a key, which is precisely the state this table exists to
  --     make unrepresentable.
  --   · not partial — a `WHERE completed_at IS NULL` index would stop
  --     constraining a key the moment its operation finished, and the replay
  --     that arrives a second later would insert a second row and run the
  --     charge again.
  --   · a constraint, not a bare index — it is named, it appears in
  --     information_schema, and `on conflict (organization_id, operation, key)`
  --     infers it without ambiguity.
  --
  -- `begin` is then one statement:
  --
  --     insert into public.idempotency_keys
  --       (organization_id, operation, key, fingerprint)
  --     values ($1, $2, $3, $4)
  --     on conflict (organization_id, operation, key) do nothing
  --     returning id;
  --
  -- One row back means `reserved`. Zero rows means somebody else holds the
  -- key, and a following SELECT — inside the same transaction — classifies it:
  -- a different fingerprint is `mismatch`, completed_at IS NULL is
  -- `in_flight`, otherwise `replayed`, in that order of precedence. The SELECT
  -- decides which answer to give; it never decides who won.
  constraint idempotency_keys_scope_key unique (organization_id, operation, key),

  constraint idempotency_keys_operation_not_blank check (
    length(btrim(operation)) between 1 and 100
  ),
  constraint idempotency_keys_key_not_blank check (
    length(btrim(key)) between 1 and 255
  ),
  constraint idempotency_keys_fingerprint_not_blank check (
    length(btrim(fingerprint)) between 1 and 128
  ),
  -- A result can only exist on a row that finished. The reverse is allowed:
  -- an operation may complete with nothing to hand back.
  constraint idempotency_keys_result_requires_completion check (
    result is null or completed_at is not null
  ),
  constraint idempotency_keys_version_positive check (version >= 1)
);

comment on table public.idempotency_keys is
  'Durable storage for the two-phase idempotency reservation in src/lib/service/idempotency.ts. begin() is a single insert … on conflict (organization_id, operation, key) do nothing returning; the unique constraint is the atomicity, not the application. Scoped per organization because keys are client-chosen and two tenants will collide.';
comment on column public.idempotency_keys.operation is
  'The operation the key was issued for. Part of the scope so one client key cannot replay a different action — a "retry-1" for booking.create must not answer a payment.charge.';
comment on column public.idempotency_keys.key is
  'The client-chosen key. Never unique on its own; see the constraint.';
comment on column public.idempotency_keys.fingerprint is
  'A 64-bit FNV-1a digest of the canonicalised request, as hex — deliberately not the request, which contains guest data and would still be here a month later. Answers only: same request, or same key reused for a different one?';
comment on column public.idempotency_keys.result is
  'The stored outcome, replayed verbatim to a retry. Completion is marked by completed_at, not by this column, because a legitimate result may be JSON null.';
comment on column public.idempotency_keys.completed_at is
  'When the operation holding the key finished. NULL means in flight.';
comment on column public.idempotency_keys.expires_at is
  'When the row stops holding the key. Set short on reservation and extended on completion by idempotency_keys_extend; a row past this instant is claimable by the next begin() and deletable by the sweeper.';

-- No deleted_at, and that is a decision rather than an omission. `abandon()`
-- has to actually free the key so the retry the user was explicitly told to
-- make can succeed; a soft-deleted row would still occupy the unique
-- constraint and would poison the key exactly as a crashed process would.


-- ── Expiry ──────────────────────────────────────────────────────────────────
--
-- A reservation held by a process that then crashed must not block its key for
-- ever. Two lifetimes, one column:
--
--   · A reservation is leased for one hour. Long enough that no in-flight
--     request could plausibly still be running — the service layer completes
--     or abandons within a single HTTP request — and short enough that a
--     crash costs one key for one hour rather than a day. The lease is
--     deliberately not minutes: if it expired while the original operation
--     were still running, a second attempt could reclaim the key and charge
--     the card twice, which is the failure this whole table exists to prevent.
--     Erring long is erring towards a stuck key; erring short is erring
--     towards a double charge.
--
--   · A completed row is kept for 24 hours, so a client retrying tomorrow gets
--     yesterday's answer instead of a second booking. Twenty-four hours is the
--     window the payment industry settled on and the one integrators expect.
--
-- The extension is applied by a trigger and not by the caller, because "the
-- service layer remembers to widen expires_at when it completes" is a rule
-- that holds until the day somebody writes a second completion path.
--
-- Reclaiming an expired row does NOT depend on the sweeper having run. begin()
-- may use the reclaiming form, which is still one statement and still atomic:
--
--     insert into public.idempotency_keys
--       (organization_id, operation, key, fingerprint)
--     values ($1, $2, $3, $4)
--     on conflict (organization_id, operation, key) do update
--        set fingerprint  = excluded.fingerprint,
--            result       = null,
--            completed_at = null,
--            created_at   = now(),
--            expires_at   = now() + interval '1 hour'
--      where public.idempotency_keys.expires_at <= now()
--     returning id;
--
-- A live row makes the WHERE false, no row comes back, and the caller
-- classifies it exactly as with `do nothing`. An expired row is taken over in
-- the same statement. Correctness therefore never waits on a cron job; the
-- sweeper below only reclaims disk.

create or replace function public.tg_idempotency_extend_on_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only the transition into completion widens the window, and it never
  -- shortens one that is already longer.
  if new.completed_at is not null and old.completed_at is null then
    new.expires_at := greatest(new.expires_at, now() + interval '24 hours');
  end if;
  return new;
end;
$$;

comment on function public.tg_idempotency_extend_on_complete() is
  'BEFORE UPDATE on idempotency_keys: when a reservation completes, extends expires_at to the 24 hour replay window. The database owns the retention rule so a second completion path cannot forget it.';

drop trigger if exists idempotency_keys_touch on public.idempotency_keys;
create trigger idempotency_keys_touch
  before update on public.idempotency_keys
  for each row execute function public.tg_touch_row();

drop trigger if exists idempotency_keys_extend on public.idempotency_keys;
create trigger idempotency_keys_extend
  before update on public.idempotency_keys
  for each row execute function public.tg_idempotency_extend_on_complete();


-- The sweeper. Deletes what is already claimable, so the table does not grow
-- without bound. SECURITY DEFINER because it must cross every tenant, and
-- therefore with an empty search_path and schema-qualified names, like the
-- helpers in 0004.
--
-- It is not scheduled by this migration: pg_cron is a project-level extension
-- and enabling it is an operations decision, not a schema one. Schedule it
-- once per hour when it is enabled —
--
--     select cron.schedule('idempotency-sweep', '7 * * * *',
--                          $$select public.purge_expired_idempotency_keys()$$);
--
-- — and until then nothing is incorrect, only larger: expired rows are
-- reclaimed in place by the form of begin() shown above.

create or replace function public.purge_expired_idempotency_keys()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed bigint;
begin
  delete from public.idempotency_keys where expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.purge_expired_idempotency_keys() is
  'Deletes idempotency rows past expires_at and returns how many. Safe to run at any time: a row past its expiry no longer holds its key. Intended for an hourly schedule; correctness does not depend on it running.';

-- Same reasoning as 0004: Supabase grants EXECUTE on every new function in
-- `public` to anon, authenticated and service_role individually through ALTER
-- DEFAULT PRIVILEGES, and a REVOKE FROM PUBLIC leaves those grants standing.
-- Both roles are named. Unlike the 0004 helpers, `authenticated` is revoked
-- too: no row level security expression calls this, so nothing breaks, and a
-- signed-in caller has no business deleting other tenants' reservations.
revoke all on function public.purge_expired_idempotency_keys() from public, anon, authenticated;
grant execute on function public.purge_expired_idempotency_keys() to service_role;


-- ── Row level security ──────────────────────────────────────────────────────
--
-- FORCE, because nothing in 0004's SECURITY DEFINER helpers reads this table,
-- so there is no recursion to avoid and the owner's exemption is worth
-- removing.
--
-- One policy per command, all four commands, all of them scoped to the
-- caller's own organizations:
--   · select — a retry has to be able to read back its own stored result.
--   · insert — begin().
--   · update — complete(), and the reclaiming form of begin().
--   · delete — abandon(), which must genuinely remove the row.
--
-- Reading is not gated on a permission, unlike audit_events. The row holds the
-- caller's own answer to the caller's own request, and requiring a grant would
-- mean a guest-facing payment retry could not read the result of the payment
-- it just made.

alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force  row level security;

revoke all on public.idempotency_keys from anon, authenticated;
grant select, insert, update, delete on public.idempotency_keys to authenticated;
grant all on public.idempotency_keys to service_role;

drop policy if exists idempotency_keys_select on public.idempotency_keys;
create policy idempotency_keys_select on public.idempotency_keys
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists idempotency_keys_insert on public.idempotency_keys;
create policy idempotency_keys_insert on public.idempotency_keys
  for insert to authenticated
  with check (organization_id in (select public.my_organizations()));

drop policy if exists idempotency_keys_update on public.idempotency_keys;
create policy idempotency_keys_update on public.idempotency_keys
  for update to authenticated
  using (organization_id in (select public.my_organizations()))
  with check (organization_id in (select public.my_organizations()));

drop policy if exists idempotency_keys_delete on public.idempotency_keys;
create policy idempotency_keys_delete on public.idempotency_keys
  for delete to authenticated
  using (organization_id in (select public.my_organizations()));


-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- The lookup path — "is this key taken, and what happened to it?" — is served
-- by the unique constraint's own index, which leads on organization_id and
-- therefore also supports the tenant policy and the foreign key. A second
-- index over the same three columns would be dead weight on every insert.
--
-- What the constraint does not serve is the sweep, which is ordered by time
-- and not by tenant.
create index if not exists idempotency_keys_expires_at_idx
  on public.idempotency_keys (expires_at);

-- Operational: "what is stuck?", asked of one organization during an incident.
create index if not exists idempotency_keys_in_flight_idx
  on public.idempotency_keys (organization_id, created_at)
  where completed_at is null;

-- created_by and updated_by are left unindexed, matching the note in 0004:
-- nothing queries by them and they are ON DELETE SET NULL, so the only cost is
-- the rare deletion of an auth.users row.


-- ── audit_events.on_behalf_of_user_id ───────────────────────────────────────
--
-- AuditActor has carried onBehalfOfUserId since src/lib/audit/events.ts was
-- written; the column was simply missing. It is the difference between "an
-- employee decided" and "ESTIA generated, and a named employee approved", and
-- that distinction is the reason ai_agent is a first-class actor type rather
-- than a service account with a friendly name.
--
-- Nullable, and null is the ordinary case: an action nobody delegated. It is
-- meaningful mainly on ai_agent rows, but it is not restricted to them — a
-- platform_staff member acting on a customer's explicit request is the same
-- shape, and a CHECK tying it to one actor_type would have to be relaxed the
-- first time that happens.
--
-- ON DELETE SET NULL, exactly like actor_user_id: removing an account never
-- removes the history of what was done in their name.
--
-- ALTER TABLE only adds a column. The append-only triggers are statement-level
-- and reference no column list, the revoked UPDATE and DELETE privileges are
-- table-level, and both survive untouched — verified after the fact in
-- supabase/tests/idempotency.sql rather than assumed here.

alter table public.audit_events
  add column if not exists on_behalf_of_user_id uuid references auth.users (id) on delete set null;

comment on column public.audit_events.on_behalf_of_user_id is
  'For a delegated action: the person who asked for it or approved it. Set on ai_agent events so "the system did it" is never the answer; null when nobody delegated. SET NULL on account deletion, like actor_user_id — the trail outlives the account.';

-- The insert policy from 0005 refused to let a member sign an event with
-- somebody else's name. The same sentence applies word for word to somebody
-- else's approval: without this clause, any member could write "ESTIA changed
-- the price, and the owner approved it" and the trail would carry a forged
-- signature that reads exactly like a real one.
--
-- Every legitimate client-side case still passes. A person approving an AI
-- draft is the one signing in, so on_behalf_of_user_id = auth.uid(). An agent
-- acting for a user inside a background job is written by service_role, which
-- holds BYPASSRLS and is not filtered by policies at all.
drop policy if exists audit_events_insert on public.audit_events;
create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (
      actor_user_id is null
      or actor_user_id = (select auth.uid())
    )
    and (
      on_behalf_of_user_id is null
      or on_behalf_of_user_id = (select auth.uid())
    )
  );

-- "What was done in this person's name, in this organization" — the question
-- an approval log is read for. Partial, because the column is null on most
-- rows.
create index if not exists audit_events_on_behalf_of_idx
  on public.audit_events (organization_id, on_behalf_of_user_id, occurred_at desc)
  where on_behalf_of_user_id is not null;
