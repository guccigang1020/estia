-- ============================================================================
-- agent_scope_authority.sql — ESTIA · proof for 0026 §3
--
-- What this is
--   The evidence that the person who runs the agent network can record what an
--   agent may sell, and that giving them that did not give them the ability to
--   re-scope anybody else in the organization.
--
--   `Actor.scope` comes from `membership_scopes`. `attachExistingUser` wrote a
--   membership, its role and its terms and no scope row at all, so every agent
--   in the product resolved to the `own_records` fallback — which reaches no
--   property and no unit, because neither carries an assignee. Their configured
--   inventory reach was stored, shown on the settings screen, and read by
--   nothing.
--
--   The repair is a row rather than a projection onto `Actor.scopeOverrides`,
--   because `scopeFor` in src/lib/authz/can.ts REPLACES a scope rather than
--   intersecting it: projecting the stored reach would have widened every
--   agent from nothing to whatever a settings screen named, `all_properties`
--   included, which converts to `all_organization`. A row is something an
--   authority granted, and this file is the proof that the authority is
--   narrow.
--
--   `membership_scopes_insert` from 0004 requires `role.assign`, which 0025
--   explains at length that the network manager must not hold: it guards every
--   membership in the organization. So `general_manager` needed a policy of
--   its own, and every NEGATIVE assertion below is the escalation that policy
--   must not permit.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_scope_authority.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion, then a TOTAL.
--
-- Depends on
--   0001 … 0026, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table scope_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org  constant uuid := 'af000000-7777-4000-8000-0000000000f0';

  -- The general manager: holds agent.scope.manage and not role.assign, which
  -- is the whole reason this policy exists.
  u_gm constant uuid := 'af000000-7777-4000-8000-000000000001';
  -- An administrator. Holds role.assign, and must stay beyond reach.
  u_ad constant uuid := 'af000000-7777-4000-8000-000000000002';
  -- A plain agent with terms. The one membership the GM may scope.
  u_ag constant uuid := 'af000000-7777-4000-8000-000000000003';
  -- An administrator who is ALSO an agent: has terms, and elevated authority.
  u_aa constant uuid := 'af000000-7777-4000-8000-000000000004';
  -- A cleaner, with a scope row already, so the refused UPDATE below is
  -- refused by the policy rather than by the row being absent.
  u_cl constant uuid := 'af000000-7777-4000-8000-000000000005';

  m_gm constant uuid := 'b0000000-7777-4000-8000-000000000001';
  m_ad constant uuid := 'b0000000-7777-4000-8000-000000000002';
  m_ag constant uuid := 'b0000000-7777-4000-8000-000000000003';
  m_aa constant uuid := 'b0000000-7777-4000-8000-000000000004';
  m_cl constant uuid := 'b0000000-7777-4000-8000-000000000005';

  p_1  constant uuid := 'b1000000-7777-4000-8000-000000000001';
  t_1  constant uuid := 'b2000000-7777-4000-8000-000000000001';

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
    (u_gm, 'sc-gm@estia.test'),
    (u_ad, 'sc-ad@estia.test'),
    (u_ag, 'sc-ag@estia.test'),
    (u_aa, 'sc-aa@estia.test'),
    (u_cl, 'sc-cl@estia.test');

  insert into public.organizations (id, slug, name) values
    (org, 'scope-org', 'Scope Organization');

  -- Real rows, because `tg_validate_scope_refs` on membership_scopes checks
  -- that every id in the arrays exists inside this organization.
  insert into public.properties (id, organization_id, slug, name) values
    (p_1, org, 'villa-one', 'Villa One');
  insert into public.teams (id, organization_id, name) values
    (t_1, org, 'Housekeeping');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (m_gm, u_gm, org, 'active', now()),
    (m_ad, u_ad, org, 'active', now()),
    (m_ag, u_ag, org, 'active', now()),
    (m_aa, u_aa, org, 'active', now()),
    (m_cl, u_cl, org, 'active', now());

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

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (m_cl, org, 'own_records');

  ---------------------------------------------------------------------------
  -- 1 · The seed, and the reason a second policy was needed at all
  ---------------------------------------------------------------------------
  insert into scope_results (area, name, expected, actual, passed)
  select 'seed', 'general_manager holds agent.scope.manage', 'true',
         exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'agent.scope.manage'
         )::text,
         exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'agent.scope.manage'
         );

  insert into scope_results (area, name, expected, actual, passed)
  select 'seed', 'general_manager does NOT hold role.assign', 'true',
         (not exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'role.assign'
         ))::text,
         not exists (
           select 1 from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'general_manager' and r.organization_id is null
             and rp.permission_code = 'role.assign'
         );

  ---------------------------------------------------------------------------
  -- 2 · What the general manager CAN now do
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_gm::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    insert into public.membership_scopes (membership_id, organization_id, kind, property_ids)
    values (m_ag, org, 'properties', array[p_1]);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('allowed', 'writes an agent inventory reach as the scope row their actor resolves from', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- Both directions, because a row that only ever narrows is the same defect
  -- wearing a ratchet: an owner widening an agent back out on the settings
  -- screen would be silently clamped away by a stale grant.
  begin
    execute 'set local role authenticated';
    update public.membership_scopes
       set kind = 'all_organization', property_ids = '{}'::uuid[]
     where membership_id = m_ag;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('allowed', 'follows a widening made on the settings screen', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.membership_scopes
       set kind = 'properties', property_ids = array[p_1]
     where membership_id = m_ag;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('allowed', 'follows a narrowing too', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 3 · The escalation, tried in every direction
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.membership_scopes (membership_id, organization_id, kind, property_ids)
    values (m_cl, org, 'properties', array[p_1]);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot scope a staff membership that is not an agent', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  begin
    execute 'set local role authenticated';
    update public.membership_scopes set kind = 'all_organization' where membership_id = m_cl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot re-scope a cleaner who already has a row', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    insert into public.membership_scopes (membership_id, organization_id, kind)
    values (m_ad, org, 'all_organization');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot scope an administrator', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  -- The case a rule written as "only agent memberships" would have admitted.
  begin
    execute 'set local role authenticated';
    insert into public.membership_scopes (membership_id, organization_id, kind)
    values (m_aa, org, 'all_organization');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot scope an administrator who is ALSO an agent', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  -- An agent's reach is derived from `AgentInventoryScope`, which has no team
  -- among its variants. A team scope on an agent could only come from
  -- somewhere that is not the agent domain.
  begin
    execute 'set local role authenticated';
    update public.membership_scopes
       set kind = 'team', property_ids = '{}'::uuid[], team_ids = array[t_1]
     where membership_id = m_ag;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot give an agent a team scope', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  ---------------------------------------------------------------------------
  -- 4 · Controls — 0026 took nothing away
  ---------------------------------------------------------------------------
  -- Both policies are additional and permissive. If either of these fails, the
  -- migration narrowed the team screen for every administrator in the product
  -- while nobody was looking.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_ad::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.membership_scopes
       set kind = 'all_organization', property_ids = '{}'::uuid[]
     where membership_id = m_cl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('control', 'role.assign still scopes any membership', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.membership_scopes (membership_id, organization_id, kind, team_ids)
    values (m_ad, org, 'team', array[t_1]);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into scope_results (area, name, expected, actual, passed) values
    ('control', 'role.assign still writes a team scope', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);
end $$;

insert into scope_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from scope_results;

select seq, area, name, expected, actual, passed from scope_results order by seq;

rollback;
