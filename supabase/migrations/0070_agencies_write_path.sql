-- ============================================================================
-- 0070_agencies_write_path.sql — ESTIA · an agency can finally be created
--
-- ── What was wrong ─────────────────────────────────────────────────────────
--
--   `agencies` has existed since 0015. `/leads` and `/promotions` read it,
--   `bookings.agency_id` and `commissions.agency_id` reference it,
--   `agent_organization_settings.agency_id` points at it, and `agent_network`
--   is an entitlement sold in the Direct, Pro and Management plans. And there
--   was no way to put a row in it. A paid feature whose central record cannot
--   be created is a feature that is sold and not delivered.
--
--   Three separate things blocked the write, and each needed its own answer.
--
--   **1 · The creator cannot see what they just created.** `agencies_select`
--   passes a row only for an agency the caller is a member of, or one their
--   organization has a *non-draft* agreement with. At the instant of the
--   INSERT neither is true. Postgres applies SELECT policies to the rows an
--   `INSERT … RETURNING` gives back, and PostgREST always asks for them — so
--   the insert does not return an invisible row, it raises. The agency and its
--   first agreement therefore have to appear **together**, and the id has to be
--   known to whatever writes the agreement.
--
--   Doing that from the request path in two round trips is worse than it looks:
--   `DATABASE_URL` is unset in this deployment, so the application's writes are
--   sequential rather than transactional (see `_lib/wiring.ts`). A failure
--   between the two leaves an agency row that satisfies no SELECT policy for
--   anybody, and no role holds DELETE on this table. That is a permanent,
--   invisible leak, created by the most ordinary failure there is.
--
--   So `create_agency` below is one SECURITY DEFINER function doing both
--   inserts. It is the precedent 0061 set — bridge the gap in the database,
--   never hand a request path a service-role client — and it follows the same
--   discipline: `search_path` pinned to '', every reference schema-qualified,
--   the membership and the grants checked EXPLICITLY inside because RLS is
--   bypassed for the body, and `anon` revoked by name.
--
--   **2 · Nobody could edit an agency.** `agencies_update` requires
--   `is_agency_manager(id)`: editing an agency belongs to the agency, not to a
--   customer of it. That is right for an agency with people in it, and it makes
--   the record unwritable for the one this product actually creates — a stub a
--   guesthouse types in during a phone call, that nobody from the agency has
--   ever signed into.
--
--   The rule added here says exactly that and no more:
--
--       an agency **that has no manager of its own** may be edited by a
--       business that holds `agency.manage` and has a non-draft agreement
--       with it.
--
--   The moment a real manager exists the record is theirs and the business
--   loses write access back to them, with no migration and no hand-over step.
--   The known consequence, stated rather than discovered: two businesses that
--   both signed with the same unclaimed agency can both edit the one global
--   row. They are counterparties of the same legal entity and both can already
--   read every field on it; the alternative is a per-organization copy of an
--   agency, which is the model 0015 rejected in its own header.
--
--   **3 · "Deactivate" had two meanings and the schema models both.**
--   `agencies.status` is global — the entity is or is not a going concern — and
--   `agency_agreements.status` is per-organization: whether *this* business
--   still works with it. One business must not be able to flip a flag a rival
--   reads. `deactivate_agency` therefore always ends the caller's own
--   agreements, and marks the entity inactive only when the caller is the last
--   non-draft party to it and no manager has claimed it. Which of the two
--   happened is returned, so the screen can say what it did instead of
--   guessing. That decision cannot be made in TypeScript: under RLS the caller
--   cannot see whether another organization has an agreement, which is correct
--   and is why this is a definer function too.
--
-- ── STATUS, NEVER SOFT-DELETE — and the column is now sealed ────────────────
--
--   `agencies` carries `deleted_at`/`deleted_by`. Deactivation does not touch
--   them, and after this migration nothing can:
--
--     · `agencies_tax_id_idx` and `agencies_name_idx` are both
--       `where deleted_at is null`. Soft-deleting an agency frees its tax id —
--       the state's own identifier for the legal entity — for re-entry. The
--       same agency then exists twice with its commission history split across
--       two rows, which is the precise failure that unique index was added to
--       prevent.
--     · `bookings.agency_id` and `commissions.agency_id` are `on delete
--       restrict` and no role holds DELETE here, so the row is permanent
--       whatever this column says. All `deleted_at` can do is make the payee of
--       an unpaid commission stop resolving in every read that filters on it.
--     · 0015 chose *non-draft* rather than *active* in
--       `agencies_my_organizations_work_with()` for exactly this reason: "an
--       agency that stopped working with a business in March is still owed
--       money on stays happening in August". Ending the agreement keeps it
--       non-draft, so a deactivated agency stays readable and every historical
--       commission still names its payee.
--     · `status = 'inactive'` is a commercial statement — we no longer trade
--       with them. `deleted_at` is an existence statement. Only the first is
--       true, and a column with no legitimate writer is a trap, not an option.
--
--   `tg_agencies_never_soft_deleted` refuses the write outright. The rehearsal
--   at the foot RUNS it against a real row rather than checking that it exists.
--
-- ── No new personal data ───────────────────────────────────────────────────
--
--   docs/PERSONAL_DATA_INVENTORY.md already lists `agencies` as holding
--   כתובת · דוא״ל · טלפון. This migration adds no personal column: everything
--   the write path stores was already in the table since 0015. The three
--   columns added — `deactivated_at`, `deactivated_by`, `deactivation_reason` —
--   are a decision and its justification, in the same shape
--   `agency_agreements.terminated_at`/`termination_reason` and
--   `guest_reviews.hidden_at`/`hidden_reason` already use. `deactivated_by` is
--   an `auth.users` id, which the table already carries four of.
--
-- Depends on
--   0004 (my_organizations, memberships, has_permission), 0015 (agencies,
--   agency_memberships, agency_agreements, agent_commission_rules,
--   is_agency_manager), 0017 (the rule-shape checks), 0018 (commission_base's
--   six members).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Why an agency stopped
-- ============================================================================
-- A status with no stored reason is a status somebody has to reconstruct from
-- the audit log, and the audit log is not on this screen.

