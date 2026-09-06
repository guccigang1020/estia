-- ============================================================================
-- 0050_fiscal_and_guest_book.sql — ESTIA · two bounded Israeli capabilities
--
-- What this adds, and what it deliberately does not
--   ESTIA does not become accounting software. The six invoicing tables from
--   0016 and every line of `src/lib/finance/**` are untouched: `composeInvoice`,
--   `issueInvoice`, `issueCreditNote` and the gapless `invoice_sequences`
--   remain the only way ESTIA issues its own invoice.
--
--   What was missing is a way to reference a document some OTHER system
--   issued, and a register of who stayed. Both sit beside finance rather than
--   on top of it.
--
-- The one rule the fiscal side exists to keep
--   Payment truth and fiscal truth are SEPARATE. A payment can be recorded and
--   its accounting document still pending, and the product has to be able to
--   say exactly that — "תשלום נרשם · מסמך חשבונאי ממתין" — rather than pick
--   one of the two and be wrong. There is no combined status column here and
--   there must never be one.
--
--   `fiscal_documents_issued_needs_number` is the constraint that makes it
--   structural: a row cannot claim `issued` without the vendor's own document
--   id AND number. ESTIA never generates a document number, and
--   `fiscal_documents_null_provider_unnumbered` makes it impossible for the
--   null provider to have invented one.
--
-- Why `refused` is not a failure
--   There are no fiscal-provider credentials in this codebase. The null
--   implementation refuses honestly and records why, exactly as
--   `site_generation_requests` does for the absent model. A retry queue that
--   treated a refusal as a transient failure would loop forever, so
--   `fiscal_documents_refused_never_scheduled` forbids scheduling one.
--
--   `unknown` is the genuinely dangerous state: the vendor did not answer, a
--   numbered legal document may exist that ESTIA cannot see, and retrying
--   would produce a duplicate tax invoice — which cannot be un-issued. It is
--   its own status and its own ALERT event for that reason.
--
-- On the guest book and compliance
--   This module makes NO claim about what any jurisdiction requires, and the
--   domain code carries a test that greps its own source for phrases like
--   "ensures compliance" and fails if one appears. Which fields a business
--   records is CONFIGURATION, the default set is conservative, the capability
--   is OFF by default, and `fields_reviewed_by` records that a person
--   confirmed it. Anything stronger would be ESTIA asserting a legal position
--   it is not in a position to assert.
--
--   `guest_book_entries.property_id` and `.booking_id` are ON DELETE RESTRICT.
--   A register whose rows vanish when somebody deletes a booking is not a
--   register — the same argument invoices already makes. `organization_id`
--   still cascades, because deleting a tenant deletes the tenant.
--
-- Depends on
--   0002 (permissions), 0008 (properties), 0009 (bookings), 0016 (invoices),
--   0004 (my_organizations, has_permission, property_in_scope).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Three grants
-- ============================================================================
-- Everything else these screens need already existed and is reused rather than
-- duplicated: `invoice.view`, `invoice.issue`, `integration.manage` and
-- `guest.export`. These three have no equivalent.
--
--   fiscal.resolve    — work the queue of documents that failed, were refused,
--                       or whose outcome the vendor never confirmed. NOT
--                       `invoice.issue`: resolving one issues nothing and
--                       touches no money.
--   guest_book.view   — the historical register. Separate from `guest.view`
--                       because an accountant needs the register without
--                       today's guest cards, and a receptionist needs today's
--                       cards without five years of history.
--   guest_book.manage — deciding what this business records, and correcting an
--                       entry.

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values
  ('fiscal.resolve',     'action'::public.permission_kind, 'finance', false, 1680),
  ('guest_book.view',    'action'::public.permission_kind, 'guest',   false, 1690),
  ('guest_book.manage',  'action'::public.permission_kind, 'guest',   false, 1700)
on conflict (code) do nothing;


-- ============================================================================
-- 2 · Vocabularies
-- ============================================================================

do $$ begin
  create type public.fiscal_document_type as enum (
    'proforma', 'tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_invoice'
  );
