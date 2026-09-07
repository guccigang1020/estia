-- ============================================================================
-- 0077_composite_fk_set_null.sql — ESTIA · twelve deletes that could not run
--
-- ── The defect ─────────────────────────────────────────────────────────────
--
-- Every tenant-scoped foreign key in this product is composite. A store item
-- does not point at a category by id alone; it points at `(category_id,
-- organization_id)` against `store_categories (id, organization_id)`, so the
-- key carries two facts at once — the parent exists, and it belongs to this
-- tenant — and nothing downstream has to re-check the tenant. That design is
-- right and is not what this migration changes.
--
-- What it changes is the delete action. Twelve of those keys were written
--
--     on delete set null
--
-- with no column list. On a single-column key that reads the way everybody
-- reads it. On a COMPOSITE key it means *null every column of the key*,
-- `organization_id` included — and `organization_id` is `not null` on all
-- twelve child tables. So the referential action, if it ever fired, would
-- immediately violate the child's own not-null constraint.
--
-- ── WHY NOTHING CAUGHT IT ══════════════════════════════════════════════════
--
-- Because it is not a defect in the schema, in a write path, or in a read. It
-- is a defect that exists only at the moment somebody deletes a parent row,
-- and no test in this repository deletes one. Every migration applied, every
-- insert and update worked, the gate was green, and twelve deletes were
-- waiting to fail with
--
--     null value in column "organization_id" violates not-null constraint
--
-- — a message about a column the user never touched, on an operation that
-- looks entirely ordinary. A guesthouse deleting a supplier it stopped working
-- with would have seen it, and had no way to understand it.
--
-- It was found by reading, not by running, and that is worth saying plainly:
-- a green gate proved the absence of the tests, not the absence of the bug.
--
-- ── THE FIX ════════════════════════════════════════════════════════════════
--
-- `on delete set null (col)` — Postgres 15 and later let the action name which
-- columns to clear. Each key clears its pointer column and leaves the tenant
-- alone, which is what every one of them meant to say.
--
-- Twelve constraints, one shape. Each is
--   `(pointer, organization_id) references parent (id, organization_id)`
-- so the rebuild below is generated from one list rather than typed twelve
-- times: a hand-typed variant is where the thirteenth mistake would live.
--
-- Dropping and re-adding a foreign key normally means a validation scan. Here
-- the constraint being re-added is byte-for-byte the previous one apart from
-- the delete action, so no existing row can fail it — and in this project the
-- tables are empty besides.
--
-- ── ONE DELETE THIS DOES NOT MAKE POSSIBLE, AND SAYS SO ════════════════════
--
-- `store_items_provider_when_external` requires an item fulfilled by an
-- outside supplier to name one. Nulling `provider_id` on such an item is
-- therefore refused by the check even once the foreign key is correct, so
-- deleting a supplier that still fulfils an external item still fails.
--
-- That refusal is CORRECT — the store deliberately does not allow an external
-- item with no supplier — but the message it produced was a check violation
-- naming a constraint, which tells the person nothing. A trigger below refuses
-- the same delete first, in Hebrew, naming the items in the way. It changes
-- which message appears and not which deletes are allowed.
--
-- Depends on 0031 (`payment_proofs`) and 0032 (the store).
-- ============================================================================

set search_path = public, extensions;

-- ─────────────────────────────────────────────── the twelve, rebuilt ──────

do $$
declare
  r record;
  v_fixed integer := 0;
begin
  for r in
    select *
      from (values
        -- child table              constraint                                     column to clear         parent table
        ('payment_proofs',               'payment_proofs_payment_fkey',                 'payment_id',           'payments'),
        ('store_item_property_overrides','store_item_property_overrides_provider_fkey', 'provider_override_id', 'store_providers'),
        ('store_items',                  'store_items_category_fkey',                   'category_id',          'store_categories'),
        ('store_items',                  'store_items_provider_fkey',                   'provider_id',          'store_providers'),
        ('store_order_line_options',     'store_order_line_options_option_fkey',        'option_id',            'store_item_options'),
        ('store_order_line_options',     'store_order_line_options_value_fkey',         'option_value_id',      'store_item_option_values'),
        ('store_order_lines',            'store_order_lines_item_fkey',                 'item_id',              'store_items'),
        ('store_order_lines',            'store_order_lines_package_fkey',              'package_id',           'store_packages'),
        ('store_order_lines',            'store_order_lines_provider_fkey',             'provider_id',          'store_providers'),
        ('store_orders',                 'store_orders_promo_fkey',                     'promo_code_id',        'store_promo_codes'),
        ('store_packages',               'store_packages_category_fkey',                'category_id',          'store_categories'),
        ('store_provider_requests',      'store_provider_requests_line_fkey',           'order_line_id',        'store_order_lines')
      ) as t(child, conname, set_col, parent)
  loop
    -- Refuse to run against a schema that is not the one this was written for.
    -- A constraint renamed or dropped since would otherwise be recreated here
    -- from this file's assumptions rather than from the schema's reality.
    if not exists (
      select 1
        from pg_constraint c
        join pg_class rel on rel.oid = c.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
       where n.nspname = 'public'
         and rel.relname = r.child
         and c.conname = r.conname
         and c.contype = 'f'
    ) then
      raise exception 'expected constraint %.% and did not find it',
        r.child, r.conname;
    end if;

    execute format('alter table public.%I drop constraint %I',
                   r.child, r.conname);

    execute format(
      'alter table public.%I add constraint %I
         foreign key (%I, organization_id)
         references public.%I (id, organization_id)
         on delete set null (%I)',
      r.child, r.conname, r.set_col, r.parent, r.set_col);

    v_fixed := v_fixed + 1;
  end loop;

  if v_fixed <> 12 then
    raise exception 'expected to rebuild 12 keys, rebuilt %', v_fixed;
  end if;
