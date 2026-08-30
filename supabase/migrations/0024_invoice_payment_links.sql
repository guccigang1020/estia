-- ============================================================================
-- 0024_invoice_payment_links.sql — ESTIA · the array becomes rows, then goes
--
-- What this does
--   Backfills public.invoice_payments from invoices.metadata.payment_ids,
--   proves nothing was lost, and only then removes the key.
--
--   0022 created the table and named the three steps in its own header:
--
--     > whoever moves it should backfill from the array and then stop writing
--     > it, in that order.
--
--   Step two is done — src/lib/persistence/finance.ts reads the links out of
--   invoice_payments and no longer writes the key on insert or update. The
--   array is now dead weight and a second answer to a question the table
--   answers better, in both directions and with foreign keys behind it. This
--   is the last step.
--
-- ── The order is the whole design ───────────────────────────────────────────
--
--   Backfill, then *prove*, then drop. The proof is not a formality and is not
--   skippable, because the array can hold ids the table cannot:
--
--     · a payment that does not exist — a typo, or a draft deleted since;
--     · a payment belonging to another organization;
--     · a payment recorded against a different booking than the invoice.
--
--   The join refuses all three, deliberately: 0022 gave both foreign keys
--   (id, organization_id, booking_id) precisely so a link between an invoice
--   for one stay and a payment against another cannot be written down. So an
--   id that does not survive the join is not noise to be swept up — it is a
--   reconciliation that is wrong today, and the array is the only remaining
--   record that it was ever claimed.
--
--   Dropping the key over it would destroy that evidence, silently, during a
--   migration nobody was watching. So this raises and stops instead, and the
--   deployment stays exactly as it was until a person has decided what each
--   residue row means. There is no flag to skip the check: a switch that
--   turns off the proof is the proof not existing.
--
--   A payment_ids that is not a JSON array is refused for the same reason.
--   The backfill reads arrays and nothing else, so anything else is data this
--   migration cannot account for, and deleting what it cannot read is the
--   same mistake wearing a different shape.
--
-- ── Two consequences worth stating ─────────────────────────────────────────
--
--   **Re-running is safe.** The insert is ON CONFLICT DO NOTHING, the proof
--   passes trivially once the keys are gone, and the UPDATE touches only rows
--   that still carry one.
--
--   **The UPDATE bumps invoices.version**, because invoices_touch owns that
--   column and this is an ordinary update. Nothing the document says changes —
--   invoices_freeze_issued explicitly permits metadata edits on an issued
--   invoice — but a client holding a version read a moment earlier will be
--   told to refresh once. That is the correct behaviour for an optimistic
--   lock and is cheaper than disabling a trigger to hide it.
--
-- Depends on
--   0010 (invoices, payments, invoices_touch, invoices_freeze_issued),
--   0022 (invoice_payments and the two composite unique keys its foreign keys
--   are checked against).
--
-- On this deployment
--   Provably a no-op: zero invoices and zero payments, so zero of everything
--   below. It is written for a deployment that has data.
-- ============================================================================

set search_path = public, extensions;


-- ── 1 · Backfill ────────────────────────────────────────────────────────────
-- One row per (invoice, payment) the array claims and the schema accepts.
--
-- The join carries organization_id and booking_id as predicates rather than
-- leaving them to the foreign keys. Both would refuse the row either way; as
-- predicates they turn a would-be constraint failure into a residue row, which
-- is what the next step is able to describe to a person.
--
-- jsonb_typeof guards the lateral: jsonb_array_elements_text raises on a
-- non-array, and a single malformed row must not decide whether every other
-- invoice gets migrated. Step 2 refuses those rows by name instead.

insert into public.invoice_payments (invoice_id, payment_id, organization_id, booking_id)
select i.id, p.id, i.organization_id, i.booking_id
from public.invoices i
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(i.metadata -> 'payment_ids') = 'array'
       then i.metadata -> 'payment_ids' else '[]'::jsonb end) as l(value)
join public.payments p on p.id::text = l.value
 and p.organization_id = i.organization_id and p.booking_id = i.booking_id
on conflict (invoice_id, payment_id) do nothing;


-- ── 2 · Proof, before anything is destroyed ─────────────────────────────────
-- Every id the array claimed, that has no row in the join table. If this finds
-- anything, the migration fails and the key survives with it.
--
-- Compared as text on both sides. Casting the array element to uuid would fail
-- with 22P02 on a value that is not one — and "the array holds something that
-- is not a payment id" is exactly one of the cases this is here to report, not
-- a reason to crash without saying which invoice.

do $$
declare
  malformed_count integer;
  malformed_ids   text;
  residue_count   integer;
  residue_sample  text;
  linked_count    integer;
  key_count       integer;
begin
  select count(*), left(coalesce(string_agg(i.id::text, ', '), ''), 400)
    into malformed_count, malformed_ids
    from public.invoices i
   where i.metadata ? 'payment_ids'
     and jsonb_typeof(i.metadata -> 'payment_ids') <> 'array';

  if malformed_count > 0 then
    raise exception
      'invoice payment backfill: % invoice(s) carry a metadata.payment_ids '
      'that is not an array and cannot be migrated: %. Nothing was dropped. '
      'A person has to decide what these hold before the key is removed.',
      malformed_count, malformed_ids
      using errcode = 'data_exception';
  end if;

  with claimed as (
    select i.id as invoice_id, l.value as payment_id
      from public.invoices i
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(i.metadata -> 'payment_ids') = 'array'
             then i.metadata -> 'payment_ids' else '[]'::jsonb end) as l(value)
  )
  select count(*), left(coalesce(string_agg(c.invoice_id::text || ' -> ' || c.payment_id, ', '), ''), 600)
    into residue_count, residue_sample
    from claimed c
   where not exists (
     select 1
       from public.invoice_payments ip
      where ip.invoice_id = c.invoice_id
        and ip.payment_id::text = c.payment_id
   );

  if residue_count > 0 then
    raise exception
      'invoice payment backfill: % claimed link(s) have no row in '
      'invoice_payments and would be lost: %. Each one is a payment that does '
      'not exist, belongs to another organization, or is against a different '
      'booking than the invoice. Nothing was dropped; these need a person.',
      residue_count, residue_sample
      using errcode = 'data_exception',
            hint = 'Reconcile each pair, then re-run this migration.';
  end if;

  select count(*) into linked_count from public.invoice_payments;
  select count(*) into key_count
    from public.invoices where metadata ? 'payment_ids';

  raise notice
    'invoice payment backfill: % link(s) in invoice_payments, 0 residue, '
    'dropping metadata.payment_ids from % invoice(s).',
    linked_count, key_count;
end $$;


-- ── 3 · The key goes ────────────────────────────────────────────────────────
-- `- 'payment_ids'` removes one key and leaves the rest of metadata alone. The
-- adapter that used to write this replaced the whole object on every update,
-- which is the other half of why the array had to go.

update public.invoices
   set metadata = metadata - 'payment_ids'
 where metadata ? 'payment_ids';
