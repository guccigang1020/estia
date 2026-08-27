-- ============================================================================
-- isolation.sql — ESTIA · proof that tenant isolation holds in the database
--
-- What this is
--   The TypeScript engine in src/lib/authz proves the application floor. This
--   file proves the lower one: that Postgres itself refuses to hand a member
--   of organization A a single row belonging to organization B, whatever the
--   application does.
--
--   Every assertion below is executed as a real `authenticated` session, with
--   request.jwt.claims set the way GoTrue sets it, so auth.uid() returns the
--   test user. Nothing is asserted against the owner connection, because the
--   owner is exactly the actor RLS does not constrain.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/isolation.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   The whole script runs inside one transaction and ends with ROLLBACK, so it
--   leaves no rows behind. It prints one row per assertion and a final tally;
--   `passed = false` anywhere is a security defect, not a flaky test.
--
-- Depends on
--   0001_identity.sql … 0005_audit.sql, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table isolation_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '11111111-1111-4111-8111-111111111111';
  org_b   constant uuid := '22222222-2222-4222-8222-222222222222';
  user_a  constant uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  user_s  constant uuid := 'cccccccc-0000-4000-8000-00000000000c';
  mem_a   constant uuid := 'dddddddd-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'dddddddd-0000-4000-8000-00000000000b';
  mem_s   constant uuid := 'dddddddd-0000-4000-8000-00000000000c';

  owner_role   uuid;
  basic_plan   uuid;
  role_a       uuid;
  role_b       uuid;
  audit_a      uuid;
  audit_b      uuid;

  n_all   bigint;
  n_other bigint;
  n_rows  bigint;
  err     text;
