-- ============================================================================
-- 0057_stock_count.sql — ESTIA · the physical stocktake, and what it means
--
-- What was missing
--   Inventory was real: six tables, a time-aware forecast, reservations,
--   transfers and the reusable-item circulation states. What did not exist was
--   the count itself — no session, no blind sheet, no loss classification and
--   no replacement-cost exposure. `inventory/commands.ts` opened a TASK for a
--   count request precisely because there was no session to open.
--
-- Blindness is the point, and it is structural at three floors
--   A sheet that shows the expected quantity gets that quantity back. So:
--
--     1. The counter's table, `inventory_count_lines`, HAS NO EXPECTED COLUMN.
--        There is nowhere in it to put the answer. The rehearsal asserts that,
--        because adding one later would make the whole module decorative.
--     2. The expectation lives in a SEPARATE table whose select policy asks
--        for `inventory.adjust` while the sheet asks for `inventory.view` —
--        so blindness is a database fact rather than a component detail.
--     3. The TypeScript sheet type declares `expected?: never`, so a spread
--        that adds one is a compile error.
--
--   The honest limit, stated: an actor who holds `inventory.adjust` can still
--   query the expectations table directly. This defends against the PRODUCT
--   showing the answer to the person holding the clipboard; it is not a
--   defence against a determined operator with a REST client. Closing that
--   needs a narrower `inventory.count` grant.
--
-- Why the snapshot is taken when counting starts
--   Not at reconciliation. The honest comparison is against what the system
--   believed when the person began walking the shelves — a movement recorded
--   during that hour would otherwise appear as a variance nobody created.
--
-- `unknown` is not theft
--   It is the verdict when a difference was investigated and no explanation
--   was found: it writes no movement, keeps the units in the record and
--   attributes nothing to anybody. A NULL classification is a different fact
--   again — nobody has looked yet — and the exposure figure counts both
--   without merging them.
--
-- Why this sits beside inventory_discrepancies rather than reusing it
--   A discrepancy is per-booking, per-changeover, and its `difference` is
--   `collected − expected`. A variance is per-session, per-property, periodic,
--   and its `variance` is `expected − counted` — the OPPOSITE sign, because a
--   checkout asks how many came back and a stocktake asks how many are
--   missing. More importantly, the discrepancy vocabulary contains
--   `guest_loss`, whose purpose is to enable a charge to a guest, and a
--   periodic count of a linen cupboard produces no evidence about any
--   particular stay. Merging the two would make `guest_loss` selectable on a
--   stocktake, which is the failure this module exists to prevent.
--   `inventory_count_variances.discrepancy_id` is the link for the case where
--   a reconciler decides a variance really is attributable to a stay.
--
-- Depends on
--   0011 (inventory_items, inventory_movements, inventory_discrepancies,
--   tasks and their composite keys), 0008 (properties), 0004 (RLS helpers).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies
-- ============================================================================

do $$ begin
  create type public.inventory_count_status as enum (
    'open', 'counting', 'reconciling', 'closed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.inventory_loss_class as enum (
    'count_error', 'in_laundry', 'found_at_property',
    'damaged', 'disposed', 'lost', 'unknown'
  );
exception when duplicate_object then null; end $$;

comment on type public.inventory_loss_class is
  'Why a counted difference exists. `unknown` is the honest verdict when a difference was investigated and no explanation was found: it writes no movement, keeps the units in the record, and attributes nothing to anybody. It is NOT theft, and nothing in this module names it that. A NULL classification is different again — nobody has looked yet.';


-- ============================================================================
-- 2 · The session
-- ============================================================================

create table if not exists public.inventory_count_sessions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  property_id            uuid not null,
  label                  text,
  status                 public.inventory_count_status not null default 'open',
  blind                  boolean not null default true,
  scheduled_for          date,
  task_id                uuid,
  counting_started_at    timestamptz,
  reconciling_started_at timestamptz,
  closed_at              timestamptz,
  closed_by              uuid references auth.users (id) on delete set null,
  cancelled_reason       text,
  note                   text,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  version                integer not null default 1,
  constraint inventory_count_sessions_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint inventory_count_sessions_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete set null (task_id),
  constraint inventory_count_sessions_id_org_key unique (id, organization_id),
  constraint inventory_count_sessions_id_org_property_key
    unique (id, organization_id, property_id),
  constraint inventory_count_sessions_stage_order check (
    (reconciling_started_at is null or counting_started_at is not null)
    and (closed_at is null or reconciling_started_at is not null)
    and (counting_started_at is null or reconciling_started_at is null
         or reconciling_started_at >= counting_started_at)
    and (reconciling_started_at is null or closed_at is null
         or closed_at >= reconciling_started_at)
  ),
  constraint inventory_count_sessions_status_stamps check (
    (status <> 'counting'    or counting_started_at is not null)
    and (status <> 'reconciling' or reconciling_started_at is not null)
    and (status <> 'closed'      or closed_at is not null)
  ),
  -- An abandoned stocktake with no reason is a gap nobody can review.
  constraint inventory_count_sessions_cancel_reason check (
    status <> 'cancelled'
    or (cancelled_reason is not null and length(btrim(cancelled_reason)) > 0)
  ),
  constraint inventory_count_sessions_version_positive check (version >= 1)
);

