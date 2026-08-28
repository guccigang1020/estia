-- ============================================================================
-- operations.sql — ESTIA · proof for tasks, inventory, approvals, commissions
--
-- What this is
--   The evidence for 0011_operations.sql. Four things are under test:
--
--     1. The contract. Every enum is compared against the literal arrays in
--        src/lib/contracts/states.ts, in order. These assertions exist to
--        fail: add a value to the TypeScript without adding it here and the
--        run goes red and says which one.
--     2. The invariants that are the point of the tables. The stock ledger is
--        the truth and the item count is derived from it; an approval cannot
--        be decided by the person who asked for it; a commission cannot be
--        paid before it was approved; a checklist item that demands a photo
--        cannot be ticked without one.
--     3. Tenant isolation across every new table, select / insert / update /
--        delete, each with a positive control. A zero-row result proves
--        isolation only when the same statement aimed at the caller's own
--        organization affects exactly one row — otherwise a missing GRANT
--        would make the whole file pass while proving nothing.
--     4. Scope. A member scoped to one property cannot see or write the tasks
--        and stock of the other.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/operations.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a defect.
--
-- Depends on
--   0001 … 0012, applied in order. 0012 matters here: the commissions policies
--   are gated on `commission.view` / `commission.approve` / `commission.payout`,
--   which that migration is what seeds.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table ops_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '11111111-5555-4111-8111-111111111111';
  org_b   constant uuid := '22222222-5555-4222-8222-222222222222';
  user_a  constant uuid := 'aaaaaaaa-5555-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbbbbbb-5555-4000-8000-00000000000b';
  user_p  constant uuid := 'cccccccc-5555-4000-8000-00000000000c';
  mem_a   constant uuid := 'dddddddd-5555-4000-8000-00000000000a';
  mem_b   constant uuid := 'dddddddd-5555-4000-8000-00000000000b';
  mem_p   constant uuid := 'dddddddd-5555-4000-8000-00000000000c';

  owner_role uuid;
  prop_a1    uuid;
  prop_a2    uuid;
  prop_b     uuid;
  unit_a1    uuid;
  unit_b     uuid;
  guest_a    uuid;
  guest_b    uuid;
  bk_a       uuid;
  bk_b       uuid;
  task_a     uuid;
  task_b     uuid;
  task_a2    uuid;
  item_a     uuid;
  item_b     uuid;
  appr_a     uuid;
  comm_a     uuid;

  n_rows  bigint;
  n_all   bigint;
  n_other bigint;
  err     text;
  got     text[];
  want    text[];
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'ops-a@estia.test'),
    (user_b, 'ops-b@estia.test'),
    (user_p, 'ops-scoped@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'ops-org-a', 'Operations Organization A'),
    (org_b, 'ops-org-b', 'Operations Organization B');

  insert into public.user_profiles (id, full_name) values
    (user_a, 'Ops A'), (user_b, 'Ops B'), (user_p, 'Ops Scoped')
  on conflict (id) do nothing;

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now()),
    (mem_p, user_p, org_a, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role),
    (mem_p, org_a, owner_role);

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'ops-villa-one', 'Ops Villa One', 'active') returning id into prop_a1;
  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'ops-villa-two', 'Ops Villa Two', 'active') returning id into prop_a2;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'ops-villa-b', 'Ops Villa B', 'active') returning id into prop_b;

  insert into public.membership_scopes (membership_id, organization_id, kind, property_ids) values
    (mem_a, org_a, 'all_organization', '{}'),
    (mem_b, org_b, 'all_organization', '{}'),
    (mem_p, org_a, 'properties', array[prop_a1]);

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a1, 'OA', 'Ops Unit A', 'active') returning id into unit_a1;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'OB', 'Ops Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Ops Guest A', '050-500-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Ops Guest B', '050-500-0002') returning id into guest_b;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out,
     source, agent_user_id, created_by)
  values
    (org_a, prop_a1, unit_a1, guest_a, 'confirmed', '2027-07-10', '2027-07-15',
     'agent', user_a, user_a)
  returning id into bk_a;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values
    (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-07-10', '2027-07-15', user_b)
  returning id into bk_b;

  ---------------------------------------------------------------------------
  -- 1 · The contract
  ---------------------------------------------------------------------------
  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'task_status';
  want := array['new','assigned','accepted','in_progress','blocked',
                'awaiting_approval','completed','verified','cancelled'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'task_status matches TASK_STATUSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'task_type';
  want := array['cleaning','preparation','inspection','maintenance','guest_request',
                'delivery','inventory','finance','administrative','custom'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'task_type matches TASK_TYPES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'task_priority';
  want := array['low','normal','high','critical'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'task_priority matches TASK_PRIORITIES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'inventory_state';
  want := array['available','reserved','in_use','dirty','laundry','damaged','out_of_service'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'inventory_state matches INVENTORY_STATES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'approval_status';
  want := array['requested','approved','rejected','expired','withdrawn'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'approval_status matches APPROVAL_STATUSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'approval_type';
  want := array['discount','refund','expense','maintenance','agent_booking',
                'owner_request','price_override','availability_override'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'approval_type matches APPROVAL_TYPES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'commission_status';
  want := array['estimated','pending','eligible','approved','paid','cancelled'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'commission_status matches COMMISSION_STATUSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(x::text order by ord) into got
    from unnest(public.allocatable_inventory_states()) with ordinality as u(x, ord);
  want := array['available'];
  insert into ops_results (area, name, expected, actual, passed) values
    ('contract', 'allocatable_inventory_states() matches ALLOCATABLE_INVENTORY_STATES',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  ---------------------------------------------------------------------------
  -- 2 · Tasks
  ---------------------------------------------------------------------------
  insert into public.tasks
    (organization_id, property_id, unit_id, booking_id, task_type, title,
     assigned_to_user_id, created_by)
  values
    (org_a, prop_a1, unit_a1, bk_a, 'cleaning', 'Clean unit after checkout',
     user_a, user_a)
  returning id into task_a;

  insert into public.tasks
    (organization_id, property_id, task_type, title, created_by)
  values (org_a, prop_a2, 'maintenance', 'Fix the gate', user_a)
  returning id into task_a2;

  insert into public.tasks
    (organization_id, property_id, task_type, title, created_by)
  values (org_b, prop_b, 'cleaning', 'B''s cleaning', user_b)
  returning id into task_b;

  -- The moments are stamped from the status, not typed.
  update public.tasks set status = 'in_progress', updated_by = user_a where id = task_a;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'moving to in_progress stamps started_at', 'true',
     (select (started_at is not null)::text from public.tasks where id = task_a),
     (select started_at is not null from public.tasks where id = task_a));

  update public.tasks set status = 'completed', updated_by = user_a where id = task_a;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'moving to completed stamps completed_at', 'true',
     (select (completed_at is not null)::text from public.tasks where id = task_a),
     (select completed_at is not null from public.tasks where id = task_a));

  update public.tasks set status = 'verified', verified_by = user_a, updated_by = user_a
   where id = task_a;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'moving to verified stamps verified_at', 'true',
     (select (verified_at is not null)::text from public.tasks where id = task_a),
     (select verified_at is not null from public.tasks where id = task_a));

  -- A board that cannot say why the day is stuck cannot help a supervisor.
  begin
    update public.tasks set status = 'blocked', updated_by = user_a where id = task_a2;
    err := 'NO ERROR — BLOCKED WITH NO REASON';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'blocking a task demands a reason', '23514', err, err = '23514');

  begin
    update public.tasks
       set status = 'blocked', blocked_reason = 'waiting for linen', updated_by = user_a
     where id = task_a2;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'control: blocking with a reason is accepted', 'ok', err, err = 'ok');

  begin
    update public.tasks set status = 'cancelled', updated_by = user_a where id = task_a2;
    err := 'NO ERROR — CANCELLED WITH NO REASON';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('task', 'cancelling a task demands a reason', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 3 · Assignments and checklists
  ---------------------------------------------------------------------------
  insert into public.task_assignments
    (organization_id, task_id, user_id, assignment_role, assigned_by)
  values (org_a, task_a, user_a, 'assignee', user_a);

  begin
    insert into public.task_assignments
      (organization_id, task_id, user_id, assignment_role, assigned_by)
    values (org_a, task_a, user_a, 'assignee', user_a);
    err := 'NO ERROR — THE SAME PERSON WAS ASSIGNED TWICE';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('assignment', 'one live assignment per person per task', '23505', err, err = '23505');

  -- Taking somebody off frees the slot, so they can be put back on.
  update public.task_assignments set unassigned_at = now()
   where task_id = task_a and user_id = user_a;
  begin
    insert into public.task_assignments
      (organization_id, task_id, user_id, assignment_role, assigned_by)
    values (org_a, task_a, user_a, 'assignee', user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('assignment', 'control: an unassigned person can be put back on the task',
     'ok', err, err = 'ok');

  -- Declining is an event with a reason, not a silent absence.
  begin
    update public.task_assignments set declined_at = now()
     where task_id = task_a and user_id = user_a and unassigned_at is null;
    err := 'NO ERROR — DECLINED WITH NO REASON';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('assignment', 'declining an assignment demands a reason', '23514', err, err = '23514');

  insert into public.task_checklists
    (organization_id, task_id, position, label, requires_photo)
  values
    (org_a, task_a, 1, 'Strip the beds', false),
    (org_a, task_a, 2, 'Photograph the finished room', true);

  begin
    insert into public.task_checklists (organization_id, task_id, position, label)
      values (org_a, task_a, 1, 'Duplicate position');
    err := 'NO ERROR — TWO ITEMS SHARED A POSITION';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('checklist', 'two checklist items cannot share a position', '23505', err, err = '23505');

  -- The whole value of requires_photo: enforced here it is a standard,
  -- enforced in a form it is a suggestion.
  begin
    update public.task_checklists set is_done = true
     where task_id = task_a and position = 2;
    err := 'NO ERROR — TICKED WITHOUT THE REQUIRED PHOTO';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('checklist', 'an item requiring a photo cannot be ticked without one',
     '23514', err, err = '23514');

  begin
    update public.task_checklists
       set is_done = true, photo_url = 'https://files.example/room.jpg'
     where task_id = task_a and position = 2;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('checklist', 'control: with a photo the item ticks', 'ok', err, err = 'ok');

  insert into ops_results (area, name, expected, actual, passed) values
    ('checklist', 'ticking an item stamps done_at', 'true',
     (select (done_at is not null)::text from public.task_checklists
       where task_id = task_a and position = 2),
     (select done_at is not null from public.task_checklists
       where task_id = task_a and position = 2));

  -- Un-ticking clears the stamp, so the pair can never disagree.
  update public.task_checklists set is_done = false where task_id = task_a and position = 2;
  insert into ops_results (area, name, expected, actual, passed) values
    ('checklist', 'un-ticking an item clears done_at', 'true',
     (select (done_at is null)::text from public.task_checklists
       where task_id = task_a and position = 2),
     (select done_at is null from public.task_checklists
       where task_id = task_a and position = 2));

  ---------------------------------------------------------------------------
  -- 4 · Inventory: the ledger is the truth
  ---------------------------------------------------------------------------
  insert into public.inventory_items
    (organization_id, property_id, sku, name, category, min_quantity, created_by)
  values (org_a, prop_a1, 'TOWEL-L', 'Large towel', 'linen', 10, user_a)
  returning id into item_a;

  insert into public.inventory_items
    (organization_id, property_id, sku, name, created_by)
  values (org_b, prop_b, 'TOWEL-L', 'Large towel', user_b)
  returning id into item_b;

  insert into public.inventory_movements
    (organization_id, property_id, item_id, kind, quantity_delta, reason, created_by)
  values (org_a, prop_a1, item_a, 'receipt', 40, 'delivery from supplier', user_a);

  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'a receipt movement raises the item quantity', '40',
     (select quantity::text from public.inventory_items where id = item_a),
     (select quantity from public.inventory_items where id = item_a) = 40);

  insert into public.inventory_movements
    (organization_id, property_id, item_id, kind, quantity_delta, reason, created_by)
  values (org_a, prop_a1, item_a, 'issue', -8, 'sent to the villa', user_a);

  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'an issue movement lowers the item quantity', '32',
     (select quantity::text from public.inventory_items where id = item_a),
     (select quantity from public.inventory_items where id = item_a) = 32);

  -- Issuing more than exists is refused by the constraint, not by a branch.
  begin
    insert into public.inventory_movements
      (organization_id, property_id, item_id, kind, quantity_delta, created_by)
    values (org_a, prop_a1, item_a, 'issue', -100, user_a);
    err := 'NO ERROR — STOCK WENT NEGATIVE';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'a movement that would take stock below zero is refused',
     '23514', err, err = '23514');

  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'the refused movement left the quantity untouched', '32',
     (select quantity::text from public.inventory_items where id = item_a),
     (select quantity from public.inventory_items where id = item_a) = 32);

  -- A movement of nothing is not a movement.
  begin
    insert into public.inventory_movements
      (organization_id, property_id, item_id, kind, quantity_delta, created_by)
    values (org_a, prop_a1, item_a, 'adjustment', 0, user_a);
    err := 'NO ERROR — A ZERO MOVEMENT WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'a zero-delta movement is refused', '23514', err, err = '23514');

  -- Append-only, and the trigger is what makes that true for the owner too.
  begin
    update public.inventory_movements set reason = 'rewritten' where item_id = item_a;
    err := 'NO ERROR — A MOVEMENT WAS REWRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'inventory_movements refuses UPDATE, even as the owner',
     '42501', err, err = '42501');

  begin
    delete from public.inventory_movements where item_id = item_a;
    err := 'NO ERROR — A MOVEMENT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'inventory_movements refuses DELETE, even as the owner',
     '42501', err, err = '42501');

  -- Reserved stock cannot exceed what exists.
  begin
    update public.inventory_items set quantity_reserved = 999 where id = item_a;
    err := 'NO ERROR — RESERVED MORE THAN EXISTS';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'reserving more than exists is refused', '23514', err, err = '23514');

  begin
    update public.inventory_items set quantity_reserved = 20 where id = item_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('inventory', 'control: reserving within stock is accepted', 'ok', err, err = 'ok');

  ---------------------------------------------------------------------------
  -- 5 · Approvals
  ---------------------------------------------------------------------------
  insert into public.approvals
    (organization_id, property_id, approval_type, booking_id, requested_by,
     reason, requested_value_bps, limit_value_bps)
  values
    (org_a, prop_a1, 'discount', bk_a, user_a,
     'Repeat guest, asked for 12% against a 5% ceiling', 1200, 500)
  returning id into appr_a;

  -- The rule the whole mechanism rests on.
  begin
    update public.approvals
       set status = 'approved', decided_by = user_a, decided_at = now()
     where id = appr_a;
    err := 'NO ERROR — SELF-APPROVED';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('approval', 'a requester cannot approve their own request', '23514', err, err = '23514');

  begin
    update public.approvals
       set status = 'approved', decided_by = user_p, decided_at = now(),
           decision_note = 'agreed, one-off'
     where id = appr_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('approval', 'control: somebody else may approve it', 'ok', err, err = 'ok');

  -- A request nobody can evaluate gets approved out of politeness.
  begin
    insert into public.approvals
      (organization_id, approval_type, requested_by, reason)
    values (org_a, 'expense', user_a, '   ');
    err := 'NO ERROR — A BLANK REASON WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('approval', 'an approval demands a stated reason', '23514', err, err = '23514');

  -- An organization-level approval carries no property. That is the one
  -- nullable anchor in 0011 and it is deliberate.
  begin
    insert into public.approvals
      (organization_id, approval_type, requested_by, reason)
    values (org_a, 'expense', user_a, 'New accounting software for the business');
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('approval', 'an approval may be organization-level, with no property', 'ok', err, err = 'ok');

  -- expired and withdrawn are not decisions and must not carry a decider.
  begin
    insert into public.approvals
      (organization_id, approval_type, requested_by, reason, status, decided_at)
    values (org_a, 'refund', user_a, 'lapsed', 'expired', now());
    err := 'NO ERROR — AN EXPIRED REQUEST CARRIED A DECISION TIME';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('approval', 'expired is not a decision and carries no decided_at',
     '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 6 · Commissions: the ladder, enforced
  ---------------------------------------------------------------------------
  insert into public.commissions
    (organization_id, property_id, booking_id, agent_user_id,
     basis_agorot, rate_bps, amount_agorot, created_by)
  values (org_a, prop_a1, bk_a, user_a, 500000, 1000, 50000, user_a)
  returning id into comm_a;

  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'a new commission starts as estimated', 'estimated',
     (select status::text from public.commissions where id = comm_a),
     (select status from public.commissions where id = comm_a) = 'estimated');

  -- Paying on estimated means paying for stays that never happened. With no
  -- approver named and no authenticated caller to fall back on, the ladder
  -- constraint is what refuses it.
  begin
    update public.commissions set status = 'paid' where id = comm_a;
    err := 'NO ERROR — PAID WITH NO APPROVER';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'a commission cannot be paid without an approver', '23514', err, err = '23514');

  begin
    update public.commissions set status = 'paid', approved_by = user_p where id = comm_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'control: with an approver named it is payable', 'ok', err, err = 'ok');

  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'paying stamps eligible_at, approved_at and paid_at', 'true',
     (select (eligible_at is not null and approved_at is not null and paid_at is not null)::text
        from public.commissions where id = comm_a),
     (select eligible_at is not null and approved_at is not null and paid_at is not null
        from public.commissions where id = comm_a));

  -- One live commission per booking per payee.
  begin
    insert into public.commissions
      (organization_id, property_id, booking_id, agent_user_id, amount_agorot, created_by)
    values (org_a, prop_a1, bk_a, user_a, 10000, user_a);
    err := 'NO ERROR — A SECOND COMMISSION FOR THE SAME AGENT';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'one live commission per booking per agent', '23505', err, err = '23505');

  -- A commission owed to nobody is not a commission.
  begin
    insert into public.commissions
      (organization_id, property_id, booking_id, amount_agorot, created_by)
    values (org_a, prop_a1, bk_a, 10000, user_a);
    err := 'NO ERROR — A COMMISSION WITH NO PAYEE';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'a commission must name an agent or an agency', '23514', err, err = '23514');

  -- Cancelling frees the slot, and demands a reason.
  begin
    update public.commissions set status = 'cancelled' where id = comm_a;
    err := 'NO ERROR — CANCELLED WITH NO REASON';
  exception when others then err := sqlstate;
  end;
  insert into ops_results (area, name, expected, actual, passed) values
    ('commission', 'cancelling a commission demands a reason', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 7 · Tenant isolation, table by table
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.tasks;
    select count(*) into n_other from public.tasks where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'tasks: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.task_assignments;
    select count(*) into n_other from public.task_assignments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'task_assignments: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.task_checklists;
    select count(*) into n_other from public.task_checklists where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'task_checklists: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_items;
    select count(*) into n_other from public.inventory_items where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'inventory_items: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_movements;
    select count(*) into n_other from public.inventory_movements where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'inventory_movements: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.approvals;
    select count(*) into n_other from public.approvals where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'approvals: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.commissions;
    select count(*) into n_other from public.commissions where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('select', 'commissions: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  -- INSERT into organization B
  begin
    execute 'set local role authenticated';
    insert into public.tasks (organization_id, property_id, task_type, title)
      values (org_b, prop_b, 'cleaning', 'Smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'tasks INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.task_assignments (organization_id, task_id, user_id)
      values (org_b, task_b, user_a);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'task_assignments INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.task_checklists (organization_id, task_id, position, label)
      values (org_b, task_b, 9, 'Smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'task_checklists INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.inventory_items (organization_id, property_id, name)
      values (org_b, prop_b, 'Smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_items INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.inventory_movements
      (organization_id, property_id, item_id, kind, quantity_delta)
      values (org_b, prop_b, item_b, 'receipt', 5);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_movements INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.approvals
      (organization_id, approval_type, requested_by, reason)
      values (org_b, 'expense', user_a, 'Smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'approvals INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.commissions
      (organization_id, property_id, booking_id, agent_user_id, amount_agorot)
      values (org_b, prop_b, bk_b, user_a, 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'commissions INSERT into org B refused', '42501', err, err = '42501');

  -- A member may not raise an approval in somebody else's name.
  begin
    execute 'set local role authenticated';
    insert into public.approvals
      (organization_id, approval_type, requested_by, reason)
      values (org_a, 'expense', user_b, 'Signed as somebody else');
    err := 'NO ERROR — REQUESTED IN ANOTHER PERSON''S NAME';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('insert', 'an approval cannot be raised in another person''s name',
     '42501', err, err = '42501');

  -- UPDATE of B's rows
  begin
    execute 'set local role authenticated';
    update public.tasks set title = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('update', 'tasks UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_items set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('update', 'inventory_items UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.approvals set decision_note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('update', 'approvals UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.commissions set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('update', 'commissions UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.task_checklists set label = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('update', 'task_checklists UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- DELETE of B's rows, where DELETE exists at all
  begin
    execute 'set local role authenticated';
    delete from public.task_assignments where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'task_assignments DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.task_checklists where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'task_checklists DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.inventory_items where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_items DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Where there is no DELETE grant at all, the refusal is louder and applies
  -- to the caller's own organization too. A task is cancelled, not deleted.
  begin
    execute 'set local role authenticated';
    delete from public.tasks where organization_id = org_a;
    err := 'NO ERROR — A TASK WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'tasks DELETE refused outright, own organization included',
     '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.approvals where organization_id = org_a;
    err := 'NO ERROR — AN APPROVAL WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'approvals DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.commissions where organization_id = org_a;
    err := 'NO ERROR — A COMMISSION WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'commissions DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.inventory_movements where organization_id = org_a;
    err := 'NO ERROR — A MOVEMENT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_movements DELETE refused outright', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 8 · A member scoped to one property sees only that property
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_p::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.tasks where property_id = prop_a1;
    select count(*) into n_other from public.tasks where property_id = prop_a2;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('scope', 'scoped member sees villa-one tasks and no villa-two tasks',
     'other=0 own>0',
     'own=' || n_all || ' other=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.inventory_items where property_id = prop_a2;
    select count(*) into n_all   from public.inventory_items where property_id = prop_a1;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('scope', 'scoped member sees villa-one stock and no villa-two stock',
     'other=0 own>0',
     'own=' || n_all || ' other=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    insert into public.tasks (organization_id, property_id, task_type, title)
      values (org_a, prop_a2, 'cleaning', 'Outside my scope');
    err := 'NO ERROR — WROTE OUTSIDE SCOPE';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('scope', 'scoped member cannot create a task in villa-two', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.tasks (organization_id, property_id, task_type, title)
      values (org_a, prop_a1, 'cleaning', 'Inside my scope');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'scoped member CAN create a task in villa-one', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 9 · Positive controls
  ---------------------------------------------------------------------------
  -- Without these, section 7 proves nothing: a missing GRANT would produce
  -- "0 rows affected" everywhere and every isolation assertion would pass
  -- vacuously. These mutate the fixture, so they run last.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    insert into public.tasks (organization_id, property_id, task_type, title)
      values (org_a, prop_a2, 'inspection', 'Own organization task');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a task in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.inventory_items (organization_id, property_id, name)
      values (org_a, prop_a1, 'Bath mat');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert an inventory item in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.inventory_movements
      (organization_id, property_id, item_id, kind, quantity_delta)
      values (org_a, prop_a1, item_a, 'receipt', 3);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN record a stock movement in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.approvals
      (organization_id, property_id, approval_type, requested_by, reason)
      values (org_a, prop_a1, 'price_override', user_a, 'Own organization request');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN raise an approval in its own organization, in its own name', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.tasks set description = 'ok' where id = task_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own task', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.commissions set note = 'ok' where id = comm_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own commission', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.task_checklists where task_id = task_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own checklist items', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    delete from public.inventory_items where id = item_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ops_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own inventory item', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into ops_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from ops_results;

select seq, area, name, expected, actual, passed from ops_results order by seq;

rollback;
