-- ============================================================================
-- 0056_owner_portal.sql — ESTIA · the people who own the villas
--
-- What was missing
--   `owner.view`, `owner.manage`, `owner_statement.view`,
--   `owner_statement.issue` and `owner.view_commission` all existed. So did
--   the `owner_portal` entitlement, sold on the pro and management plans, and
--   the `property_owner` composed role. There were ZERO owner tables.
--
--   A customer could buy the owner portal and there was nothing behind it.
--
-- The idea of an owner this file encodes
--   An owner is an OUTSIDE PARTY with a dated share of a property, and
--   `user_id` is nullable because most of them never sign in. That is a
--   different thing from a membership holding the `property_owner` role, which
--   is what `/finance/owners` read — and only this one can carry a statement,
--   a payout and a balance. That screen is now a permanent redirect: two owner
--   screens backed by two ideas of what an owner is would disagree within a
--   week, and the disagreement would be about money.
--
-- The statement reconciles to finance by construction
--   `propertyPnl` already asserts that gross − discount − costs − commission −
--   ownerShare = netProfit. Rearranged, that IS the statement, and the
--   management fee is `pnl.netProfitAgorot` — the residual the business
--   retained — never a second percentage applied to the same revenue.
--   `owner_statements_result_balances` and `_balance_balances` put both
--   identities in the database, because they must hold against the service
--   role and against a repair script, which are the two callers a policy
--   cannot stop.
--
-- Why the freeze is a trigger
--   RLS is bypassed by the service role and by the table owner. "An issued
--   statement never changes" has to hold against both, so it is
--   `tg_owner_statements_frozen` and not the absence of an update policy —
--   the same reasoning `approvals_no_self_approval` uses.
--
-- What the database is NOT holding, stated so nobody assumes it is
--   There is no constraint that a property's shares total 10000. It is a
--   cross-row invariant a CHECK cannot express; `assertWholeOwnership` and the
--   link operation hold it. What the database DOES hold is that one owner
--   cannot have two overlapping shares of one property — without that, every
--   statement in the overlap double-counts.
--
-- Two new grants
--   `owner.payout` — releasing money to a third party. Issuing a document and
--   paying somebody are different acts, and the second cannot be taken back.
--   Not `owner.manage`, which is owner/administrator-only and would put every
--   payout beyond the finance manager whose job it is.
--   `owner_approval.decide` — an owner deciding a request addressed to them.
--   Separate from `approval.decide`, which must never be given to a property
--   owner: it would let them decide an agent's discount approval in their own
--   scope.
--
-- Depends on
--   0002 (permissions), 0008 (properties and its composite key), 0004 (RLS
--   helpers), and btree_gist for the overlap exclusion.
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Two grants
-- ============================================================================

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values
  ('owner.payout',           'action'::public.permission_kind, 'owners', false, 1730),
  ('owner_approval.decide',  'action'::public.permission_kind, 'owners', false, 1740)
on conflict (code) do nothing;


-- ============================================================================
-- 2 · Vocabularies — transcribed from src/lib/owners/types.ts, in order
-- ============================================================================

