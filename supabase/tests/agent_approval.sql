-- ============================================================================
-- agent_approval.sql — ESTIA · proof for 0026 §1 and §2
--
-- What this is
--   The evidence that the discount-approval path an agent is offered on screen
--   is a path the database actually admits — and that admitting it did not
--   hand every agent in the product a way to approve their own discount.
--
--   `AGENT_BASE` in src/lib/authz/roles.ts gives all four presets
--   `approval.request`, because a discount over an agent's cap raises a request
--   rather than refusing. `approvals_insert` from 0011 requires exactly that
--   permission, and 0012 seeded the four roles from lists written before
--   `AGENT_BASE` grew it. So the engine said yes, row level security said
--   `42501`, and nothing in between said anything at all.
--
--   The second half is the one worth reading. `approvals_update` admitted the
--   requester on both USING and WITH CHECK, whatever they were changing the
--   status to, and `approvals_no_self_approval` was not the backstop it looks
--   like: `tg_approvals_stamp_decision` writes
--   `coalesce(new.decided_by, auth.uid())`, so a requester naming somebody else
--   as the decider satisfied it. Before 0026 §1 no agent could reach that,
--   because no agent could insert an approval. Afterwards every one of them
--   could. The negative assertions below are that escalation, tried four ways.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_approval.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion, then a TOTAL.
--
-- Depends on
--   0001 … 0026, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table approval_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org  constant uuid := 'ac000000-9999-4000-8000-0000000000f0';

  -- Two agents, because the interesting refusal is one of them reaching for
  -- the other's request. A single agent could only prove the CHECK constraint.
  u_ag constant uuid := 'ac000000-9999-4000-8000-000000000001';
  u_a2 constant uuid := 'ac000000-9999-4000-8000-000000000002';
  -- The owner. Holds `approval.decide`, and is the person an agent would name
  -- as the decider if the policy let them.
  u_ow constant uuid := 'ac000000-9999-4000-8000-000000000003';

  m_ag constant uuid := 'ad000000-9999-4000-8000-000000000001';
  m_a2 constant uuid := 'ad000000-9999-4000-8000-000000000002';
  m_ow constant uuid := 'ad000000-9999-4000-8000-000000000003';

  ap_1 constant uuid := 'ae000000-9999-4000-8000-000000000001';
  ap_2 constant uuid := 'ae000000-9999-4000-8000-000000000002';

  role_sa uuid;
  role_ow uuid;

  n_rows bigint;
  err    text;
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into role_sa from public.roles where code = 'sales_agent'        and organization_id is null;
  select id into role_ow from public.roles where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (u_ag, 'ap-ag@estia.test'),
    (u_a2, 'ap-a2@estia.test'),
    (u_ow, 'ap-ow@estia.test');

  insert into public.organizations (id, slug, name) values
    (org, 'approval-org', 'Approval Organization');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (m_ag, u_ag, org, 'active', now()),
    (m_a2, u_a2, org, 'active', now()),
    (m_ow, u_ow, org, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (m_ag, org, role_sa),
    (m_a2, org, role_sa),
    (m_ow, org, role_ow);

  ---------------------------------------------------------------------------
  -- 1 · The seed, without which the insert policy admits no agent
  ---------------------------------------------------------------------------
  -- A policy naming a code no role holds denies everyone, silently. 0011 made
  -- exactly that mistake with the commission codes and said so.
  insert into approval_results (area, name, expected, actual, passed)
  select 'seed', 'all four agent presets hold approval.request', '4',
         count(*)::text, count(*) = 4
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  where r.organization_id is null
    and rp.permission_code = 'approval.request'
    and r.code in ('referral_agent', 'sales_agent', 'senior_agent', 'agency_manager');

  ---------------------------------------------------------------------------
  -- 2 · What an agent CAN now do
  ---------------------------------------------------------------------------
  -- `property_id` is null, which `approvals_insert` admits deliberately: an
  -- approval with no property is organization-level governance, gated by the
  -- approval grants alone. 0011 states that widening and why it is the trade.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_ag::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    insert into public.approvals (id, organization_id, approval_type, requested_by, reason)
    values (ap_1, org, 'discount', u_ag, 'הנחה של 10% לאורח חוזר');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('allowed', 'an agent raises a discount approval — the feature the screen offers', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  perform set_config('request.jwt.claims',
    json_build_object('sub', u_a2::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    insert into public.approvals (id, organization_id, approval_type, requested_by, reason)
    values (ap_2, org, 'discount', u_a2, 'הנחה של 15% לקבוצה');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('allowed', 'a second agent raises one too', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 3 · The escalation, tried in every direction
  ---------------------------------------------------------------------------
  -- A WITH CHECK violation raises `42501`; a USING violation matches zero rows.
  -- Both appear below and the difference is not cosmetic — it is which half of
  -- the policy refused.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_ag::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    insert into public.approvals (organization_id, approval_type, requested_by, reason)
    values (org, 'discount', u_a2, 'not mine to ask');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot raise a request in another agent name', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'approved' where id = ap_2;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot approve another agent request', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'approved' where id = ap_1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot approve their own request', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  -- The one that used to work, and is the whole reason 0026 §2 exists. The
  -- self-approval CHECK compares `decided_by` with `requested_by`, so naming
  -- the owner satisfied it, and the trigger's `coalesce` left the forgery
  -- standing. Rehearsed before the fix: this matched one row.
  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'approved', decided_by = u_ow where id = ap_1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot approve their own by naming somebody else as the decider', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'rejected', decided_by = u_ow where id = ap_1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('escalation', 'cannot reject their own either — a decision is a decision', '42501',
     coalesce(err, 'NO ERROR — rows=' || n_rows), err = '42501');

  ---------------------------------------------------------------------------
  -- 4 · Controls — 0026 took nothing away that was meant to be there
  ---------------------------------------------------------------------------
  -- 0011: "withdrawing your own request is not a decision and needs only the
  -- right to have made it". That is still true, and it is the transition an
  -- over-tight rule would have taken with it.
  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'withdrawn' where id = ap_1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('control', 'an agent may still withdraw their own request', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  perform set_config('request.jwt.claims',
    json_build_object('sub', u_ow::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.approvals set status = 'approved' where id = ap_2;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into approval_results (area, name, expected, actual, passed) values
    ('control', 'approval.decide still decides', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  insert into approval_results (area, name, expected, actual, passed)
  select 'control', 'the decision is attributed to the person who made it', 'true',
         (decided_by = u_ow and decided_at is not null)::text,
         decided_by = u_ow and decided_at is not null
  from public.approvals where id = ap_2;
end $$;

insert into approval_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from approval_results;

select seq, area, name, expected, actual, passed from approval_results order by seq;

rollback;