comment on table public.inventory_count_sessions is
  'One physical stocktake. `blind` is true by default and is the default worth defending: a sheet that shows the expected quantity gets that quantity back. The session moves stock only through the classification of its variances.';

create unique index if not exists inventory_count_sessions_one_live_idx
  on public.inventory_count_sessions (organization_id, property_id)
  where status in ('open', 'counting', 'reconciling');

comment on index public.inventory_count_sessions_one_live_idx is
  'Two live stocktakes of one property produce two answers for one cupboard, which is the defect this module exists not to add.';

create index if not exists inventory_count_sessions_organization_idx
  on public.inventory_count_sessions (organization_id, created_at desc);
create index if not exists inventory_count_sessions_property_idx
  on public.inventory_count_sessions (property_id, created_at desc);
create index if not exists inventory_count_sessions_open_idx
  on public.inventory_count_sessions (organization_id, scheduled_for)
  where status in ('open', 'counting', 'reconciling');
create index if not exists inventory_count_sessions_task_idx
  on public.inventory_count_sessions (task_id) where task_id is not null;

drop trigger if exists inventory_count_sessions_touch on public.inventory_count_sessions;
create trigger inventory_count_sessions_touch
  before update on public.inventory_count_sessions
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · The blind sheet
-- ============================================================================