exception when duplicate_object then null;
end $$;

comment on type public.fiscal_document_type is
  'The first four are INVOICE_KINDS from src/lib/finance/types.ts, in that order — src/lib/fiscal/types.ts builds its tuple by spreading INVOICE_KINDS so the two cannot drift, and this enum must keep that order.';

do $$ begin
  create type public.fiscal_document_status as enum (
    'pending', 'issued', 'failed', 'refused', 'unknown', 'cancelled', 'credited'
  );
exception when duplicate_object then null;
end $$;

comment on type public.fiscal_document_status is
  'refused is an ordinary outcome and not a failure: a provider that is not connected refuses honestly, and a retry queue treating that as a failure would loop forever. unknown is the dangerous one — the vendor did not answer, a numbered legal document may exist that ESTIA cannot see, and retrying would create a duplicate tax invoice, which cannot be un-issued.';

do $$ begin
  create type public.fiscal_source_kind as enum (
    'invoice', 'payment', 'refund', 'credit_note'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.guest_book_entry_status as enum (
    'expected', 'arrived', 'departed', 'cancelled'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 3 · Fiscal settings
-- ============================================================================

create table if not exists public.fiscal_settings (
  organization_id     uuid primary key references public.organizations (id) on delete cascade,
  provider            text not null default 'none',
  documents_expected  boolean not null default false,
  capabilities        text[] not null default '{}',
  credentials_ref     text,
  connected_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  constraint fiscal_settings_capabilities_require_provider check (
    provider <> 'none' or cardinality(capabilities) = 0
  ),
  constraint fiscal_settings_version_positive check (version >= 1)
);

comment on table public.fiscal_settings is
  'Which accounting vendor this organization uses, if any. documents_expected defaults to FALSE: a business issuing its documents in its accountant''s own system has nothing outstanding, and defaulting it true would show every such customer a permanent backlog they cannot clear.';
comment on column public.fiscal_settings.credentials_ref is
  'A handle into the secret store, never a credential. The same rule as payment_collection_settings.live_provider and notification_deliveries.provider.';
comment on column public.fiscal_settings.capabilities is
  'What the connected vendor declares it can do. Empty means nothing is connected; non-empty means connected but limited, and the two produce different refusals on screen. The CHECK stops the null provider claiming a capability.';

drop trigger if exists fiscal_settings_touch on public.fiscal_settings;
create trigger fiscal_settings_touch
  before update on public.fiscal_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · Fiscal documents
-- ============================================================================

create table if not exists public.fiscal_documents (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  property_id               uuid references public.properties (id) on delete set null,
  booking_id                uuid references public.bookings (id) on delete set null,
  invoice_id                uuid references public.invoices (id) on delete set null,
  provider                  text not null default 'none',
  provider_document_id      text,
  provider_document_number  text,
  type                      public.fiscal_document_type not null,
  status                    public.fiscal_document_status not null default 'pending',
  customer_name             text not null,
  customer_tax_id           text,
  amount_agorot             bigint not null,
  tax_agorot                bigint not null default 0,
  tax_rate_bps              integer,
  currency                  text not null default 'ILS',
  issue_date                date,
  source_kind               public.fiscal_source_kind not null,
  source_id                 uuid not null,
  document_url              text,
  document_url_expires_at   timestamptz,
  failure_code              text,
  failure_reason            text,
  provider_status           text,
  attempt_count             integer not null default 0,
  last_attempt_at           timestamptz,
  next_retry_at             timestamptz,
  reviewed_at               timestamptz,
  reviewed_by               uuid references auth.users (id) on delete set null,
  corrects_document_id      uuid references public.fiscal_documents (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  version                   integer not null default 1,

  -- THE ONE THAT MATTERS. An issued document without the vendor's own id and
  -- number is a document ESTIA invented.
  constraint fiscal_documents_issued_needs_number check (
    status not in ('issued'::public.fiscal_document_status,
                   'cancelled'::public.fiscal_document_status,
                   'credited'::public.fiscal_document_status)
    or (provider_document_id is not null and provider_document_number is not null)
  ),
  constraint fiscal_documents_failure_recorded check (
    status not in ('failed'::public.fiscal_document_status,
                   'refused'::public.fiscal_document_status,
                   'unknown'::public.fiscal_document_status)
    or failure_code is not null
  ),
  constraint fiscal_documents_refused_never_scheduled check (
    status <> 'refused'::public.fiscal_document_status or next_retry_at is null
  ),
  constraint fiscal_documents_money_nonneg check (
    amount_agorot >= 0 and tax_agorot >= 0
  ),
  constraint fiscal_documents_null_provider_unnumbered check (
    provider <> 'none' or provider_document_number is null
  ),
  constraint fiscal_documents_attempts_nonneg check (attempt_count >= 0),
  constraint fiscal_documents_not_self_correcting check (
    corrects_document_id is distinct from id
  ),
  constraint fiscal_documents_version_positive check (version >= 1)
);

comment on table public.fiscal_documents is
  'A REFERENCE to a document an external vendor issued. No lines, no totals computed: amount_agorot is copied from the finance record named by (source_kind, source_id) and never re-derived. ESTIA does not become accounting software, and it never generates a document number.';
comment on column public.fiscal_documents.provider_document_number is
  'What is printed on the document. Produced by the vendor and never by ESTIA — fiscal_documents_null_provider_unnumbered makes it impossible for the null provider to have invented one.';
comment on column public.fiscal_documents.next_retry_at is
  'Null for every refused row, by CHECK. A refusal — not connected, capability unsupported — is not a transient failure, and retrying one loops forever.';
comment on column public.fiscal_documents.document_url_expires_at is
  'So the screen can hide an expired link rather than render a dead button.';

create index if not exists fiscal_documents_org_created_idx
  on public.fiscal_documents (organization_id, created_at desc);
create index if not exists fiscal_documents_queue_idx
  on public.fiscal_documents (organization_id, status, created_at desc)
  where status in ('failed'::public.fiscal_document_status,
                   'refused'::public.fiscal_document_status,
                   'unknown'::public.fiscal_document_status);
create index if not exists fiscal_documents_retry_idx
  on public.fiscal_documents (next_retry_at) where next_retry_at is not null;
create index if not exists fiscal_documents_source_idx
  on public.fiscal_documents (organization_id, source_kind, source_id);
create index if not exists fiscal_documents_invoice_idx
  on public.fiscal_documents (invoice_id) where invoice_id is not null;
create index if not exists fiscal_documents_property_idx
  on public.fiscal_documents (property_id);

-- One issued document per source. A duplicate tax invoice cannot be un-issued.
create unique index if not exists fiscal_documents_one_issued_per_source
  on public.fiscal_documents (organization_id, source_kind, source_id)
  where status in ('issued'::public.fiscal_document_status,
                   'cancelled'::public.fiscal_document_status,
                   'credited'::public.fiscal_document_status);
create unique index if not exists fiscal_documents_provider_ref
  on public.fiscal_documents (organization_id, provider, provider_document_id)
  where provider_document_id is not null;

drop trigger if exists fiscal_documents_touch on public.fiscal_documents;
create trigger fiscal_documents_touch
  before update on public.fiscal_documents
  for each row execute function public.tg_touch_row();

create or replace function public.tg_fiscal_documents_number_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('issued', 'cancelled', 'credited') then
    if new.provider_document_id is distinct from old.provider_document_id
       or new.provider_document_number is distinct from old.provider_document_number
       or new.amount_agorot is distinct from old.amount_agorot then
      raise exception
        'an issued fiscal document cannot be renumbered or repriced'
        using hint = 'מסמך שהונפק אינו ניתן לשינוי. להוצאת תיקון יש להפיק מסמך זיכוי.',
              errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.tg_fiscal_documents_number_immutable() is
  'Once a vendor has issued a numbered document, its number and its amount are what the vendor printed. Correcting one is a credit document, never an edit — the same argument invoices_freeze_issued makes about ESTIA''s own invoices.';

revoke all on function public.tg_fiscal_documents_number_immutable() from public, anon, authenticated, service_role;

drop trigger if exists fiscal_documents_number_immutable on public.fiscal_documents;
create trigger fiscal_documents_number_immutable
  before update on public.fiscal_documents
  for each row execute function public.tg_fiscal_documents_number_immutable();


-- ============================================================================
-- 5 · Reconciliation runs
-- ============================================================================

create table if not exists public.fiscal_reconciliation_runs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  provider           text not null default 'none',
  window_from        date not null,
  window_to          date not null,
  ran_at             timestamptz not null default now(),
  ran_by             uuid references auth.users (id) on delete set null,
  difference_count   integer,
  difference_agorot  bigint,
  matched_count      integer,
  matched_agorot     bigint,
  differences        jsonb not null default '[]'::jsonb,
  refusal_reason     text,
  -- A run that was REFUSED recorded nothing, and must never be able to render
  -- as "0 differences" — the single most dangerous number this screen could
  -- show.
  constraint fiscal_runs_refusal_xor_result check (
    (refusal_reason is null) <> (difference_count is null)
  ),
  constraint fiscal_runs_window check (window_to >= window_from),
  constraint fiscal_runs_differences_array check (
    jsonb_typeof(differences) = 'array'
  )
);

comment on table public.fiscal_reconciliation_runs is
  'One comparison of ESTIA against the vendor. fiscal_runs_refusal_xor_result is the load-bearing constraint: a run that was REFUSED recorded nothing, and must never be able to render as "0 differences" — which is the single most dangerous number this screen could show.';

create index if not exists fiscal_runs_org_idx
  on public.fiscal_reconciliation_runs (organization_id, ran_at desc);


-- ============================================================================
-- 6 · The guest register
-- ============================================================================

create table if not exists public.guest_book_settings (
  organization_id     uuid primary key references public.organizations (id) on delete cascade,
  enabled             boolean not null default false,
  property_ids        uuid[] not null default '{}',
  required_fields     text[] not null default
                        '{booking_reference,property,primary_guest_name,arrival,departure,guest_count}',
  fields_reviewed_at  timestamptz,
  fields_reviewed_by  uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  -- Mirrored from GUEST_BOOK_FIELDS. A stored name the code cannot render
  -- would make every entry permanently incomplete against a requirement
  -- nothing can satisfy.
  constraint guest_book_settings_fields_known check (
    required_fields <@ array[
      'booking_reference', 'property', 'primary_guest_name', 'guest_address',
      'arrival', 'departure', 'guest_count', 'financial_document', 'notes'
    ]::text[]
  ),
  constraint guest_book_settings_review_pair check (
    (fields_reviewed_at is null) = (fields_reviewed_by is null)
  ),
  constraint guest_book_settings_version_positive check (version >= 1)
);

comment on table public.guest_book_settings is
  'Which fields this business requires in its register. OFF by default and configuration rather than law: ESTIA makes no claim about what any jurisdiction requires, and the operator confirms what their business must record. fields_reviewed_by records that somebody did.';
comment on column public.guest_book_settings.property_ids is
  'Empty means every property. An explicit list narrows it, for a business where only some properties are in scope.';

drop trigger if exists guest_book_settings_touch on public.guest_book_settings;
create trigger guest_book_settings_touch
  before update on public.guest_book_settings
  for each row execute function public.tg_touch_row();

create table if not exists public.guest_book_entries (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  property_id             uuid not null references public.properties (id) on delete restrict,
  booking_id              uuid not null references public.bookings (id) on delete restrict,
  booking_reference       text not null,
  primary_guest_name      text,
  address_line            text,
  address_city            text,
  address_postal_code     text,
  address_country         text,
  arrival_date            date not null,
  arrival_time            time,
  departure_date          date,
  departure_time          time,
  guest_count             integer not null default 0,
  financial_document_ref  text,
  financial_document_id   uuid references public.invoices (id) on delete set null,
  notes                   text,
  status                  public.guest_book_entry_status not null default 'expected',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  version                 integer not null default 1,
  constraint guest_book_entries_dates check (
    departure_date is null or departure_date >= arrival_date
  ),
  constraint guest_book_entries_guests_nonneg check (guest_count >= 0),
  constraint guest_book_entries_arrival_time_needs_arrival check (
    arrival_time is null or status <> 'expected'::public.guest_book_entry_status
  ),
  constraint guest_book_entries_version_positive check (version >= 1)
);

comment on table public.guest_book_entries is
  'The register. property_id and booking_id are ON DELETE RESTRICT rather than CASCADE, deliberately: a register whose rows vanish when somebody deletes a booking is not a register. The same argument invoices makes. organization_id still cascades, because deleting a tenant deletes the tenant.';
comment on column public.guest_book_entries.arrival_time is
  'An hour somebody stated is not an arrival. The CHECK refuses a time on a row still marked expected, so the register cannot record a guest as having arrived at 15:00 on a stay nobody has confirmed happened.';
comment on column public.guest_book_entries.booking_reference is
  'Snapshotted. The register must still read correctly when the booking it came from has been amended.';

create unique index if not exists guest_book_entries_one_per_booking
  on public.guest_book_entries (organization_id, booking_id);
create index if not exists guest_book_entries_register_idx
  on public.guest_book_entries (organization_id, arrival_date desc);
create index if not exists guest_book_entries_property_idx
  on public.guest_book_entries (organization_id, property_id, arrival_date desc);
create index if not exists guest_book_entries_status_idx
  on public.guest_book_entries (organization_id, status, arrival_date desc);

drop trigger if exists guest_book_entries_touch on public.guest_book_entries;
create trigger guest_book_entries_touch
  before update on public.guest_book_entries
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · Row level security
-- ============================================================================

alter table public.fiscal_settings             enable row level security;
alter table public.fiscal_settings             force  row level security;
alter table public.fiscal_documents            enable row level security;
alter table public.fiscal_documents            force  row level security;
alter table public.fiscal_reconciliation_runs  enable row level security;
alter table public.fiscal_reconciliation_runs  force  row level security;
alter table public.guest_book_settings         enable row level security;
alter table public.guest_book_settings         force  row level security;
alter table public.guest_book_entries          enable row level security;
alter table public.guest_book_entries          force  row level security;

revoke all on public.fiscal_settings            from anon, authenticated;
revoke all on public.fiscal_documents           from anon, authenticated;
revoke all on public.fiscal_reconciliation_runs from anon, authenticated;
revoke all on public.guest_book_settings        from anon, authenticated;
revoke all on public.guest_book_entries         from anon, authenticated;

grant select, insert, update on public.fiscal_settings            to authenticated;
grant select, insert, update on public.fiscal_documents           to authenticated;
grant select, insert         on public.fiscal_reconciliation_runs to authenticated;
grant select, insert, update on public.guest_book_settings        to authenticated;
grant select, insert, update on public.guest_book_entries         to authenticated;

grant select, insert, update on public.fiscal_settings            to service_role;
grant select, insert, update on public.fiscal_documents           to service_role;
grant select, insert         on public.fiscal_reconciliation_runs to service_role;
grant select, insert, update on public.guest_book_settings        to service_role;
grant select, insert, update on public.guest_book_entries         to service_role;

-- A reference to a legal document is evidence. The same argument 0042 makes
-- about site_versions, and it holds against service_role too.
revoke delete, truncate on public.fiscal_documents           from authenticated, service_role;
revoke delete, truncate on public.fiscal_reconciliation_runs from authenticated, service_role;
revoke delete, truncate on public.guest_book_entries         from authenticated, service_role;


-- ============================================================================
-- 8 · Policies
-- ============================================================================

drop policy if exists fiscal_settings_select on public.fiscal_settings;
create policy fiscal_settings_select on public.fiscal_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists fiscal_settings_write on public.fiscal_settings;
create policy fiscal_settings_write on public.fiscal_settings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  );

drop policy if exists fiscal_documents_select on public.fiscal_documents;
create policy fiscal_documents_select on public.fiscal_documents
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists fiscal_documents_insert on public.fiscal_documents;
create policy fiscal_documents_insert on public.fiscal_documents
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'invoice.issue')
  );

