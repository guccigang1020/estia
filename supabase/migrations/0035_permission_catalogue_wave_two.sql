-- ============================================================================
-- 0035_permission_catalogue_wave_two.sql — ESTIA · fourteen grants the
--                                          database had never heard of
--
-- What this closes, and how it was found
--   Commits a4bd2a6 and 712bde4 added fourteen grants to
--   `src/lib/authz/permissions.ts` and assigned them across the system roles.
--   The engine in `src/lib/authz/can.ts` therefore allows them, every unit
--   test passes, and the screens gate correctly.
--
--   And `public.permissions` — the database's own catalogue, added by 0012 —
--   knew none of them. `role_permissions.permission_code` is a foreign key
--   onto that table, so the rows could not have been inserted even by hand,
--   and `public.has_permission(org, 'laundry.view')` returned false for every
--   member of every organization including the owner.
--
--   That is the exact shape of a floor disagreeing with its ceiling. Four
--   workers were writing RLS policies gated on these grants; every one of
--   those policies would have admitted nobody, the screens above them would
--   have worked perfectly in the demo, and the failure would first have been
--   seen by a customer whose laundry screen was empty for no visible reason.
--
--   Found by the worker building the payment collection policy, who checked
--   whether `payment.policy_manage` existed in the catalogue before writing a
--   policy against it rather than after. It did not, and neither did the other
--   thirteen.
--
-- Why this is one migration and not four
--   Because it is one mistake. The grants were added to the code in two
--   commits by one hand, and the same step was missed for all of them.
--   Splitting the repair across the four workers' own migrations would have
--   made each of them carry a fragment of somebody else's oversight, and left
--   three windows in which the catalogue was half right.
--
-- Depends on
--   0012 (permissions, role_permissions, permission_kind), 0002 (roles).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The catalogue
-- ============================================================================
-- Categories match what 0012 already uses: laundry and stock are `operations`,
-- the store is `sales`, and deciding what a guest must pay before a booking is
-- confirmed is `finance`. `is_owner_only` is false for all fourteen — none of
-- them is in `OWNER_ONLY` in `roles.ts`, and the two must agree.

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values
  -- Stock, beyond viewing and editing an item, which 0012 already has.
  ('inventory.adjust',        'action'::public.permission_kind, 'operations', false, 1460),
  ('inventory.import',        'action'::public.permission_kind, 'operations', false, 1470),
  ('inventory.transfer',      'action'::public.permission_kind, 'operations', false, 1480),

  -- Laundry.
  ('laundry.view',            'action'::public.permission_kind, 'operations', false, 1490),
  ('laundry.manage',          'action'::public.permission_kind, 'operations', false, 1500),
  ('laundry.order_create',    'action'::public.permission_kind, 'operations', false, 1510),
  -- Sending talks to an outside company in the organization's name, which is
  -- why it is not folded into `laundry.manage`.
  ('laundry.order_send',      'action'::public.permission_kind, 'operations', false, 1520),
  ('laundry.provider_manage', 'action'::public.permission_kind, 'operations', false, 1530),

  -- The store.
  ('product.price_manage',    'action'::public.permission_kind, 'sales',      false, 1540),
  ('order.manage',            'action'::public.permission_kind, 'sales',      false, 1550),
  ('order.discount_manage',   'action'::public.permission_kind, 'sales',      false, 1560),
  ('order.refund',            'action'::public.permission_kind, 'sales',      false, 1570),
  ('provider.manage',         'action'::public.permission_kind, 'sales',      false, 1580),

  -- What a guest must do before a booking counts as confirmed. Deliberately
  -- carries no plan entitlement in the application: a business that takes a
  -- bank transfer on a package with no card processing must still be able to
  -- say so.
  ('payment.policy_manage',   'action'::public.permission_kind, 'finance',    false, 1590)
on conflict (code) do nothing;