create table if not exists public.inventory_count_lines (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,
  organization_id  uuid not null,
  property_id      uuid not null,
  item_id          uuid not null,
  counted_quantity integer,
  counted_at       timestamptz,
  counted_by       uuid references auth.users (id) on delete set null,
  note             text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  constraint inventory_count_lines_session_fkey
    foreign key (session_id, organization_id, property_id)
    references public.inventory_count_sessions (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_lines_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_lines_quantity_nonnegative check (
    counted_quantity is null or counted_quantity >= 0
  ),
  constraint inventory_count_lines_counted_pair check (
    (counted_quantity is null) = (counted_at is null)
  ),
  constraint inventory_count_lines_version_positive check (version >= 1)
);

comment on table public.inventory_count_lines is
  'What the counter reads and writes. There is deliberately NO expected column here: this is the blind sheet''s table and there is nowhere in it to put the answer.';
comment on column public.inventory_count_lines.counted_quantity is
  'NULL means nobody has counted this, which is NOT zero. Coercing it would report a whole cupboard as missing the first time somebody was called away half way through.';

create unique index if not exists inventory_count_lines_session_item_idx
  on public.inventory_count_lines (session_id, item_id);
create index if not exists inventory_count_lines_organization_idx
  on public.inventory_count_lines (organization_id, session_id);
create index if not exists inventory_count_lines_outstanding_idx
  on public.inventory_count_lines (session_id) where counted_quantity is null;
create index if not exists inventory_count_lines_item_idx
  on public.inventory_count_lines (item_id, counted_at desc);

drop trigger if exists inventory_count_lines_touch on public.inventory_count_lines;
create trigger inventory_count_lines_touch
  before update on public.inventory_count_lines
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · The frozen ledger reading
-- ============================================================================

create table if not exists public.inventory_count_expectations (
  id                      uuid primary key default gen_random_uuid(),
  session_id              uuid not null,
  organization_id         uuid not null,
  property_id             uuid not null,
  item_id                 uuid not null,
  expected_on_shelf       integer not null,
  owned_total             integer not null,
  circulating_total       integer not null,
  states                  jsonb not null default '{}'::jsonb,
  replacement_cost_agorot integer,
  captured_at             timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  constraint inventory_count_expectations_session_fkey
    foreign key (session_id, organization_id, property_id)
    references public.inventory_count_sessions (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_expectations_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_expectations_nonnegative check (
    expected_on_shelf >= 0 and owned_total >= 0 and circulating_total >= 0
  ),
  constraint inventory_count_expectations_cost_nonnegative check (
    replacement_cost_agorot is null or replacement_cost_agorot >= 0
  )
);

comment on table public.inventory_count_expectations is
  'What the ledger believed at the moment counting started, frozen. Taken then and not at reconciliation, because the honest comparison is against what the system believed when the person began walking the shelves — a movement recorded during that hour would otherwise become a variance nobody created. Its select policy asks for inventory.adjust rather than inventory.view, which is what keeps a blind sheet blind at the database rather than in a component.';

create unique index if not exists inventory_count_expectations_session_item_idx
  on public.inventory_count_expectations (session_id, item_id);
create index if not exists inventory_count_expectations_organization_idx
  on public.inventory_count_expectations (organization_id, session_id);


-- ============================================================================
-- 5 · Variances
-- ============================================================================

create table if not exists public.inventory_count_variances (
  id                      uuid primary key default gen_random_uuid(),
  session_id              uuid not null,
  organization_id         uuid not null,
  property_id             uuid not null,
  item_id                 uuid not null,
  expected_quantity       integer not null,
  counted_quantity        integer not null,
  variance                integer
    generated always as (expected_quantity - counted_quantity) stored,
  circulating             integer not null default 0,
  replacement_cost_agorot integer,
  classification          public.inventory_loss_class,
  classification_note     text,
  classified_at           timestamptz,
  classified_by           uuid references auth.users (id) on delete set null,
  movement_id             uuid references public.inventory_movements (id) on delete set null,
  discrepancy_id          uuid references public.inventory_discrepancies (id) on delete set null,
  metadata                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,
  constraint inventory_count_variances_session_fkey
    foreign key (session_id, organization_id, property_id)
    references public.inventory_count_sessions (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_variances_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_count_variances_counts_nonnegative check (
    expected_quantity >= 0 and counted_quantity >= 0
  ),
  -- A variance of zero is not a variance. Recording one would put a permanent
  -- row of nothing on a screen whose whole job is to be different.
  constraint inventory_count_variances_nonzero check (
    expected_quantity <> counted_quantity
  ),
  -- The three classifications that take stock out of the count need a note.
  -- `unknown` is exempt: it IS the absence of an explanation, and demanding a
  -- sentence for it is how the sentence becomes "ok".
  constraint inventory_count_variances_note_required check (
    classification is null
    or classification not in ('damaged', 'disposed', 'lost')
    or (classification_note is not null and length(btrim(classification_note)) > 0)
  ),
  constraint inventory_count_variances_classified_pair check (
    (classification is null) = (classified_at is null)
  ),
  -- A surplus can only be a record that was short, or unexplained.
  constraint inventory_count_variances_surplus_classification check (
    classification is null
    or expected_quantity > counted_quantity
    or classification in ('count_error', 'unknown')
  ),
  constraint inventory_count_variances_cost_nonnegative check (
    replacement_cost_agorot is null or replacement_cost_agorot >= 0
  ),
  constraint inventory_count_variances_version_positive check (version >= 1)
);

comment on column public.inventory_count_variances.variance is
  'expected − counted. Positive is MISSING, negative is surplus. Deliberately the OPPOSITE sign from inventory_discrepancies.difference (collected − expected): a checkout asks how many came back, a stocktake asks how many are missing. Both conventions are stated on their own column so neither is inferred.';
comment on column public.inventory_count_variances.classification is
  'NULL is a queue — nobody has looked. `unknown` is a verdict — somebody looked and found nothing. The exposure figure counts both; they are not the same fact and must not be merged.';
comment on column public.inventory_count_variances.discrepancy_id is
  'Set when a reconciler decides a stocktake variance really is attributable to a stay, and raises a checkout discrepancy for it. That keeps inventory_discrepancies the single queue for guest-attributable loss, and stops the two tables disagreeing about which is which.';

create unique index if not exists inventory_count_variances_session_item_idx
  on public.inventory_count_variances (session_id, item_id);
create index if not exists inventory_count_variances_organization_idx
  on public.inventory_count_variances (organization_id, created_at desc);
create index if not exists inventory_count_variances_property_idx
  on public.inventory_count_variances (property_id, created_at desc);
create index if not exists inventory_count_variances_item_idx
  on public.inventory_count_variances (item_id, created_at desc);
create index if not exists inventory_count_variances_unexplained_idx
  on public.inventory_count_variances (organization_id, session_id)
  where classification is null or classification = 'unknown';

drop trigger if exists inventory_count_variances_touch on public.inventory_count_variances;
create trigger inventory_count_variances_touch
  before update on public.inventory_count_variances
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · Row level security
-- ============================================================================
-- No DELETE anywhere. A stocktake that was abandoned is a fact worth keeping;
-- `cancelled` is a status, not a vanishing.
--
-- inventory_count_expectations_select asks for `inventory.adjust` while every
-- other select asks for `inventory.view`. That difference IS the blindness
-- floor and is not an oversight.

alter table public.inventory_count_sessions     enable row level security;
alter table public.inventory_count_sessions     force  row level security;
alter table public.inventory_count_lines        enable row level security;
alter table public.inventory_count_lines        force  row level security;
alter table public.inventory_count_expectations enable row level security;
alter table public.inventory_count_expectations force  row level security;
alter table public.inventory_count_variances    enable row level security;
alter table public.inventory_count_variances    force  row level security;

revoke all on public.inventory_count_sessions     from anon, authenticated;
revoke all on public.inventory_count_lines        from anon, authenticated;
revoke all on public.inventory_count_expectations from anon, authenticated;
revoke all on public.inventory_count_variances    from anon, authenticated;

grant select, insert, update on public.inventory_count_sessions     to authenticated, service_role;
grant select, insert, update on public.inventory_count_lines        to authenticated, service_role;
grant select, insert         on public.inventory_count_expectations to authenticated, service_role;
grant select, insert, update on public.inventory_count_variances    to authenticated, service_role;


-- ============================================================================
-- 7 · Policies
-- ============================================================================

drop policy if exists inventory_count_sessions_select on public.inventory_count_sessions;
create policy inventory_count_sessions_select on public.inventory_count_sessions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_count_sessions_insert on public.inventory_count_sessions;
create policy inventory_count_sessions_insert on public.inventory_count_sessions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_sessions_update on public.inventory_count_sessions;
create policy inventory_count_sessions_update on public.inventory_count_sessions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_lines_select on public.inventory_count_lines;
create policy inventory_count_lines_select on public.inventory_count_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_count_lines_insert on public.inventory_count_lines;
create policy inventory_count_lines_insert on public.inventory_count_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_lines_update on public.inventory_count_lines;
create policy inventory_count_lines_update on public.inventory_count_lines
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

-- THE BLINDNESS FLOOR. `inventory.adjust`, not `inventory.view`.
drop policy if exists inventory_count_expectations_select on public.inventory_count_expectations;
create policy inventory_count_expectations_select on public.inventory_count_expectations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_expectations_insert on public.inventory_count_expectations;
create policy inventory_count_expectations_insert on public.inventory_count_expectations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_variances_select on public.inventory_count_variances;
create policy inventory_count_variances_select on public.inventory_count_variances
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_count_variances_insert on public.inventory_count_variances;
create policy inventory_count_variances_insert on public.inventory_count_variances
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_count_variances_update on public.inventory_count_variances;
create policy inventory_count_variances_update on public.inventory_count_variances
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.adjust')
  );


-- ============================================================================
-- 8 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('inventory_count_sessions'), ('inventory_count_lines'),
    ('inventory_count_expectations'), ('inventory_count_variances')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0057: %', missing;
  end if;

  -- THE BLINDNESS FLOOR. If the counter's own table ever gains an expected
  -- column, a sheet can show the answer and the whole module is decorative.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_count_lines'
      and column_name in ('expected_quantity', 'expected', 'expected_on_shelf')
  ) then
    raise exception
      'inventory_count_lines has an expected column, so a blind sheet could show the answer it exists to withhold';
  end if;

  -- And the expectation table must be gated harder than the sheet.
  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'inventory_count_expectations'
      and p.polname = 'inventory_count_expectations_select'
      and pg_get_expr(p.polqual, p.polrelid) like '%inventory.adjust%'
  ) then
    raise exception
      'the expectation snapshot is not gated on inventory.adjust, so blindness is a component detail rather than a database one';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'inventory_count_sessions_one_live_idx'
  ) then
    raise exception
      'two live stocktakes of one property would be permitted, producing two answers for one cupboard';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname like 'inventory_count%'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and table_name like 'inventory_count%';
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;

  select string_agg(distinct grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name like 'inventory_count%'
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception
      'delete is granted on a stocktake, and an abandoned one is a fact worth keeping: %', missing;
  end if;
end $$;
