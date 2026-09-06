-- ============================================================================
-- 0071_message_templates.sql — ESTIA · the words a business writes itself
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `src/app/(app)/inbox/_lib/queries.ts` names `message_templates` in
-- `MISSING_MESSAGING_TABLES` and the inbox screen tells a business its
-- database lacks it. That has been true since the messaging module landed.
--
-- What it means in practice: `compose.ts` writes good Hebrew, and EVERY
-- business sends the same Hebrew. A guesthouse with a voice of its own, or one
-- hosting mostly English speakers, or one whose owner simply says things
-- differently, cannot change a single word of what its guests receive.
--
-- ── THE RULE, AND IT IS ENFORCED IN TYPESCRIPT AND NOT HERE ────────────────
--
-- **A template naming a fact the product cannot supply is refused when it is
-- saved, not when a guest is waiting for it.**
--
-- `src/lib/messaging/templates.ts` owns that check, because the list of
-- placeholders and what each one falls back to is a property of `compose.ts`
-- and would go stale the moment it is copied into a CHECK constraint. What
-- this file enforces is everything a constraint can hold honestly: the text is
-- not blank, it is not longer than the SMS billing makes reasonable, and the
-- email subject exists only where a subject means anything.
--
-- Stating that plainly matters. A reader who assumes the database validates
-- placeholders would relax the TypeScript check one day and ship a product
-- that sends `{{door_code}}` to a guest standing at a locked door.
--
-- ── ONE TEMPLATE PER KIND PER CHANNEL, AND `null` MEANS ALL ────────────────
--
-- `unique (organization_id, kind, channel)` with a NULLS NOT DISTINCT index,
-- so a business writes one wording for a kind and optionally overrides a
-- single channel. Without NULLS NOT DISTINCT Postgres treats every `null`
-- channel as unique and a business could accumulate four "all channels"
-- templates with no way to tell which one would be sent.
--
-- ── DELETING A TEMPLATE IS SAFE, AND THAT IS THE POINT ─────────────────────
--
-- No template means `compose.ts` exactly as it is today. Nothing regresses for
-- a business that never opens the screen, and one that writes a template and
-- then removes it falls back to working Hebrew rather than to silence. This is
-- the one table in the product where `delete` is the correct affordance, which
-- is why it is granted here and refused on `guest_reviews` and
-- `conversation_messages`: those are records of what happened, and this is a
-- setting.
--
-- Depends on 0002 (organizations) and whichever migration created
-- `guest_message_kind` and `notification_channel`.
-- ============================================================================

set search_path = public, extensions;

create table if not exists public.message_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  kind             public.guest_message_kind not null,
  -- `null` = every channel. A row with a channel overrides it for that one.
  channel          public.notification_channel,

  -- Only email renders one. Stored for any row so that connecting a mail
  -- provider later does not change the shape of what is already saved.
  subject          text,
  body             text not null,

  is_active        boolean not null default true,

  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  version          integer not null default 1,

  constraint message_templates_body_not_blank
    check (length(btrim(body)) > 0),

  -- 1500 characters, the same number `templates.ts` names and for the same
  -- reason: an SMS is billed per 70 Hebrew characters and a business writing a
  -- page of text is about to meet a bill it never agreed to.
  constraint message_templates_body_length check (length(body) <= 1500),

  constraint message_templates_subject_not_blank
    check (subject is null or length(btrim(subject)) > 0),
  constraint message_templates_subject_length
    check (subject is null or length(subject) <= 200),

  -- A guest channel or nothing. `in_app` and `push` are staff notification
  -- channels; a template addressed to one of them would never be sent and
  -- would sit in the screen looking configured.
  constraint message_templates_guest_channel_only check (
    channel is null
    or channel in ('email'::public.notification_channel,
                   'sms'::public.notification_channel,
                   'whatsapp'::public.notification_channel)),

  constraint message_templates_version_positive check (version >= 1)
);

-- NULLS NOT DISTINCT is the whole point: without it a business could store
-- four separate "all channels" rows for one kind and nothing could say which
-- would be used.
create unique index if not exists message_templates_scope_key
  on public.message_templates (organization_id, kind, channel)
  nulls not distinct;

alter table public.message_templates enable row level security;
alter table public.message_templates force  row level security;

revoke all on public.message_templates from anon, authenticated;
grant select, insert, update, delete
  on public.message_templates to authenticated, service_role;

drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists message_templates_write on public.message_templates;
create policy message_templates_write on public.message_templates
  for all to authenticated
  using (organization_id in (select public.my_organizations()))
  with check (organization_id in (select public.my_organizations()));

-- ── Rehearsal ──────────────────────────────────────────────────────────────
--
-- Exercised, not asserted. Each block RUNS the thing it checks and rolls it
-- back, so a migration that shipped a table accepting a blank message or a
-- second "all channels" row could not complete.
do $$
declare
  v_org uuid;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'message_templates'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'message_templates is not forced';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'message_templates'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon holds a privilege on message_templates';
  end if;

  -- With no organization there is nothing to hang a row on, and the
  -- constraints below are what this rehearsal exists to exercise. Say so
  -- rather than passing silently: a rehearsal that quietly checks nothing is
  -- the failure this codebase has already been bitten by.
  select id into v_org from public.organizations limit 1;

  if v_org is null then
    raise notice
      'no organization exists, so the constraint rehearsal did NOT run';
  else
    begin
      -- A blank message must be impossible, not merely discouraged.
      begin
        insert into public.message_templates (organization_id, kind, body)
        values (v_org, 'arrival_info'::public.guest_message_kind, '   ');
        raise exception 'message_templates accepted a blank body';
      exception
        when check_violation then null;
      end;

      -- And a second "all channels" row for one kind must collide, which is
      -- what NULLS NOT DISTINCT buys.
      insert into public.message_templates (organization_id, kind, body)
      values (v_org, 'arrival_info'::public.guest_message_kind, 'רפטיציה');

      begin
        insert into public.message_templates (organization_id, kind, body)
        values (v_org, 'arrival_info'::public.guest_message_kind, 'רפטיציה שנייה');
        raise exception 'two all-channel templates were accepted for one kind';
      exception
        when unique_violation then null;
      end;

      raise exception 'ESTIA_REHEARSAL_ROLLBACK';
    exception
      when others then
        if sqlerrm <> 'ESTIA_REHEARSAL_ROLLBACK' then raise; end if;
    end;
  end if;

  if exists (select 1 from public.message_templates) then
    raise exception 'the rehearsal left a template behind';
  end if;
end $$;