begin
  ---------------------------------------------------------------------------
  -- Fixture. Written as the owner, which has BYPASSRLS: setting up the world
  -- is not what is under test.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;
  select id into basic_plan from public.plans where code = 'basic';

  insert into auth.users (id, email) values
    (user_a, 'isolation-a@estia.test'),
    (user_b, 'isolation-b@estia.test'),
    (user_s, 'isolation-suspended@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'isolation-org-a', 'Organization A'),
    (org_b, 'isolation-org-b', 'Organization B');

  insert into public.user_profiles (id, full_name) values
    (user_a, 'User A'), (user_b, 'User B'), (user_s, 'User Suspended');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active',    now()),
    (mem_b, user_b, org_b, 'active',    now()),
    (mem_s, user_s, org_a, 'suspended', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role),
    (mem_s, org_a, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization'),
    (mem_s, org_a, 'all_organization');

  insert into public.invitations (organization_id, email, role_id, token_hash, expires_at) values
    (org_a, 'invitee-a@estia.test', owner_role, 'isolation-hash-a', now() + interval '7 days'),
    (org_b, 'invitee-b@estia.test', owner_role, 'isolation-hash-b', now() + interval '7 days');

  insert into public.organization_subscriptions
    (organization_id, plan_id, agreed_monthly_price_agorot, agreed_yearly_price_agorot) values
    (org_a, basic_plan, 14900, 149000),
    (org_b, basic_plan, 14900, 149000);

  insert into public.audit_events
    (organization_id, actor_user_id, actor_label, action, resource_type, summary)
  values
    (org_a, user_a, 'User A', 'booking.create', 'booking', 'A created a booking')
  returning id into audit_a;

  insert into public.audit_events
    (organization_id, actor_user_id, actor_label, action, resource_type, summary)
  values
    (org_b, user_b, 'User B', 'booking.create', 'booking', 'B created a booking')
  returning id into audit_b;

  insert into public.roles (organization_id, code, name, is_system) values
    (org_a, 'isolation_custom_a', 'Custom role A', false) returning id into role_a;
  insert into public.roles (organization_id, code, name, is_system) values
    (org_b, 'isolation_custom_b', 'Custom role B', false) returning id into role_b;

  insert into public.role_permissions (role_id, permission_code) values
    (role_a, 'booking.view'), (role_b, 'booking.view');

  ---------------------------------------------------------------------------
  -- Impersonate user A: an active member of organization A and nothing else.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- auth.uid() must actually be user A, or every assertion below is vacuous.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  -- ── SELECT: only organization A's rows, table by table ───────────────────
  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.organizations;
    select count(*) into n_other from public.organizations where id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'organizations: A sees 1 org, none of B', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.memberships;
    select count(*) into n_other from public.memberships where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'memberships: A sees only A''s 2 memberships', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.invitations;
    select count(*) into n_other from public.invitations where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'invitations: A sees only A''s invitation', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.membership_roles;
    select count(*) into n_other from public.membership_roles where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'membership_roles: A sees only A''s 2 rows', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.membership_scopes;
    select count(*) into n_other from public.membership_scopes where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'membership_scopes: A sees only A''s 2 rows', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.organization_subscriptions;
    select count(*) into n_other from public.organization_subscriptions where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'organization_subscriptions: A sees only A''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.audit_events;
    select count(*) into n_other from public.audit_events where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'audit_events: A sees only A''s event', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.roles where organization_id is not null;
    select count(*) into n_other from public.roles where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'roles: A sees its own custom role, not B''s', 'custom=1 b=0',
     'custom=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.role_permissions rp
      join public.roles r on r.id = rp.role_id where r.organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'role_permissions: B''s custom grants invisible', 'b=0',
     'b=' || n_other || coalesce(' err=' || err, ''), n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.user_profiles where id = user_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('select', 'user_profiles: B''s profile invisible to A', 'b=0',
     'b=' || n_other || coalesce(' err=' || err, ''), n_other = 0);

  -- ── INSERT carrying organization B's id: refused by WITH CHECK ───────────
  begin
    execute 'set local role authenticated';
    insert into public.memberships (user_id, organization_id, status)
      values (user_a, org_b, 'invited');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'memberships INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.invitations (organization_id, email, role_id, token_hash, expires_at)
      values (org_b, 'smuggled@estia.test', owner_role, 'isolation-hash-x', now() + interval '1 day');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'invitations INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.audit_events
      (organization_id, actor_user_id, actor_label, action, resource_type, summary)
      values (org_b, user_a, 'User A', 'forged', 'booking', 'forged event in B');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'audit_events INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.membership_roles (membership_id, organization_id, role_id)
      values (mem_b, org_b, owner_role);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'membership_roles INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.roles (organization_id, code, name, is_system)
      values (org_b, 'smuggled_role', 'Smuggled', false);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'roles INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.audit_events
      (organization_id, actor_user_id, actor_label, action, resource_type, summary)
      values (org_a, user_b, 'User B', 'forged', 'booking', 'A signs an event as B');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('insert', 'audit_events: A cannot sign an event as B', '42501', err, err = '42501');

  -- ── UPDATE of organization B's rows: zero rows affected ──────────────────
  begin
    execute 'set local role authenticated';
    update public.organizations set name = 'HACKED' where id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('update', 'organizations UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.memberships set language = 'xx' where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('update', 'memberships UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.invitations set message = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('update', 'invitations UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.roles set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('update', 'roles UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.membership_scopes set kind = 'own_records' where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('update', 'membership_scopes UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- ── DELETE of organization B's rows: zero rows affected ──────────────────
  begin
    execute 'set local role authenticated';
    delete from public.roles where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'roles DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.membership_roles where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'membership_roles DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.membership_scopes where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'membership_scopes DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.role_permissions rp using public.roles r
      where r.id = rp.role_id and r.organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'role_permissions DELETE of B''s grants affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- organizations and memberships have no DELETE policy and no DELETE grant.
  begin
    execute 'set local role authenticated';
    delete from public.organizations where id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'organizations DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.memberships where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('delete', 'memberships DELETE refused outright', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- A suspended membership is not a membership. my_organizations() returns
  -- only ACTIVE, so this user must see nothing at all in organization A.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_s::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (
      select 1 from public.organizations
      union all select 1 from public.memberships
      union all select 1 from public.membership_roles
      union all select 1 from public.membership_scopes
      union all select 1 from public.invitations
      union all select 1 from public.organization_subscriptions
      union all select 1 from public.audit_events
      union all select 1 from public.roles where organization_id is not null
    ) everything;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('suspended', 'suspended member sees 0 rows across every tenant table', '0',
     n_all::text || coalesce(' err=' || err, ''), n_all = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.my_organizations();
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('suspended', 'my_organizations() empty for suspended member', '0',
     n_all::text || coalesce(' err=' || err, ''), n_all = 0);

  ---------------------------------------------------------------------------
  -- Anonymous callers. Every grant was revoked from `anon` in 0004.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'set local role anon';
    select count(*) into n_all from public.organizations;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read organizations at all', '42501', err, err = '42501');

  -- The SECURITY DEFINER helpers are reachable over /rest/v1/rpc/. Supabase
  -- grants EXECUTE to anon by default privileges, which a REVOKE ... FROM
  -- PUBLIC does not remove, so 0004 revokes from anon by name.
  begin
    execute 'set local role anon';
    select count(*) into n_all from public.my_organizations();
    err := 'NO ERROR - anon executed my_organizations()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot execute my_organizations()', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    perform public.shares_organization_with(user_b);
    err := 'NO ERROR - anon executed shares_organization_with()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot execute shares_organization_with()', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    perform public.has_permission(org_a, 'audit.view');
    err := 'NO ERROR - anon executed has_permission()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot execute has_permission()', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- audit_events is append-only. RLS cannot carry this on its own, because
  -- service_role and postgres both hold BYPASSRLS. The statement trigger is
  -- what actually holds, so it is tested from all three sides.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.audit_events set summary = 'REWRITTEN' where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'authenticated UPDATE on audit_events refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'authenticated DELETE on audit_events refused', '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    update public.audit_events set summary = 'REWRITTEN' where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role UPDATE on audit_events refused (BYPASSRLS)', '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role DELETE on audit_events refused (BYPASSRLS)', '42501', err, err = '42501');

  -- A statement that would have matched no rows is refused just as loudly.
  begin
    execute 'set local role service_role';
    update public.audit_events set summary = 'x' where id = '00000000-0000-4000-8000-000000000000';
    err := 'NO ERROR — ZERO-ROW UPDATE WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'zero-row UPDATE on audit_events still refused', '42501', err, err = '42501');

  -- The table owner itself, which no grant and no policy constrains.
  begin
    update public.audit_events set summary = 'REWRITTEN' where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'table owner UPDATE on audit_events refused', '42501', err, err = '42501');

  begin
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR — AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into isolation_results (area, name, expected, actual, passed) values
    ('append_only', 'table owner DELETE on audit_events refused', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- Platform permissions never reach a customer's role. Enforced by trigger,
  -- so it holds against the owner connection too.
  ---------------------------------------------------------------------------
  begin
    insert into public.role_permissions (role_id, permission_code)
      values (role_a, 'platform.impersonate');
    err := 'NO ERROR — PLATFORM GRANT WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into isolation_results (area, name, expected, actual, passed) values
    ('platform', 'platform.* cannot be granted to a customer role', '42501', err, err = '42501');

  begin
    insert into public.membership_roles (membership_id, organization_id, role_id)
      select mem_a, org_a, id from public.roles where code = 'platform_super_admin';
    err := 'NO ERROR — PLATFORM ROLE WAS ASSIGNED';
  exception when others then err := sqlstate;
  end;
  insert into isolation_results (area, name, expected, actual, passed) values
    ('platform', 'a platform role cannot be assigned in a customer org', '42501', err, err = '42501');

  select count(*) into n_all
    from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    join public.permissions p on p.code = rp.permission_code
   where r.organization_id is not null and p.is_platform;
  insert into isolation_results (area, name, expected, actual, passed) values
    ('platform', 'no customer-org role holds any platform.% permission', '0',
     n_all::text, n_all = 0);

  ---------------------------------------------------------------------------
  -- Positive controls. Without these the section above proves nothing: a
  -- policy that refuses everything, or a missing GRANT, would also produce
  -- "0 rows affected" and every isolation assertion would pass vacuously.
  -- The same statements, aimed at organization A, must affect exactly 1 row.
  --
  -- These mutate the fixture, so they run last.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.organizations set name = 'Renamed by A' where id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.invitations set message = 'ok' where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own invitation', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.audit_events
      (organization_id, actor_user_id, actor_label, action, resource_type, summary)
      values (org_a, user_a, 'User A', 'booking.create', 'booking', 'A wrote an event in A');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert an audit event in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.membership_scopes set kind = 'own_records' where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own membership_scopes rows', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    update public.roles set name = 'Renamed' where id = role_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own custom role', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.roles where id = role_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own custom role', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.membership_scopes where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own membership_scopes rows', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    delete from public.membership_roles where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into isolation_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own membership_roles rows', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into isolation_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from isolation_results;

select seq, area, name, expected, actual, passed from isolation_results order by seq;

rollback;