alter table public.agencies
  add column if not exists deactivated_at     timestamptz;
alter table public.agencies
  add column if not exists deactivated_by     uuid references auth.users (id) on delete set null;
alter table public.agencies
  add column if not exists deactivation_reason text;

comment on column public.agencies.deactivation_reason is
  'Why this agency was marked inactive, in the words of whoever did it. Stored on the row as well as in the audit event: the audit event is the one that cannot be changed afterwards, and this is the one anybody with the screen can read.';

-- Rows that were already inactive predate the reason, and inventing one for
-- them would be a fabricated record. They are stamped with what is actually
-- known: that they were deactivated before there was anywhere to write why.
update public.agencies
   set deactivated_at = coalesce(deactivated_at, updated_at),
       deactivation_reason = coalesce(
         deactivation_reason,
         'הסוכנות סומנה כלא פעילה לפני שהיה שדה לנימוק. הסיבה המקורית אינה ידועה.'
       )
 where status = 'inactive'::public.agency_status
   and deactivated_at is null;

-- Reactivating has to clear the three, so the pair can never describe a state
-- the status column contradicts.
alter table public.agencies
  drop constraint if exists agencies_inactive_pair;
alter table public.agencies
  add constraint agencies_inactive_pair check (
    (status = 'inactive'::public.agency_status) = (deactivated_at is not null)
  );

-- Eight characters, the same floor `review.hide` uses and for the same reason:
-- a one-character reason is a checkbox with extra steps, and eight is the point
-- at which somebody has to write a short phrase rather than press a key. The
-- whole value of storing it is that a human reads it later and judges.
alter table public.agencies
  drop constraint if exists agencies_deactivation_reason_meaningful;
alter table public.agencies
  add constraint agencies_deactivation_reason_meaningful check (
    deactivated_at is null or length(btrim(coalesce(deactivation_reason, ''))) >= 8
  );


-- ============================================================================
-- 2 · The soft-delete column is sealed
-- ============================================================================
-- Read the header. `deleted_at` on this table can only ever hide a counterparty
-- the business still owes money to, and free a tax id that identifies a legal
-- entity. There is no caller entitled to write it.

