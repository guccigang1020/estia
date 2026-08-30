-- ============================================================================
-- agent_membership.sql — ESTIA · proof for 0025
--
-- What this is
--   The evidence that a general manager can run the agent network they are
--   documented as owning, and that giving them that did not quietly give them
--   the organization's team screen.
--
--   Before 0025, `general_manager` held `agent.view/invite/manage/scope.manage`
--   and neither `user.edit` nor `role.assign` — and *adding* an agent writes
--   `membership_roles` while *suspending* one writes `memberships`. So the two
--   acts at the centre of the feature were owner-and-administrator-only.
--
--   The obvious repair was to add `user.edit` to the role, and it would have
--   been a privilege escalation: `memberships_update` guards every membership
--   in the organization, so whoever runs the sellers could have suspended an
--   administrator. Every NEGATIVE assertion below is that escalation, tried.
--
--   Read the pair at seq 5 and 6 together. The first is an administrator, and
--   the second is an administrator who *is also an agent* — a real
--   configuration, and the one a rule written as "only agent memberships"
--   would have admitted. The policy asks about the grants the target holds,
--   not about what it is called.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_membership.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion plus a TOTAL.
--
-- Depends on
--   0001 … 0025, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table membership_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org  constant uuid := 'aa000000-8888-4000-8000-0000000000f0';

  -- The general manager: the role the catalogue says owns the network.
  u_gm constant uuid := 'aa000000-8888-4000-8000-000000000001';
  -- An administrator. Holds user.edit and role.assign, and must stay beyond
  -- the general manager's reach in both directions.
  u_ad constant uuid := 'aa000000-8888-4000-8000-000000000002';
  -- A plain agent: sales_agent, with terms. The one the GM may manage.
  u_ag constant uuid := 'aa000000-8888-4000-8000-000000000003';
  -- An administrator who is ALSO an agent. Has terms, and elevated authority.
  u_aa constant uuid := 'aa000000-8888-4000-8000-000000000004';
  -- A cleaner. Not an agent, and must not become one by role assignment.
  u_cl constant uuid := 'aa000000-8888-4000-8000-000000000005';
  -- A membership under construction: created, no role yet, no terms yet.
  -- This is the state attachExistingUser inserts the preset role into.
  u_nw constant uuid := 'aa000000-8888-4000-8000-000000000006';

  m_gm constant uuid := 'bb000000-8888-4000-8000-000000000001';
  m_ad constant uuid := 'bb000000-8888-4000-8000-000000000002';
  m_ag constant uuid := 'bb000000-8888-4000-8000-000000000003';
  m_aa constant uuid := 'bb000000-8888-4000-8000-000000000004';
  m_cl constant uuid := 'bb000000-8888-4000-8000-000000000005';
  m_nw constant uuid := 'bb000000-8888-4000-8000-000000000006';

  role_gm uuid;
  role_ad uuid;
  role_sa uuid;
  role_cl uuid;

  n_rows bigint;
  err    text;
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into role_gm from public.roles where code = 'general_manager' and organization_id is null;
  select id into role_ad from public.roles where code = 'administrator'   and organization_id is null;
  select id into role_sa from public.roles where code = 'sales_agent'     and organization_id is null;
  select id into role_cl from public.roles where code = 'cleaner'         and organization_id is null;

  insert into auth.users (id, email) values
    (u_gm, 'mem-gm@estia.test'),
    (u_ad, 'mem-ad@estia.test'),
    (u_ag, 'mem-ag@estia.test'),
    (u_aa, 'mem-aa@estia.test'),
    (u_cl, 'mem-cl@estia.test'),
    (u_nw, 'mem-nw@estia.test');

  insert into public.organizations (id, slug, name) values
    (org, 'membership-org', 'Membership Organization');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (m_gm, u_gm, org, 'active', now()),
    (m_ad, u_ad, org, 'active', now()),
    (m_ag, u_ag, org, 'active', now()),
    (m_aa, u_aa, org, 'active', now()),
    (m_cl, u_cl, org, 'active', now()),
    (m_nw, u_nw, org, 'active', now());

  -- m_nw deliberately gets no role at all.
  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (m_gm, org, role_gm),
    (m_ad, org, role_ad),
    (m_ag, org, role_sa),
    (m_aa, org, role_ad),
    (m_aa, org, role_sa),
    (m_cl, org, role_cl);

  insert into public.agent_organization_settings
    (organization_id, agent_user_id, membership_id, access_calendar, access_price, created_by)
  values
    (org, u_ag, m_ag, 'availability_booking', 'agent', u_gm),
    (org, u_aa, m_aa, 'availability_booking', 'agent', u_gm);

  ---------------------------------------------------------------------------
  -- 1 · The seed, without which every policy below admits nobody
  ---------------------------------------------------------------------------
  -- A policy naming a code no role holds denies everyone, silently. 0011 made
  -- exactly that mistake with the commission codes and said so.
  insert into membership_results (area, name, expected, actual, passed)
  select 'seed', 'general_manager holds agent.membership.manage', 'true',
         exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'agent.membership.manage'
         )::text,
         exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'agent.membership.manage'
         );

  perform set_config('request.jwt.claims',
    json_build_object('sub', u_gm::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select public.has_permission(org, 'agent.membership.manage')::int into n_rows;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('seed', 'has_permission answers true for the general manager', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 2 · What the general manager CAN now do
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    update public.memberships set status = 'suspended' where id = m_ag;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('allowed', 'suspends an agent — the button that has to work at once', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
    values (m_nw, org, role_sa);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('allowed', 'gives a role-less new membership the preset role', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 3 · The escalation, tried in every direction
  ---------------------------------------------------------------------------
  -- An UPDATE refused by a policy matches zero rows rather than raising, which
  -- is why these read row counts and the INSERTs below read 42501.
  begin
    execute 'set local role authenticated';
    update public.memberships set status = 'suspended' where id = m_ad;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot suspend an administrator', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.memberships set status = 'suspended' where id = m_aa;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot suspend an administrator who is ALSO an agent', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.memberships set status = 'suspended' where id = m_cl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot touch a staff membership that is not an agent', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
    values (m_cl, org, role_sa);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot turn a cleaner into a seller', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
    values (m_ad, org, role_sa);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot bolt an agent role onto an administrator', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  -- The one that would have been the whole point of stealing the grant.
  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
    values (m_nw, org, role_gm);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot assign a non-agent role to anybody', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  ---------------------------------------------------------------------------
  -- 4 · Controls — 0025 took nothing away
  ---------------------------------------------------------------------------
  -- Both policies are additional and permissive. If either of these fails, the
  -- migration narrowed the team screen for every administrator in the product
  -- while nobody was looking.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_ad::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.memberships set status = 'suspended' where id = m_cl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('control', 'user.edit still reaches every membership', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
    values (m_cl, org, role_sa);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into membership_results (area, name, expected, actual, passed) values
    ('control', 'role.assign still assigns any role anywhere', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);
end $$;

insert into membership_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from membership_results;

select seq, area, name, expected, actual, passed from membership_results order by seq;

rollback;