do $$ begin
  create type public.owner_status as enum ('active', 'inactive');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.owner_statement_status as enum ('draft', 'issued');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.owner_statement_section as enum ('result', 'balance', 'expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.owner_statement_line_kind as enum
    ('revenue', 'cost', 'result', 'carried');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.owner_payout_direction as enum ('to_owner', 'from_owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.owner_payout_method as enum
    ('bank_transfer', 'cheque', 'cash', 'offset');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 3 · The register
-- ============================================================================

create table if not exists public.property_owners (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  display_name    text not null,
  user_id         uuid references auth.users (id) on delete set null,
  email           text,
  phone           text,
  status          public.owner_status not null default 'active',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  constraint property_owners_id_org_key unique (id, organization_id),
  constraint property_owners_name_not_blank check (length(btrim(display_name)) > 0),
  constraint property_owners_version_positive check (version >= 1)
);

comment on table public.property_owners is
  'An outside party with a share of a property. user_id is NULLABLE and usually null — most owners never sign in, and a model that required an account would have excluded the majority of them. This is a different idea from a membership holding the property_owner role, and only this one can carry a statement.';

create unique index if not exists property_owners_user_idx
  on public.property_owners (organization_id, user_id) where user_id is not null;

comment on index public.property_owners_user_idx is
  'Two owner records sharing one account would make "is this statement mine" ambiguous, and that comparison is a security check rather than a display detail.';

create index if not exists property_owners_name_idx
  on public.property_owners (organization_id, display_name);

drop trigger if exists property_owners_touch on public.property_owners;
create trigger property_owners_touch
  before update on public.property_owners
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · Shares, dated
-- ============================================================================

create table if not exists public.property_ownerships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  owner_id        uuid not null,
  property_id     uuid not null,
  share_bps       integer not null,
  effective_from  date not null,
  effective_to    date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  constraint property_ownerships_owner_fkey foreign key (owner_id, organization_id)
    references public.property_owners (id, organization_id) on delete cascade,
  constraint property_ownerships_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint property_ownerships_id_org_key unique (id, organization_id),
  constraint property_ownerships_share_range check (share_bps between 1 and 10000),
  constraint property_ownerships_window check (
    effective_to is null or effective_to >= effective_from
  ),
  constraint property_ownerships_unique_start
    unique (organization_id, owner_id, property_id, effective_from),
  constraint property_ownerships_version_positive check (version >= 1)
);

comment on table public.property_ownerships is
  'A share, in basis points, over a dated window. There is deliberately NO constraint that a property''s shares total 10000: that is a cross-row invariant a CHECK cannot express, and it is held by assertWholeOwnership and by the link operation. Stated here so nobody assumes the database is holding it.';

-- What the database DOES hold. Without it one owner could hold two
-- overlapping shares of one property, and every statement in the overlap
-- would double-count.
do $$ begin
  alter table public.property_ownerships
    add constraint property_ownerships_no_overlap
    exclude using gist (
      organization_id with =,
      owner_id with =,
      property_id with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    );
exception when duplicate_object then null; end $$;

create index if not exists property_ownerships_owner_idx
  on public.property_ownerships (organization_id, owner_id);
create index if not exists property_ownerships_property_idx
  on public.property_ownerships (organization_id, property_id);

drop trigger if exists property_ownerships_touch on public.property_ownerships;
create trigger property_ownerships_touch
  before update on public.property_ownerships
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · Statements
-- ============================================================================

create table if not exists public.owner_statements (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations (id) on delete cascade,
  owner_id                    uuid not null,
  property_id                 uuid not null,
  period_start                date not null,
  period_end                  date not null,
  status                      public.owner_statement_status not null default 'draft',
  issued_at                   timestamptz,
  issued_by                   uuid references auth.users (id) on delete set null,
  share_bps                   integer not null,
  gross_revenue_agorot        bigint not null,
  fees_agorot                 bigint not null,
  expenses_agorot             bigint not null,
  sales_commission_agorot     bigint,
  management_fee_agorot       bigint not null,
  property_owner_share_agorot bigint not null,
  owner_share_agorot          bigint not null,
  opening_balance_agorot      bigint not null default 0,
  payments_agorot             bigint not null default 0,
  payouts_agorot              bigint not null default 0,
  closing_balance_agorot      bigint not null,
  booking_count               integer not null default 0,
  created_at                  timestamptz not null default now(),
  version                     integer not null default 1,
  constraint owner_statements_owner_fkey foreign key (owner_id, organization_id)
    references public.property_owners (id, organization_id) on delete restrict,
  constraint owner_statements_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete restrict,
  constraint owner_statements_id_org_key unique (id, organization_id),
  constraint owner_statements_period check (period_end >= period_start),
  constraint owner_statements_issued_pair check ((status = 'issued') = (issued_at is not null)),
  constraint owner_statements_issuer check (issued_at is null or issued_by is not null),
  constraint owner_statements_share_range check (share_bps between 1 and 10000),
  constraint owner_statements_booking_count check (booking_count >= 0),
  constraint owner_statements_balance_balances check (
    closing_balance_agorot
      = opening_balance_agorot + owner_share_agorot + payments_agorot - payouts_agorot
  ),
  constraint owner_statements_result_balances check (
    property_owner_share_agorot
      = gross_revenue_agorot - fees_agorot - expenses_agorot
        - coalesce(sales_commission_agorot, 0) - management_fee_agorot
  ),
  constraint owner_statements_version_positive check (version >= 1)
);

comment on table public.owner_statements is
  'One period, one owner, one property. The two arithmetic CHECKs are in the database rather than only in the domain because they must hold against the service role and against a repair script — the two callers a policy cannot stop.';
comment on column public.owner_statements.management_fee_agorot is
  'The residual the business retained, taken from the P&L rather than computed as a second percentage. Applying a rate twice is how an owner statement and a profit report come to disagree.';
comment on column public.owner_statements.sales_commission_agorot is
  'Nullable: a reader without owner.view_commission writes nothing here, and the amount is folded into a deductions line instead. Redacted by default for everyone and widened only by the grant — getting a widening wrong hides a number from a finance manager, getting a narrowing wrong shows an outsider what the business pays its agents.';

create index if not exists owner_statements_owner_idx
  on public.owner_statements (organization_id, owner_id, period_end desc);
create index if not exists owner_statements_property_idx
  on public.owner_statements (organization_id, property_id, period_end desc);

create or replace function public.tg_owner_statements_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'issued' then
    raise exception 'an issued owner statement cannot be changed or deleted'
      using hint = 'תיקון נעשה בהפקת דוח חדש, לא בעריכת דוח שכבר נמסר.',
            errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.tg_owner_statements_frozen() is
  'A trigger and not a policy, because RLS is bypassed by the service role and by the table owner. "An issued statement never changes" has to hold against both — the same reasoning as approvals_no_self_approval.';

revoke all on function public.tg_owner_statements_frozen() from public, anon, authenticated, service_role;

drop trigger if exists owner_statements_frozen on public.owner_statements;
create trigger owner_statements_frozen
  before update or delete on public.owner_statements
  for each row execute function public.tg_owner_statements_frozen();

create table if not exists public.owner_statement_lines (
  statement_id    uuid not null,
  organization_id uuid not null,
  section         public.owner_statement_section not null,
  position        integer not null,
  line_key        text not null,
  label           text not null,
  amount_agorot   bigint not null,
  kind            public.owner_statement_line_kind not null,
  rule_id         text,
  primary key (statement_id, section, position),
  constraint owner_statement_lines_statement_fkey
    foreign key (statement_id, organization_id)
    references public.owner_statements (id, organization_id) on delete cascade,
  constraint owner_statement_lines_position check (position >= 0),
  constraint owner_statement_lines_label check (length(btrim(label)) > 0),
  constraint owner_statement_lines_expense_rule check (
    section <> 'expense'::public.owner_statement_section or rule_id is not null
  )
);

create index if not exists owner_statement_lines_read_idx
  on public.owner_statement_lines (organization_id, statement_id, section, position);


-- ============================================================================
-- 6 · Payouts
-- ============================================================================

create table if not exists public.owner_payouts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  owner_id        uuid not null,
  property_id     uuid,
  statement_id    uuid,
  direction       public.owner_payout_direction not null,
  amount_agorot   bigint not null,
  method          public.owner_payout_method not null,
  paid_on         date not null,
  reference       text,
  note            text,
  recorded_by     uuid not null references auth.users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  constraint owner_payouts_owner_fkey foreign key (owner_id, organization_id)
    references public.property_owners (id, organization_id) on delete restrict,
  constraint owner_payouts_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete set null (property_id),
  constraint owner_payouts_statement_fkey foreign key (statement_id, organization_id)
    references public.owner_statements (id, organization_id) on delete set null (statement_id),
  constraint owner_payouts_id_org_key unique (id, organization_id),
  constraint owner_payouts_amount_positive check (amount_agorot > 0)
);

