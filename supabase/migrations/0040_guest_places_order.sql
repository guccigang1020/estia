-- ============================================================================
-- 0040_guest_places_order.sql — ESTIA · the guest could read the shop and not
--                               buy from it
--
-- What this closes
--   `/g/<token>/store` renders the catalogue, ranks it against the booking,
--   refuses what cannot be fulfilled and prices every card. And the checkout
--   button was disabled, with a sentence on screen saying so, because
--   `GuestOrderWriter` was an interface with no implementation anywhere.
--
--   A guest could be shown a שולחן שוק at ₪1,500 and had no way to ask for it.
--   Staff could place the same order from the desk — same operation, same
--   snapshot, same rules — so the gap was exactly one write path wide.
--
-- Why a SECURITY DEFINER function and not a Server Action
--   The same reason 0027 gives for `accept_invitation` and 0033 for
--   `guest_portal_session`: possession of a secret rather than a grant is what
--   authorizes this write, and that decision belongs in the schema beside
--   every other policy rather than in application code. A guest has no
--   membership, so `store_orders_insert` — which demands
--   `has_permission(organization_id, 'order.manage')` — can never admit them,
--   and it must not be widened to try.
--
-- THE ATTACK THIS EXISTS TO REFUSE
--   A guest posting their own prices. The payload names items, quantities and
--   option values; it does NOT carry money, and this function does not read a
--   price from it. Every figure is looked up from the catalogue at the moment
--   of writing. That is a lookup and not a second pricing engine — how the
--   parts compose stays in `snapshot.ts`, where there is exactly one of it,
--   and what the parts ARE is read from the rows that own them.
--
--   The consequence is worth stating plainly: there is no argument to this
--   function that can change what an order costs.
--
-- On the token, again
--   It takes the token first and takes no booking id, no organization id and
--   no property id. Everything about WHERE the order lands is resolved from
--   the token's own booking through `public.guest_link_booking`, so there is
--   no parameter a guest could point at somebody else's stay. That is the
--   shape 0034 established and the reason its IDOR proof holds.
--
-- Idempotency
--   `submission_key` is minted when the cart's checkout form opens, not when
--   it is submitted — see `idempotency.ts`. A double-tap carries the same key
--   and returns the same order; a genuine second order an hour later carries a
--   new one. The uniqueness is a partial index rather than application logic,
--   because two taps half a second apart is a race and only the database can
--   settle it.
--
-- Depends on
--   0032 (the store schema, tg_store_order_totals, the generated line total),
--   0033 (guest_link_booking), 0034 (the guest portal's shape).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · One order per submission
-- ============================================================================
-- Partial, because `submission_key` is null for every order the desk places
-- and a unique index over nulls would be a different constraint than the one
-- meant. Scoped by organization for the same reason every other key here is.

alter table public.store_orders
  add column if not exists submission_key text;

comment on column public.store_orders.submission_key is
  'The guest cart submission this order came from, or null for an order placed by staff. Minted when the checkout form opens rather than when it is submitted, so a double-tap dedupes and a genuine second order does not.';

create unique index if not exists store_orders_submission_key_idx
  on public.store_orders (organization_id, submission_key)
  where submission_key is not null;


-- ============================================================================
-- 2 · Placing it
-- ============================================================================

create or replace function public.guest_portal_place_order(
  p_token text,
  p_lines jsonb,
  p_requested_for date default null,
  p_notes text default null,
  p_submission_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking     public.bookings%rowtype;
  v_settings    public.store_settings%rowtype;
  v_order_id    uuid;
  v_reference   text;
  v_existing    public.store_orders%rowtype;
  v_line        jsonb;
  v_item        public.store_items%rowtype;
  v_override    public.store_item_property_overrides%rowtype;
  v_unit_price  integer;
  v_options     integer;
  v_value       public.store_item_option_values%rowtype;
  v_value_id    uuid;
  v_quantity    integer;
  v_sort        integer := 0;
  v_line_id     uuid;
begin
  -- Resolves the booking from the token and nothing else. Raises its own
  -- refusals for a bad, revoked or expired link.
  v_booking := public.guest_link_booking(p_token);

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'store_order_empty'
      using hint = 'העגלה ריקה. הוסף פריט לפני השליחה.', errcode = 'P0010';
  end if;

  -- Replay before anything is written. A second tap must return the first
  -- order rather than a refusal: the guest did nothing wrong and their order
  -- exists.
  if p_submission_key is not null then
    select * into v_existing
    from public.store_orders
    where organization_id = v_booking.organization_id
      and submission_key = p_submission_key;

    if found then
      return jsonb_build_object(
        'id', v_existing.id,
        'reference', v_existing.reference,
        'replay', true
      );
    end if;
  end if;

  select * into v_settings
  from public.store_settings
  where organization_id = v_booking.organization_id;

  if not found or v_settings.mode = 'off'::public.store_mode then
    raise exception 'store_disabled'
      using hint = 'החנות אינה פעילה בבית האירוח הזה.', errcode = 'P0011';
  end if;

  -- `S-260905-A1B2`. The prefix is the organization's own; the random tail is
  -- what stops two orders a second apart from colliding.
  v_reference :=
    v_settings.order_reference_prefix || '-' ||
    to_char(now(), 'YYMMDD') || '-' ||
    upper(substr(encode(extensions.gen_random_bytes(3), 'hex'), 1, 4));

  -- No money on the insert. `tg_store_order_totals` owns all four columns and
  -- computes them from the lines below.
  insert into public.store_orders (
    organization_id, property_id, booking_id, guest_id,
    reference, source, status, payment_status, payment_mode,
    currency, requested_for_date, guest_notes, submission_key
  )
  values (
    v_booking.organization_id, v_booking.property_id, v_booking.id,
    v_booking.guest_id,
    v_reference,
    'guest_portal'::public.store_order_source,
    -- Every guest order waits for a human. The organization's approval
    -- setting can only make this stricter, never automatic, because an order
    -- that confirms itself is an order nobody read.
    'awaiting_approval'::public.store_order_status,
    'unpaid'::public.store_payment_status,
    v_settings.default_payment_mode,
    coalesce(v_booking.currency, 'ILS'),
    p_requested_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_submission_key
  )
  returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_sort := v_sort + 1;

    select * into v_item
    from public.store_items
    where id = (v_line ->> 'itemId')::uuid
      and organization_id = v_booking.organization_id
      and status = 'active'::public.store_item_status
      and deleted_at is null;

    if not found then
      raise exception 'store_item_unavailable'
        using hint = 'אחד הפריטים בעגלה אינו זמין יותר. רענן את הדף ונסה שוב.',
              errcode = 'P0012';
    end if;

    if v_item.pricing_model = 'quote'::public.store_pricing_model then
      raise exception 'store_item_requires_quote'
        using hint = 'הפריט הזה נמכר לפי הצעת מחיר. פנה לבית האירוח.',
              errcode = 'P0013';
    end if;

    -- THE PRICE, read and never received. A property override wins over the
    -- catalogue, which is the same order `snapshot.ts` applies on the way in.
    v_unit_price := v_item.base_price_agorot;

    select * into v_override
    from public.store_item_property_overrides
    where item_id = v_item.id
      and property_id = v_booking.property_id
      and organization_id = v_booking.organization_id;

    if found and v_override.base_price_agorot is not null then
      v_unit_price := v_override.base_price_agorot;
    end if;

    v_quantity := greatest(1, coalesce((v_line ->> 'quantity')::integer, 1));
    v_options := 0;

    insert into public.store_order_lines (
      organization_id, order_id, item_id,
      item_name_snapshot, item_type_snapshot, pricing_model_snapshot,
      unit_price_agorot, options_agorot, quantity,
      customization_answers,
      fulfilment_kind_snapshot, fulfilment_recipe_snapshot,
      lead_time_hours_snapshot, cancellation_policy_snapshot,
      provider_id, sort_order
    )
    values (
      v_booking.organization_id, v_order_id, v_item.id,
      v_item.name, v_item.item_type, v_item.pricing_model,
      v_unit_price, 0, v_quantity,
      coalesce(v_line -> 'answers', '{}'::jsonb),
      v_item.fulfilment_kind, coalesce(v_item.fulfilment_recipe, '{}'::jsonb),
      coalesce(v_item.lead_time_hours, 0),
      coalesce(v_item.cancellation_policy, '{}'::jsonb),
      v_item.provider_id, v_sort
    )
    returning id into v_line_id;

    -- Each chosen option, priced from its own row. A value belonging to a
    -- different item is refused rather than ignored: silently dropping it
    -- would charge the guest for a configuration they did not choose.
    for v_value_id in
      select (value #>> '{}')::uuid
      from jsonb_array_elements(coalesce(v_line -> 'optionValueIds', '[]'::jsonb))
    loop
      select v.* into v_value
      from public.store_item_option_values v
      join public.store_item_options o on o.id = v.option_id
      where v.id = v_value_id
        and v.organization_id = v_booking.organization_id
        and v.is_available
        and o.item_id = v_item.id;

      if not found then
        raise exception 'store_option_unavailable'
          using hint = 'אחת מהאפשרויות שנבחרו אינה זמינה. רענן את הדף ונסה שוב.',
                errcode = 'P0014';
      end if;

      insert into public.store_order_line_options (
        organization_id, order_line_id, option_id, option_value_id,
        option_name_snapshot, value_label_snapshot, price_delta_agorot
      )
      select
        v_booking.organization_id, v_line_id, o.id, v_value.id,
        o.name, v_value.label, v_value.price_delta_agorot
      from public.store_item_options o
      where o.id = v_value.option_id;

      v_options := v_options + v_value.price_delta_agorot;
    end loop;

    -- Written once, after the options are known. `line_total_agorot` is
    -- GENERATED ALWAYS, so this update moves the total without anybody being
    -- able to state it.
    if v_options <> 0 then
      update public.store_order_lines
      set options_agorot = v_options
      where id = v_line_id;
    end if;
  end loop;

  select * into v_existing from public.store_orders where id = v_order_id;

  return jsonb_build_object(
    'id', v_existing.id,
    'reference', v_existing.reference,
    'totalAgorot', v_existing.total_agorot,
    'replay', false
  );
end;
$$;

comment on function public.guest_portal_place_order(text, jsonb, date, text, text) is
  'Places a store order for the booking a guest link addresses. Takes the token first and no booking, organization or property id, so no parameter can point at another stay. Carries no money: every price is looked up from the catalogue and the property override at write time, so no argument can change what an order costs. Idempotent on submission_key. Always lands awaiting_approval — a guest order that confirmed itself is one nobody read.';


-- ============================================================================
-- 3 · Who may call it
-- ============================================================================
-- `anon`, because a guest holding a link is not signed in. That is the whole
-- point of the function and the reason it takes a 64-character secret rather
-- than an id. 0014's rule otherwise: nothing else keeps a grant it does not
-- need, and `service_role` never places an order on somebody's behalf.

revoke all on function
  public.guest_portal_place_order(text, jsonb, date, text, text)
  from public, service_role;

grant execute on function
  public.guest_portal_place_order(text, jsonb, date, text, text)
  to anon, authenticated;


-- ============================================================================
-- 4 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'store_orders'
      and column_name = 'submission_key'
  ) then
    raise exception '0040 did not add store_orders.submission_key';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'store_orders_submission_key_idx'
  ) then
    raise exception '0040 did not create the submission key index';
  end if;

  -- The function must exist and `anon` must hold EXECUTE, because a guest is
  -- not signed in. This is the one place in this file where a missing grant
  -- would look exactly like a working feature until a real guest tried it.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guest_portal_place_order'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'anon cannot execute guest_portal_place_order';
  end if;

  -- And `service_role` must not. Nothing on the server places a guest's order.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guest_portal_place_order'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'service_role still holds EXECUTE on guest_portal_place_order';
  end if;

  -- The generated line total, which is what makes a price unfakeable. If this
  -- ever became an ordinary column, a writer could state a total that is not
  -- its parts and this function's whole guarantee would be prose.
  select string_agg(column_name, ', ') into missing
  from information_schema.columns
  where table_schema = 'public' and table_name = 'store_order_lines'
    and column_name = 'line_total_agorot'
    and is_generated <> 'ALWAYS';

  if missing is not null then
    raise exception 'store_order_lines.line_total_agorot is no longer generated';
  end if;
end $$;