-- Retrying a failed document and reviewing an unknown one is not issuing.
drop policy if exists fiscal_documents_update on public.fiscal_documents;
create policy fiscal_documents_update on public.fiscal_documents
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'fiscal.resolve')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'fiscal.resolve')
  );

drop policy if exists fiscal_runs_select on public.fiscal_reconciliation_runs;
create policy fiscal_runs_select on public.fiscal_reconciliation_runs
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists fiscal_runs_insert on public.fiscal_reconciliation_runs;
create policy fiscal_runs_insert on public.fiscal_reconciliation_runs
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'fiscal.resolve')
  );

drop policy if exists guest_book_settings_select on public.guest_book_settings;
create policy guest_book_settings_select on public.guest_book_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest_book.view')
  );

drop policy if exists guest_book_settings_write on public.guest_book_settings;
create policy guest_book_settings_write on public.guest_book_settings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest_book.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'guest_book.manage')
  );

drop policy if exists guest_book_entries_select on public.guest_book_entries;
create policy guest_book_entries_select on public.guest_book_entries
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'guest_book.view')
  );

drop policy if exists guest_book_entries_write on public.guest_book_entries;
create policy guest_book_entries_write on public.guest_book_entries
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'guest_book.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'guest_book.manage')
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
    ('fiscal_settings'), ('fiscal_documents'), ('fiscal_reconciliation_runs'),
    ('guest_book_settings'), ('guest_book_entries')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0050: %', missing;
  end if;

  select string_agg(code, ', ') into missing
  from (values ('fiscal.resolve'), ('guest_book.view'), ('guest_book.manage')) as g(code)
  where not exists (select 1 from public.permissions where permissions.code = g.code);
  if missing is not null then
    raise exception 'permissions missing for 0050: %', missing;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fiscal_documents_issued_needs_number'
      and conrelid = 'public.fiscal_documents'::regclass
  ) then
    raise exception
      'an issued document could exist with no vendor number, which is a document ESTIA invented';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fiscal_runs_refusal_xor_result'
      and conrelid = 'public.fiscal_reconciliation_runs'::regclass
  ) then
    raise exception
      'a refused reconciliation run could render as zero differences';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'fiscal_documents_number_immutable' and not tgisinternal
  ) then
    raise exception 'an issued document could be renumbered or repriced';
  end if;

  -- The register must survive the BOOKING and the PROPERTY. organization_id
  -- still cascades, because deleting a tenant deletes the tenant, and
  -- financial_document_id sets null, because losing the invoice link is not
  -- losing the entry — so only these two are asserted. The first version of
  -- this check asserted every foreign key and failed on both of those, which
  -- is what a rehearsal is for.
  select string_agg(c.conname, ', ') into missing
  from pg_constraint c
  join pg_attribute a
    on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.conrelid = 'public.guest_book_entries'::regclass
    and c.contype = 'f'
    and a.attname in ('property_id', 'booking_id')
    and c.confdeltype <> 'r';
  if missing is not null then
    raise exception
      'a guest book row would be deleted with its booking or property: %', missing;
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('fiscal_settings', 'fiscal_documents',
                      'fiscal_reconciliation_runs', 'guest_book_settings',
                      'guest_book_entries')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon'
    and (table_name like 'fiscal%' or table_name like 'guest_book%');
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;

  select string_agg(distinct table_name || ' -> ' || grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('fiscal_documents', 'fiscal_reconciliation_runs',
                       'guest_book_entries')
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception 'delete is still granted on a legal record: %', missing;
  end if;

  select string_agg(c.relname || '.' || a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (c.relname like 'fiscal%' or c.relname like 'guest_book%')
    and a.attnum > 0 and not a.attisdropped
    and (a.attname like '%secret%' or a.attname like '%api_key%'
         or a.attname like '%password%'
         or (a.attname like '%credential%' and a.attname <> 'credentials_ref'));
  if missing is not null then
    raise exception '0050 carries credential columns and must not: %', missing;
  end if;
end $$;