end $$;

-- ────────────────────────── a delete that is refused, in words ────────────

/**
 * Why a trigger and not a stricter foreign key.
 *
 * The right referential action here depends on the row: for an item fulfilled
 * in-house, forgetting a supplier is correct and `set null` is what we want;
 * for one fulfilled BY that supplier, forgetting them would leave an item
 * nobody can deliver, which is exactly what `store_items_provider_when_external`
 * refuses. Postgres has no conditional referential action, so the condition
 * has to be stated somewhere, and it is stated here.
 *
 * This adds no rule. The check constraint already made this delete fail; the
 * trigger only makes it fail in a sentence a person can act on, and names the
 * items so they know where to go. Soft-deleted items are ignored, because an
 * item already withdrawn is not waiting on anybody.
 */
create or replace function public.tg_provider_still_fulfils_an_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_names text;
begin
  select string_agg(i.name, ', ' order by i.name)
    into v_names
    from public.store_items i
   where i.provider_id = old.id
     and i.organization_id = old.organization_id
     and i.deleted_at is null
     and i.fulfilment_kind = 'external_provider'::public.store_fulfilment_kind;

  if v_names is not null then
    raise exception
      'אי אפשר למחוק את הספק — הפריטים הבאים עדיין מסופקים על ידו: %. שנה אצלם את אופן האספקה, או סמן את הספק כלא פעיל במקום למחוק אותו.',
      v_names
      using errcode = 'foreign_key_violation';
  end if;

  return old;
end;
$$;

comment on function public.tg_provider_still_fulfils_an_item() is
  'Refuses to delete a supplier that still fulfils a live external item, with '
  'the item names. The check constraint refuses it too; this is the wording.';

drop trigger if exists tg_provider_still_fulfils_an_item on public.store_providers;

create trigger tg_provider_still_fulfils_an_item
  before delete on public.store_providers
  for each row
  execute function public.tg_provider_still_fulfils_an_item();

-- ─────────────────────────────────────────────────────── the rehearsal ────

/*
 * Not assertions about the catalogue alone. The last block below performs a
 * real delete against real rows and checks what survived it, then unwinds —
 * because the whole reason this defect lived for forty-five migrations is that
 * nothing ever deleted a parent row.
 */
do $$
declare
  v_bad     text;
  v_n       integer;
  v_org     uuid;
  v_cat     uuid;
  v_item    uuid;
  v_org_of  uuid;
  v_cat_of  uuid;
begin
  /* 1. Every one of the twelve now names exactly its pointer column. */

  select string_agg(c.conname, ', ' order by c.conname)
    into v_bad
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public'
     and c.contype = 'f'
     and c.confdeltype = 'n'
     and array_length(c.conkey, 1) > 1
     and coalesce(array_length(c.confdelsetcols, 1), 0) <> 1;

  if v_bad is not null then
    raise exception
      'a composite set-null key still clears every column: %', v_bad;
  end if;

  /* 2. The general statement of the defect, rather than a re-check of the
        twelve: NO set-null key anywhere in `public` may clear a not-null
        column. Composite or single, listed or not — `confdelsetcols` when it
        is set, and the whole key when it is not, which is precisely what the
        twelve got wrong. A thirteenth introduced later fails here rather than
        at a customer. */

  select string_agg(c.conname, ', ' order by c.conname)
    into v_bad
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public'
     and c.contype = 'f'
     and c.confdeltype = 'n'
     and exists (
       select 1
         from unnest(coalesce(c.confdelsetcols, c.conkey)) as s(attnum)
         join pg_attribute att
           on att.attrelid = c.conrelid and att.attnum = s.attnum
        where att.attnotnull
     );

  if v_bad is not null then
    raise exception
      'a set-null key clears a not-null column, and its delete will fail: %',
      v_bad;
  end if;

  /* 3. The trigger exists and fires before the delete, not after it. */

  select count(*) into v_n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'store_providers'
     and t.tgname = 'tg_provider_still_fulfils_an_item'
     and not t.tgisinternal;

  if v_n <> 1 then
    raise exception 'the supplier guard is not on store_providers';
  end if;

  /* 4. The delete itself, performed. */

  begin
    insert into public.organizations (slug, name)
    values ('rehearsal-0077-must-not-survive', 'רפטיציה 0077')
    returning id into v_org;

    insert into public.store_categories (organization_id, name, slug)
    values (v_org, 'קטגוריית רפטיציה', 'rehearsal-category')
    returning id into v_cat;

    insert into public.store_items
      (organization_id, category_id, name, slug, base_price_agorot)
    values (v_org, v_cat, 'פריט רפטיציה', 'rehearsal-item', 1000)
    returning id into v_item;

    -- The operation that has been failing since 0032. Before this migration
    -- it raised a not-null violation on `organization_id`.
    delete from public.store_categories where id = v_cat;

    select organization_id, category_id
      into v_org_of, v_cat_of
      from public.store_items
     where id = v_item;

    if v_org_of is null then
      raise exception
        'deleting the category cleared the item''s organization';
    end if;
    if v_org_of <> v_org then
      raise exception 'the item changed organization';
    end if;
    if v_cat_of is not null then
      raise exception
        'deleting the category left the item pointing at it';
    end if;

    -- Everything above happened inside this block, which plpgsql runs as a
    -- subtransaction. Raising unwinds all of it, so nothing is left behind.
    raise exception 'ESTIA_REHEARSAL_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'ESTIA_REHEARSAL_ROLLBACK' then raise; end if;
  end;

  if exists (
    select 1 from public.organizations
     where slug = 'rehearsal-0077-must-not-survive'
  ) then
    raise exception 'the rehearsal left an organization behind';
  end if;
end $$;
