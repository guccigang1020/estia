-- ============================================================================
-- 0037_guest_audit_actor.sql — ESTIA · a guest is not "system"
--
-- What this closes
--   A guest confirming their booking, signing a contract, uploading a transfer
--   receipt or asking for two extra towels produces no row in `audit_events`.
--   Not because anybody decided it should not — because there is no actor type
--   it could be written as. `public.audit_actor_type` carries `user`,
--   `system`, `ai_agent` and `platform_staff`, and a guest is none of them:
--   they hold a capability URL rather than an account, so there is no
--   `auth.uid()` and no row in `auth.users`.
--
--   The append-only journey tables record the timestamp, the IP, the user
--   agent and the booking version, so the facts are not lost. What is lost is
--   the timeline — the audit screen shows a booking confirmed by nobody.
--
-- Why not fold it into `system`
--   Because 0005 already argued this, about a different actor, and the
--   argument holds:
--
--     "An AI agent acting on customer data is named as such, never folded
--      into 'system'."
--
--   The same sentence with "guest" in it is just as true, and matters more:
--   in a dispute about what a guest agreed to and when, an audit row saying
--   `system` is not a weaker answer, it is the wrong one. An act by somebody
--   outside the business must never be indistinguishable from one the business
--   took itself.
--
-- On `actor_user_id`
--   Stays null for a guest, and the column already allows it. What identifies
--   the actor is the resource the event is about — the booking whose token was
--   presented — and `actor_label` carries the guest's own name, which 0005
--   requires to be non-blank and which survives the guest row being deleted.
--
-- Depends on
--   0005 (audit_events, audit_actor_type), 0033 and 0034 (the guest portal
--   and the journey tables whose acts this lets be recorded).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The actor type
-- ============================================================================
-- `add value if not exists` rather than a guarded block: adding an enum member
-- is idempotent on its own terms in PG12+, and unlike 0030 nothing in this
-- migration needs to *use* the new label, so there is no 55P02 to work around
-- and no need to split the transaction.

alter type public.audit_actor_type add value if not exists 'guest';

comment on type public.audit_actor_type is
  'user | system | ai_agent | platform_staff | guest. An AI agent acting on customer data is named as such, never folded into "system" — and neither is a guest, who acts from outside the business entirely and holds a capability URL rather than an account. actor_user_id is null for a guest; the booking the token addressed is what identifies them.';


-- ============================================================================
-- 2 · Rehearsal
-- ============================================================================

do $$
declare
  n integer;
begin
  select count(*) into n
  from pg_enum en
  join pg_type t on t.oid = en.enumtypid
  join pg_namespace ns on ns.oid = t.typnamespace
  where ns.nspname = 'public'
    and t.typname = 'audit_actor_type'
    and en.enumlabel = 'guest';

  if n <> 1 then
    raise exception 'audit_actor_type is missing the guest member';
  end if;

  -- The column must still accept a null actor, because a guest has no row in
  -- `auth.users` to point at. If somebody ever tightens this to NOT NULL, a
  -- guest's confirmation becomes unrecordable again and the failure would be
  -- an insert error on the one path nobody exercises by hand.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'audit_events'
      and column_name = 'actor_user_id'
      and is_nullable = 'NO'
  ) then
    raise exception
      'audit_events.actor_user_id is NOT NULL, so a guest action cannot be recorded';
  end if;
end $$;