-- ============================================================================
-- 2 · Who holds them
-- ============================================================================
-- Mirrors `ROLE_GRANTS` in `src/lib/authz/roles.ts` exactly. Written as
-- explicit joins on the role code rather than as a derivation, because the
-- derivation lives in TypeScript and a second implementation of it in SQL is
-- the same class of drift this migration exists to repair.
--
-- The owner and the administrator hold all fourteen, because
-- `grantsForSystemRole` gives both every non-platform permission and none of
-- these is owner-only.

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join (values
  ('inventory.adjust'), ('inventory.import'), ('inventory.transfer'),
  ('laundry.view'), ('laundry.manage'), ('laundry.order_create'),
  ('laundry.order_send'), ('laundry.provider_manage'),
  ('product.price_manage'), ('order.manage'), ('order.discount_manage'),
  ('order.refund'), ('provider.manage'), ('payment.policy_manage')
) as p(code)
where r.code in ('organization_owner', 'administrator')
on conflict do nothing;

-- `OPERATIONS_CORE`: the general manager and the operations manager run the
-- whole operation, including talking to the laundry provider.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join (values
  ('inventory.adjust'), ('inventory.import'), ('inventory.transfer'),
  ('laundry.view'), ('laundry.manage'), ('laundry.order_create'),
  ('laundry.order_send'), ('laundry.provider_manage')
) as p(code)
where r.code in ('general_manager', 'operations_manager')
on conflict do nothing;

-- The general manager also runs the store.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join (values
  ('product.price_manage'), ('order.manage'), ('order.discount_manage'),
  ('provider.manage')
) as p(code)
where r.code = 'general_manager'
on conflict do nothing;

-- The property manager approves and amends orders for their own properties,
-- and deliberately does not set catalogue prices or choose the suppliers:
-- what a bottle of wine costs and who caters are decisions for the business,
-- not for one house.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'order.manage'
from public.roles r
where r.code = 'property_manager'
on conflict do nothing;

-- Housekeeping counts what is on the shelf and raises the laundry order.
-- Deliberately not `laundry.order_send` or `laundry.provider_manage`: sending
-- is a message to an outside company, and choosing the company is commercial.
-- The order this role raises waits there for approval.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join (values
  ('inventory.adjust'), ('laundry.view'), ('laundry.manage'),
  ('laundry.order_create')
) as p(code)
where r.code = 'housekeeping_supervisor'
on conflict do nothing;

-- Reception takes the telephone call and adds the item.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'product.view'
from public.roles r
where r.code = 'reception'
on conflict do nothing;


-- ============================================================================
-- 3 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
  n       integer;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('inventory.adjust'), ('inventory.import'), ('inventory.transfer'),
    ('laundry.view'), ('laundry.manage'), ('laundry.order_create'),
    ('laundry.order_send'), ('laundry.provider_manage'),
    ('product.price_manage'), ('order.manage'), ('order.discount_manage'),
    ('order.refund'), ('provider.manage'), ('payment.policy_manage')
  ) as c(name)
  where not exists (
    select 1 from public.permissions where code = c.name
  );

  if missing is not null then
    raise exception '0035 did not seed: %', missing;
  end if;

  -- The owner must end up holding every one of them, because that is what
  -- `grantsForSystemRole('organization_owner')` says in code and the two must
  -- not disagree — which is the entire subject of this migration.
  select count(*) into n
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  where r.code = 'organization_owner'
    and rp.permission_code in (
      'inventory.adjust', 'inventory.import', 'inventory.transfer',
      'laundry.view', 'laundry.manage', 'laundry.order_create',
      'laundry.order_send', 'laundry.provider_manage',
      'product.price_manage', 'order.manage', 'order.discount_manage',
      'order.refund', 'provider.manage', 'payment.policy_manage'
    );

  if n <> 14 then
    raise exception 'organization_owner holds % of the 14 new grants, expected 14', n;
  end if;

  -- And the cleaner must hold none of them. `roles.ts` says a cleaner reaches
  -- internal laundry work as a task and never sees provider orders or the
  -- forward demand curve; if that is true in code and false here, the floor is
  -- wider than the ceiling and the wrong person can read the wrong screen.
  select count(*) into n
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  where r.code = 'cleaner'
    and (rp.permission_code like 'laundry.%'
      or rp.permission_code like 'order.%'
      or rp.permission_code = 'payment.policy_manage');

  if n <> 0 then
    raise exception 'cleaner holds % grants it must not', n;
  end if;
end $$;