create or replace function public.tg_agencies_never_soft_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    raise exception
      'an agency is deactivated, never deleted: soft-deleting it frees its tax id and stops the payee of an unpaid commission from resolving'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.tg_agencies_never_soft_deleted() is
  'Refuses any write of agencies.deleted_at. bookings.agency_id and commissions.agency_id reference this row with ON DELETE RESTRICT and no role holds DELETE, so the row is permanent regardless; all deleted_at could do is drop the agency out of agencies_tax_id_idx and agencies_name_idx — freeing the legal entity tax id for re-entry, and splitting one agency commission history across two rows. Deactivation is the status column.';

drop trigger if exists agencies_never_soft_deleted on public.agencies;
create trigger agencies_never_soft_deleted
  before update on public.agencies
  for each row execute function public.tg_agencies_never_soft_deleted();


-- ============================================================================
-- 3 · Who may edit an agency
-- ============================================================================
-- Both helpers are SECURITY DEFINER with an empty search_path, exactly as
-- 0015's three are and for the same reason: a policy on `agencies` that read
-- `agency_memberships` or `agency_agreements` directly would recurse through
-- those tables' own policies.

create or replace function public.agency_is_unclaimed(target_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.agency_memberships am
    where am.agency_id = agency_is_unclaimed.target_agency_id
      and am.status = 'active'::public.agency_membership_status
      and am.role = 'manager'::public.agency_member_role
  );
$$;

comment on function public.agency_is_unclaimed(uuid) is
  'Has nobody from this agency ever taken charge of its own record? True for the stub a guesthouse types in during a telephone call, false the moment a real manager exists. The hinge of the agencies_update policy: an unclaimed record is editable by the business that entered it, and a claimed one belongs to the agency.';

create or replace function public.agency_stewarded_by_me(target_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.agency_agreements aa
    join public.memberships m on m.organization_id = aa.organization_id
    where aa.agency_id = agency_stewarded_by_me.target_agency_id
      and aa.status <> 'draft'::public.agency_agreement_status
      and m.user_id = (select auth.uid())
      and m.status = 'active'::public.membership_status
      and public.has_permission(m.organization_id, 'agency.manage')
  );
$$;

comment on function public.agency_stewarded_by_me(uuid) is
  'Does the caller hold agency.manage in an organization that has a non-draft agreement with this agency? The other half of agencies_update. Non-draft, matching agencies_my_organizations_work_with(): a draft is not a relationship, and correcting a typo in the name of a counterparty you still owe money to must not stop the day the agreement ends.';

revoke all on function public.agency_is_unclaimed(uuid) from public, anon;
revoke all on function public.agency_stewarded_by_me(uuid) from public, anon;
grant execute on function public.agency_is_unclaimed(uuid) to authenticated, service_role;
grant execute on function public.agency_stewarded_by_me(uuid) to authenticated, service_role;

-- Replaces the 0015 policy. The `is_agency_manager` branch is unchanged and
-- still wins on its own; the second branch is the addition.
drop policy if exists agencies_update on public.agencies;
create policy agencies_update on public.agencies
  for update to authenticated
  using (
    public.is_agency_manager(id)
    or (
      public.agency_is_unclaimed(id)
      and public.agency_stewarded_by_me(id)
    )
  )
  with check (
    public.is_agency_manager(id)
    or (
      public.agency_is_unclaimed(id)
      and public.agency_stewarded_by_me(id)
    )
  );


-- ============================================================================
-- 4 · One default commission rule per agency, per business
-- ============================================================================
-- `selectCommissionRule` in src/lib/agents/commission.ts breaks a tie between
-- two rules of equal priority and equal specificity by comparing their ids —
-- which is to say, arbitrarily. Two unscoped agency rules in one organization
-- are therefore two different amounts of money depending on which uuid sorted
-- first. The screen writes exactly one, and this index is what makes that true
-- against a concurrent second writer as well as against a careful one.
--
-- The predicate is the definition of "the agency's default": belongs to the
-- agency and not to a named agent, with no property, unit, rate-plan or period
-- narrowing. A scoped agency rule — "12% at the seaside cabins in August" — is
-- outside it and stays possible.

do $$
declare
  dupes integer;