comment on column public.owner_payouts.amount_agorot is
  'Strictly positive. The DIRECTION carries the sign, never the amount — a negative payout and a from_owner receipt are the same fact written two ways, and a report summing both would be wrong by twice.';
comment on column public.owner_payouts.reference is
  'The business''s own reference for the movement. NEVER a bank account number.';

create index if not exists owner_payouts_owner_idx
  on public.owner_payouts (organization_id, owner_id, paid_on desc);
create index if not exists owner_payouts_statement_idx
  on public.owner_payouts (organization_id, statement_id) where statement_id is not null;


-- ============================================================================
-- 7 · Row level security
-- ============================================================================

alter table public.property_owners       enable row level security;
alter table public.property_owners       force  row level security;
alter table public.property_ownerships   enable row level security;
alter table public.property_ownerships   force  row level security;
alter table public.owner_statements      enable row level security;
alter table public.owner_statements      force  row level security;
alter table public.owner_statement_lines enable row level security;
alter table public.owner_statement_lines force  row level security;
alter table public.owner_payouts         enable row level security;
alter table public.owner_payouts         force  row level security;

revoke all on public.property_owners       from anon, authenticated;
revoke all on public.property_ownerships   from anon, authenticated;
revoke all on public.owner_statements      from anon, authenticated;
revoke all on public.owner_statement_lines from anon, authenticated;
revoke all on public.owner_payouts         from anon, authenticated;

grant select, insert, update, delete on public.property_owners       to authenticated;
grant select, insert, update, delete on public.property_ownerships   to authenticated;
grant select, insert                 on public.owner_statements      to authenticated;
grant select, insert                 on public.owner_statement_lines to authenticated;
grant select, insert                 on public.owner_payouts         to authenticated;

grant select, insert, update, delete on public.property_owners       to service_role;
grant select, insert, update, delete on public.property_ownerships   to service_role;
grant select, insert                 on public.owner_statements      to service_role;
grant select, insert                 on public.owner_statement_lines to service_role;
grant select, insert                 on public.owner_payouts         to service_role;

