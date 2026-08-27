-- ============================================================================
-- 0003_plans.sql — ESTIA foundation · packages, entitlements and subscriptions
--
-- What this does
--   Prices are data, not code. ESTIA staff edit them in the back office, which
--   forces the model to answer a question a hardcoded price list never faces:
--   what happens to the customers who already signed up when the price
--   changes?
--
--   The answer is in the schema. organization_subscriptions stores the price
--   that was agreed at signup — agreed_monthly_price_agorot and
--   agreed_yearly_price_agorot. Editing a plan changes what new customers are
--   offered and never reaches an existing one. "Early customers keep their
--   price" is therefore a property of the database, not a promise somebody has
--   to remember to honour.
--
--   Money is stored in agorot as a bigint. Never a float: floating point
--   cannot represent 0.10 shekels exactly, and money that is almost right is
--   money that is wrong.
--
-- Depends on
--   0001_identity.sql (organizations, public.tg_touch_row).
--
-- Note
--   Row level security for these tables is installed by 0004_rls.sql.
-- ============================================================================

set search_path = public, extensions;


-- ── Types ───────────────────────────────────────────────────────────────────
-- Both mirror src/lib/plans/plan.ts exactly.

do $$ begin
  create type public.billing_interval as enum (
    'monthly',
    'yearly'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.subscription_status as enum (
    'trialing',
    'active',
    'past_due',
    'paused',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;


-- ── plans ───────────────────────────────────────────────────────────────────
-- The catalogue. Global rather than tenant data, and editable by ESTIA staff
-- holding platform.plan.manage.

create table if not exists public.plans (
  id                     uuid primary key default gen_random_uuid(),

  -- Stable machine name. Never changes, even when the display name does.
  code                   citext not null,
  name                   text not null,
  description            text not null default '',

  monthly_price_agorot   bigint not null,
  yearly_price_agorot    bigint not null,

  -- Matches PlanLimits in src/lib/plans/entitlements.ts. null inside the JSON
  -- means unlimited, which is why this is jsonb and not four columns.
  limits                 jsonb not null default
    '{"properties": null, "units": null, "members": null, "storageGb": null}'::jsonb,

  entitlements           text[] not null default '{}'::text[],

  -- A hidden plan still works for whoever is on it; it is simply not offered.
  is_public              boolean not null default true,
  sort_order             integer not null default 0,
  metadata               jsonb not null default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  version                integer not null default 1,
  deleted_at             timestamptz,
  deleted_by             uuid references auth.users (id) on delete set null,

  constraint plans_code_key unique (code),
  constraint plans_code_format check ((code::text) ~ '^[a-z0-9_]{2,40}$'),
  constraint plans_name_not_blank check (length(btrim(name)) > 0),
  constraint plans_version_positive check (version >= 1),

  -- Prices are non-negative. A negative price is not a discount, it is a bug.
  constraint plans_prices_non_negative check (
    monthly_price_agorot >= 0 and yearly_price_agorot >= 0
  ),

  -- The limits object carries exactly the four PlanLimits keys, each either a
  -- number or null. Anything else is a typo that would silently read as
  -- "unlimited".
  constraint plans_limits_shape check (
    limits ?& array['properties', 'units', 'members', 'storageGb']
    and (limits - array['properties', 'units', 'members', 'storageGb']) = '{}'::jsonb
    and jsonb_typeof(limits -> 'properties') in ('number', 'null')
    and jsonb_typeof(limits -> 'units')      in ('number', 'null')
    and jsonb_typeof(limits -> 'members')    in ('number', 'null')
    and jsonb_typeof(limits -> 'storageGb')  in ('number', 'null')
  ),

  -- Every element must be a known entitlement. Mirrors ENTITLEMENTS in
  -- src/lib/plans/entitlements.ts.
  constraint plans_entitlements_known check (
    entitlements <@ array[
      'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
      'team', 'operations', 'channels', 'dynamic_pricing', 'owner_portal',
      'approvals', 'automation', 'custom_roles', 'multi_brand', 'api_access'
    ]::text[]
  )
);

comment on table public.plans is
  'The package catalogue. Prices are in agorot as integers and are editable by ESTIA staff; editing a plan changes what new customers are offered and never touches an existing subscription.';
comment on column public.plans.limits is
  'PlanLimits as JSON: properties, units, members, storageGb. null means unlimited. Quotas warn rather than block — a business must never be unable to check a guest in.';
comment on column public.plans.entitlements is
  'Feature switches included in the package. An entitlement is a yes/no feature; a limit is a quantity. The two behave differently on refusal.';

drop trigger if exists plans_touch on public.plans;
create trigger plans_touch
  before update on public.plans
  for each row execute function public.tg_touch_row();


-- ── organization_subscriptions ──────────────────────────────────────────────

create table if not exists public.organization_subscriptions (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null references public.organizations (id) on delete cascade,
  -- Restricted: a plan that customers are on cannot be deleted out from under
  -- them. Retire it by setting is_public false instead.
  plan_id                       uuid not null references public.plans (id) on delete restrict,

  status                        public.subscription_status not null default 'trialing',
  -- Named billing_interval rather than `interval` because INTERVAL is a type
  -- name in Postgres. This is Subscription.interval in src/lib/plans/plan.ts.
  billing_interval              public.billing_interval not null default 'monthly',

  -- The price snapshot. Copied from the plan at signup and never refreshed
  -- when the catalogue changes. This is the whole point of the table.
  agreed_monthly_price_agorot   bigint not null,
  agreed_yearly_price_agorot    bigint not null,

  trial_ends_at                 timestamptz,
  current_period_start          timestamptz,
  current_period_end            timestamptz,
  cancelled_at                  timestamptz,

  -- Per-customer deviations, for the deal that does not fit a package —
  -- "Pro, but with 25 units". Absent keys fall through to the plan.
  limit_overrides               jsonb not null default '{}'::jsonb,
  entitlement_grants            text[] not null default '{}'::text[],
  entitlement_revocations       text[] not null default '{}'::text[],

  metadata                      jsonb not null default '{}'::jsonb,

  created_at                    timestamptz not null default now(),
  created_by                    uuid references auth.users (id) on delete set null,
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references auth.users (id) on delete set null,
  version                       integer not null default 1,
  deleted_at                    timestamptz,
  deleted_by                    uuid references auth.users (id) on delete set null,

  constraint organization_subscriptions_version_positive check (version >= 1),
  constraint organization_subscriptions_prices_non_negative check (
    agreed_monthly_price_agorot >= 0 and agreed_yearly_price_agorot >= 0
  ),
  constraint organization_subscriptions_period_order check (
    current_period_start is null
    or current_period_end is null
    or current_period_end > current_period_start
  ),
  constraint organization_subscriptions_limit_overrides_shape check (
    (limit_overrides - array['properties', 'units', 'members', 'storageGb']) = '{}'::jsonb
  ),
  constraint organization_subscriptions_grants_known check (
    entitlement_grants <@ array[
      'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
      'team', 'operations', 'channels', 'dynamic_pricing', 'owner_portal',
      'approvals', 'automation', 'custom_roles', 'multi_brand', 'api_access'
    ]::text[]
  ),
  constraint organization_subscriptions_revocations_known check (
    entitlement_revocations <@ array[
      'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
      'team', 'operations', 'channels', 'dynamic_pricing', 'owner_portal',
      'approvals', 'automation', 'custom_roles', 'multi_brand', 'api_access'
    ]::text[]
  )
);

comment on table public.organization_subscriptions is
  'One organization subscription, including the price agreed at signup. The agreed price is a snapshot: a later change to the plan catalogue never reaches an existing customer.';
comment on column public.organization_subscriptions.agreed_monthly_price_agorot is
  'Monthly price in agorot agreed with this customer. Copied from the plan at signup, then owned by the subscription.';
comment on column public.organization_subscriptions.limit_overrides is
  'Partial PlanLimits. Present keys win over the plan; absent keys fall through.';
comment on column public.organization_subscriptions.entitlement_revocations is
  'Features withdrawn for this customer specifically. A revocation beats a grant — the safer reading wins, as with deny by default.';

-- One live subscription per organization. Soft-deleted rows stay for history.
create unique index if not exists organization_subscriptions_organization_idx
  on public.organization_subscriptions (organization_id)
  where deleted_at is null;

drop trigger if exists organization_subscriptions_touch on public.organization_subscriptions;
create trigger organization_subscriptions_touch
  before update on public.organization_subscriptions
  for each row execute function public.tg_touch_row();


-- ── Seed · the four packages ────────────────────────────────────────────────
-- From src/lib/plans/catalog.ts, prices in agorot excluding VAT. The yearly
-- figure is ten months for twelve — the two-months-free rule.
--
-- This runs once so a fresh installation has something sensible in it. From
-- here the back office is the source of truth, which is why the conflict
-- clause only fills in a plan that is missing rather than resetting prices an
-- administrator may have edited.

insert into public.plans (code, name, description, monthly_price_agorot, yearly_price_agorot, limits, entitlements, is_public, sort_order)
values
  (
    'basic',
    'Basic',
    'ניהול צימר או וילה בודדת — הזמנות, יומן, חוזה, תשלומים וחשבוניות.',
    14900,
    149000,
    '{"properties": 1, "units": 2, "members": 2, "storageGb": 2}'::jsonb,
    array['core', 'payments', 'invoicing']::text[],
    true,
    1
  ),
  (
    'direct',
    'Direct',
    'הכל ב-Basic, ובנוסף אתר עסקי עם SEO והזמנה ישירה — בלי עמלת Airbnb.',
    29900,
    299000,
    '{"properties": 1, "units": 4, "members": 3, "storageGb": 10}'::jsonb,
    array['core', 'payments', 'invoicing', 'website', 'ai_content']::text[],
    true,
    2
  ),
  (
    'pro',
    'Pro',
    'למתחמים: צוות ותפקידים, ניקיון ותחזוקה, ערוצי הפצה ותמחור דינמי.',
    64900,
    649000,
    '{"properties": 5, "units": 15, "members": 10, "storageGb": 50}'::jsonb,
    array[
      'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
      'team', 'operations', 'channels', 'dynamic_pricing'
    ]::text[],
    true,
    3
  ),
  (
    'management',
    'Management',
    'לחברות ניהול נכסים: פורטל בעלים, דוחות והתחשבנות, אישורים ותקלות.',
    149000,
    1490000,
    '{"properties": 25, "units": 60, "members": null, "storageGb": 200}'::jsonb,
    array[
      'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
      'team', 'operations', 'channels', 'dynamic_pricing', 'owner_portal',
      'approvals', 'automation', 'custom_roles', 'multi_brand'
    ]::text[],
    true,
    4
  )
on conflict (code) do nothing;