begin
  select count(*) into dupes
  from (
    select organization_id, agency_id
    from public.agent_commission_rules
    where agency_id is not null
      and agent_user_id is null
      and property_ids is null and unit_ids is null and rate_plan_ids is null
      and period_from is null and period_to is null
      and deleted_at is null
    group by organization_id, agency_id
    having count(*) > 1
  ) d;

  if dupes > 0 then
    -- Loud, and it does not pick a winner. Two unscoped rules for one agency
    -- are two negotiated deals or one duplicate, and only a person knows which.
    raise exception
      '0070: % organization/agency pairs already hold more than one unscoped agency commission rule. Resolve them by hand — choosing one here would silently change what an agency is paid.', dupes;
  end if;
end $$;

create unique index if not exists agent_commission_rules_agency_default_idx
  on public.agent_commission_rules (organization_id, agency_id)
  where agency_id is not null
    and agent_user_id is null
    and property_ids is null and unit_ids is null and rate_plan_ids is null
    and period_from is null and period_to is null
    and deleted_at is null;


-- ============================================================================
-- 5 · create_agency — the agency and its first agreement, together
-- ============================================================================

create or replace function public.create_agency(
  p_organization_id    uuid,
  p_name               text,
  p_tax_id             text default null,
  p_contact_phone      text default null,
  p_contact_email      text default null,
  p_address_line1      text default null,
  p_city               text default null,
  p_country            text default 'IL',
  p_note               text default null,
  p_rule               jsonb default '{"kind":"none"}'::jsonb,
  p_base               text default 'stay_total',
  p_active_from        date default current_date,
  p_payment_terms_days integer default 30
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agency_id uuid;
begin
  if p_organization_id is null then
    raise exception 'an agency is created by a business, and none was named'
      using errcode = '22004';
  end if;

  -- SECURITY DEFINER bypasses row level security for this body, so these two
  -- are not belt-and-braces: they are the ONLY authorization left in here.
  -- Without the first, any signed-in user could create an agency inside a
  -- business they have never worked for by passing its id.
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  -- Both grants, because this writes both rows. `agency.manage` is what
  -- agencies_insert asks for; `agent_agreement.manage` is what
  -- agency_agreements_insert asks for, and it is in SENSITIVE_ACTIONS because
  -- the agreement is the price of every future sale.
  if not public.has_permission(p_organization_id, 'agency.manage') then
    raise exception 'agency.manage is required to create an agency'
      using errcode = '42501';
  end if;
  if not public.has_permission(p_organization_id, 'agent_agreement.manage') then
    raise exception 'agent_agreement.manage is required to sign an agreement'
      using errcode = '42501';
  end if;

  insert into public.agencies (
    name, tax_id, contact_phone, contact_email,
    address_line1, city, country, note,
    status, created_by, updated_by
  ) values (
    btrim(p_name),
    nullif(btrim(coalesce(p_tax_id, '')), ''),
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    -- No cast: `citext` lives in the `extensions` schema and this function's
    -- search_path is '', so naming the type here would not resolve. INSERT
    -- applies the assignment cast text → citext on its own.
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    nullif(btrim(coalesce(p_address_line1, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    upper(coalesce(nullif(btrim(coalesce(p_country, '')), ''), 'IL')),
    nullif(btrim(coalesce(p_note, '')), ''),
    'active'::public.agency_status,
    (select auth.uid()),
    (select auth.uid())
  )
  returning id into v_agency_id;

  -- `active`, not `draft`, and that is the whole reason this function exists.
  -- agencies_select passes a row only for a NON-DRAFT agreement, so an agency
  -- created with a draft agreement would be invisible to the person who just
  -- created it — and no role holds DELETE on either table to clean it up.
  insert into public.agency_agreements (
    agency_id, organization_id, rule, base,
    active_from, payment_terms_days, status, signed_at,
    created_by, updated_by
  ) values (
    v_agency_id,
    p_organization_id,
    coalesce(p_rule, '{"kind":"none"}'::jsonb),
    coalesce(p_base, 'stay_total')::public.commission_base,
    coalesce(p_active_from, current_date),
    coalesce(p_payment_terms_days, 30),
    'active'::public.agency_agreement_status,
    now(),
    (select auth.uid()),
    (select auth.uid())
  );

  return v_agency_id;
end;
$$;

comment on function public.create_agency(uuid, text, text, text, text, text, text, text, text, jsonb, text, date, integer) is
  'Creates an agency and the caller organization first agreement with it, in one statement pair. Both are needed at once because agencies_select passes a row only for a non-draft agreement — so INSERT … RETURNING on agencies alone raises, and two sequential writes from the request path can leave an agency no policy will ever show and no role can delete. SECURITY DEFINER for that reason and no other: membership and both grants are checked explicitly inside, because RLS is bypassed for this body.';

revoke all on function public.create_agency(uuid, text, text, text, text, text, text, text, text, jsonb, text, date, integer)
  from public, anon;
grant execute on function public.create_agency(uuid, text, text, text, text, text, text, text, text, jsonb, text, date, integer)
  to authenticated, service_role;


-- ============================================================================
-- 6 · deactivate_agency — end the relationship, and say what that reached
-- ============================================================================

create or replace function public.deactivate_agency(
  p_agency_id       uuid,
  p_organization_id uuid,
  p_reason          text
)
-- `jsonb` rather than `returns table`, so the answer has the same shape through
-- PostgREST and through the SQL transaction client in
-- src/lib/persistence/postgrest-sql.ts. A set-returning function comes back as
-- an array from one and a record from the other, and a write path that has to
-- ask which connection it is on is a write path that reads the wrong one.
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ended     integer := 0;
  v_others    boolean;
  v_unclaimed boolean;
begin
  if p_agency_id is null or p_organization_id is null then
    raise exception 'both the agency and the business must be named'
      using errcode = '22004';
  end if;

  -- See create_agency: RLS is bypassed here, so these are the only boundary.
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;
  if not public.has_permission(p_organization_id, 'agency.manage') then
    raise exception 'agency.manage is required to deactivate an agency'
      using errcode = '42501';
  end if;

  -- Eight characters, the floor agencies_deactivation_reason_meaningful sets.
  -- Checked here too so the refusal arrives before anything is written, rather
  -- than as a constraint violation after the agreements have been ended.
  if length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'a deactivation reason of at least 8 characters is required'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.agency_agreements aa
    where aa.agency_id = p_agency_id
      and aa.organization_id = p_organization_id
      and aa.status <> 'draft'::public.agency_agreement_status
  ) then
    raise exception 'this business has no agreement with that agency'
      using errcode = '42501';
  end if;

  -- The per-organization half, and always. Terminated is still NON-DRAFT, so
  -- the agency stays visible to this business and the payee of every unpaid
  -- commission keeps resolving. Nothing on commissions or bookings is touched.
  update public.agency_agreements
     set status             = 'terminated'::public.agency_agreement_status,
         terminated_at      = now(),
         termination_reason = btrim(p_reason),
         -- Today, unless the agreement had not started yet — in which case it
         -- ends on the day it would have begun, because
         -- agency_agreements_dates_ordered refuses an end before the start.
         -- An end date already in the past is left where it is.
         active_until       = least(
                                coalesce(active_until,
                                         greatest(current_date, active_from)),
                                greatest(current_date, active_from)
                              ),
         updated_by         = (select auth.uid())
   where agency_id = p_agency_id
     and organization_id = p_organization_id
     and status = 'active'::public.agency_agreement_status;

  get diagnostics v_ended = row_count;

  -- The global half, and only when it is nobody else's to contradict.
  -- `agencies.status` says the entity is or is not a going concern; one
  -- business must not be able to write that on behalf of a rival that still
  -- sells through it.
  select exists (
    select 1 from public.agency_agreements aa
    where aa.agency_id = p_agency_id
      and aa.organization_id <> p_organization_id
      and aa.status <> 'draft'::public.agency_agreement_status
  ) into v_others;

  v_unclaimed := public.agency_is_unclaimed(p_agency_id);

  if not v_others and v_unclaimed then
    update public.agencies
       set status              = 'inactive'::public.agency_status,
           deactivated_at      = now(),
           deactivated_by      = (select auth.uid()),
           deactivation_reason = btrim(p_reason),
           updated_by          = (select auth.uid())
     where id = p_agency_id
       and status = 'active'::public.agency_status;
  end if;

  return jsonb_build_object(
    'agreements_ended', v_ended,
    'entity_marked_inactive', (not v_others and v_unclaimed)
  );
end;
$$;

comment on function public.deactivate_agency(uuid, uuid, text) is
  'Ends this business relationship with an agency, and marks the agency itself inactive only when this business is its last non-draft counterparty and no agency manager has claimed it. agencies.status is global and agency_agreements.status is per-organization; one business flipping the global flag would be writing on behalf of a rival. Deleting nothing is the point: the agreement stays non-draft so the agency stays nameable on every commission it is still owed.';

revoke all on function public.deactivate_agency(uuid, uuid, text) from public, anon;
grant execute on function public.deactivate_agency(uuid, uuid, text)
  to authenticated, service_role;


-- ============================================================================
-- Rehearsal
-- ============================================================================
-- Exercised, not asserted. Every check below RUNS the thing it is checking.
--
-- The fixture is created and rolled back through a subtransaction: a plpgsql
-- BEGIN … EXCEPTION block is one, so raising a sentinel at the end of it undoes
-- the INSERT while the boolean recording what happened survives — plpgsql
-- variables are memory and are not rolled back.

do $$
declare
  -- `v_` on everything, including the loop variable. An unqualified `proname`
  -- inside a query over pg_proc is ambiguous between the plpgsql variable and
  -- the catalogue column, and plpgsql raises rather than guessing.
  v_name       text;
  v_cfg        text;
  v_id         uuid := '00000000-0000-4000-8000-000000000070';
  v_refused    boolean := false;
  v_reasonless boolean := false;
begin
  -- Every function this file adds has a pinned search_path. A SECURITY DEFINER
  -- function without one can be pointed at a shadowing table by its caller.
  for v_name, v_cfg in
    select p.proname, array_to_string(p.proconfig, ',')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_agency', 'deactivate_agency',
                        'agency_is_unclaimed', 'agency_stewarded_by_me',
                        'tg_agencies_never_soft_deleted')
  loop
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception '% has a mutable search_path', v_name;
    end if;
  end loop;

  -- Supabase ALTER DEFAULT PRIVILEGES grants anon EXECUTE on every new function
  -- in `public`, and a REVOKE FROM PUBLIC leaves that grant standing — 0004
  -- found this against pg_proc.proacl rather than assuming it.
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('create_agency', 'deactivate_agency',
                           'agency_is_unclaimed', 'agency_stewarded_by_me')
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon may execute an agency write path';
  end if;

  -- The tenant guard, run rather than read. As the migration role there is no
  -- auth.uid(), so my_organizations() is empty and every id is foreign — which
  -- is exactly the case that must be refused. If this stops raising, the
  -- function has stopped checking membership.
  begin
    perform public.create_agency(
      '00000000-0000-4000-8000-000000000000', 'rehearsal');
    raise exception 'create_agency accepted an organization the caller is not in';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.deactivate_agency(
      '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000',
      'a reason long enough to pass the length floor');
    raise exception 'deactivate_agency accepted an organization the caller is not in';
  exception
    when insufficient_privilege then null;
  end;

  -- The soft-delete seal, against a real row. Both the guard firing and the
  -- fixture disappearing afterwards matter: an agency left behind by a
  -- rehearsal is an agency nobody can delete.
  --
  -- The INSERT works despite `force row level security` because this file runs
  -- as `postgres`, whose rolbypassrls is true — the same fact 0015 relies on to
  -- keep its policy helpers from recursing.
  begin
    insert into public.agencies (id, name, status)
    values (v_id, 'רהרסל 0070', 'active'::public.agency_status);

    begin
      update public.agencies set deleted_at = now() where id = v_id;
    exception
      when others then v_refused := true;
    end;

    -- And the pair constraint: inactive without a stamp is a state the screen
    -- would render as "deactivated, reason unknown".
    begin
      update public.agencies
         set status = 'inactive'::public.agency_status
       where id = v_id;
    exception
      when others then v_reasonless := true;
    end;

    raise exception 'rehearsal rollback' using errcode = 'ES070';
  exception
    when sqlstate 'ES070' then null;
  end;

  if not v_refused then
    raise exception 'an agency could be soft-deleted, so an unpaid commission can lose its payee';
  end if;
  if not v_reasonless then
    raise exception 'an agency could be marked inactive with no deactivated_at, so the screen cannot say why';
  end if;

  if exists (select 1 from public.agencies where id = v_id) then
    raise exception 'the rehearsal left an agency behind, and no role can delete it';
  end if;
end $$;