-- A statement, its lines and a payout are the record of money owed and money
-- moved. None of them is deletable by anybody.
revoke delete, truncate on public.owner_statements      from authenticated, service_role;
revoke delete, truncate on public.owner_statement_lines from authenticated, service_role;
revoke delete, truncate on public.owner_payouts         from authenticated, service_role;


-- ============================================================================
-- 8 · Policies
-- ============================================================================
-- The "is it mine" clause appears in the policy as well as in visibility.ts,
-- deliberately: the domain check makes a good screen, and the policy holds
-- when a query is written wrong. Two people may each own half a villa and
-- both be scoped to it, so scope alone cannot answer whose statement this is.

drop policy if exists property_owners_select on public.property_owners;
create policy property_owners_select on public.property_owners
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'owner.view')
      or (user_id = (select auth.uid())
          and public.has_permission(organization_id, 'owner_statement.view'))
    )
  );

drop policy if exists property_owners_write on public.property_owners;
create policy property_owners_write on public.property_owners
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'owner.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'owner.manage')
  );

drop policy if exists property_ownerships_select on public.property_ownerships;
create policy property_ownerships_select on public.property_ownerships
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'owner.view')
      or (
        public.has_permission(organization_id, 'owner_statement.view')
        and exists (
          select 1 from public.property_owners o
          where o.id = property_ownerships.owner_id
            and o.organization_id = property_ownerships.organization_id
            and o.user_id = (select auth.uid())
        )
      )
    )
  );

drop policy if exists property_ownerships_write on public.property_ownerships;
create policy property_ownerships_write on public.property_ownerships
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'owner.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'owner.manage')
  );

drop policy if exists owner_statements_select on public.owner_statements;
create policy owner_statements_select on public.owner_statements
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'owner_statement.view')
    and (
      public.has_permission(organization_id, 'owner.view')
      or exists (
        select 1 from public.property_owners o
        where o.id = owner_statements.owner_id
          and o.organization_id = owner_statements.organization_id
          and o.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists owner_statements_insert on public.owner_statements;
create policy owner_statements_insert on public.owner_statements
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'owner_statement.issue')
  );

drop policy if exists owner_statement_lines_select on public.owner_statement_lines;
create policy owner_statement_lines_select on public.owner_statement_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.owner_statements s
      where s.id = owner_statement_lines.statement_id
        and s.organization_id = owner_statement_lines.organization_id
    )
  );

drop policy if exists owner_statement_lines_insert on public.owner_statement_lines;
create policy owner_statement_lines_insert on public.owner_statement_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'owner_statement.issue')
  );

-- A portfolio-wide settlement carries no property, so it cannot be reached by
-- the owner-identity branch and requires owner.view.
drop policy if exists owner_payouts_select on public.owner_payouts;
create policy owner_payouts_select on public.owner_payouts
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'owner_statement.view')
    and (
      public.has_permission(organization_id, 'owner.view')
      or (
        property_id is not null
        and exists (
          select 1 from public.property_owners o
          where o.id = owner_payouts.owner_id
            and o.organization_id = owner_payouts.organization_id
            and o.user_id = (select auth.uid())
        )
      )
    )
  );

drop policy if exists owner_payouts_insert on public.owner_payouts;
create policy owner_payouts_insert on public.owner_payouts
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'owner.payout')
  );


-- ============================================================================
-- 9 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('property_owners'), ('property_ownerships'), ('owner_statements'),
    ('owner_statement_lines'), ('owner_payouts')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0056: %', missing;
  end if;

  select string_agg(code, ', ') into missing
  from (values ('owner.payout'), ('owner_approval.decide')) as g(code)
  where not exists (select 1 from public.permissions where permissions.code = g.code);
  if missing is not null then
    raise exception 'permissions missing for 0056: %', missing;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'owner_statements_frozen' and not tgisinternal
  ) then
    raise exception
      'an issued owner statement could be edited, and the first question in a dispute is what was decided at the time';
  end if;

  select string_agg(name, ', ') into missing
  from (values
    ('owner_statements_balance_balances'), ('owner_statements_result_balances')
  ) as t(name)
  where not exists (
    select 1 from pg_constraint
    where conname = t.name and conrelid = 'public.owner_statements'::regclass
  );
  if missing is not null then
    raise exception 'the statement arithmetic is unguarded: %', missing;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'property_ownerships_no_overlap'
      and conrelid = 'public.property_ownerships'::regclass
  ) then
    raise exception
      'one owner could hold two overlapping shares of one property, and every statement would then double-count';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('property_owners', 'property_ownerships', 'owner_statements',
                      'owner_statement_lines', 'owner_payouts')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon'
    and (table_name like 'owner%' or table_name like 'property_owner%');
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;
end $$;
