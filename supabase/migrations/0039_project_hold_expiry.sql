-- ============================================================================
-- 0039_project_hold_expiry.sql — ESTIA · the hold expiry existed but nothing
--                                could read it
--
-- The defect
--   0038 §2 added `bookings.option_expires_at` so a held booking can carry a
--   real expiry, and the portal can count down to it. The column was added,
--   indexed and commented, and the work was reported as done.
--
--   It was half a fix. `public.guest_portal_journey` from 0034 §9 is the only
--   thing the guest portal reads — one round trip, every field gated in SQL —
--   and it does not project the new column. So `guestHoldState()` in
--   `src/lib/guest-journey/stay.ts` reads `expiresAt` as null, returns
--   'undated', and the countdown can never run for anybody.
--
--   The column exists and nothing can reach it. A migration that adds storage
--   without adding the projection that reads it has shipped nothing a guest
--   can see.
--
-- What this does
--   `create or replace` with the identical signature and the identical body,
--   plus exactly one field — `holdExpiresAt` in the `current` object, beside
--   the status and the dates it belongs with. The signature is repeated
--   character for character; a mismatch would not fail, it would create a
--   second overload and leave the old body still being called, which is the
--   quiet way to ship a fix that does nothing. The rehearsal at the foot
--   asserts against that specifically.
--
-- Why NOT the confirmation snapshot
--   `guest_portal_confirm` builds a second object into `v_snapshot`, and it is
--   deliberately left alone. That snapshot is the set of terms the guest
--   agreed to, and it feeds the reconfirmation comparison. A hold expiry is
--   not a term anybody confirms — it is a clock. Putting it in the snapshot
--   would make an expiring hold read as a change to the terms and could trip
--   reconfirmation on a booking where nothing about the booking had changed.
--
-- On the body below
--   Copied verbatim from 0034 §9. Before writing it, the live body was
--   compared against the repo: stripped of comments and normalised for
--   whitespace, the two are identical (md5 0c22e4a8ad1994bb637832c5f17735bc,
--   6320 characters, both sides), but the live body is 16 lines and 1192
--   characters shorter — it is one of the five functions whose comments were
--   compressed while being pasted, as the worker who applied 0034 disclosed.
--   Replacing it with the file's text changes no logic and closes that
--   divergence for this one function rather than adding a second.
--
--   The `comment on function` from 0034 is not re-issued. `create or replace`
--   preserves it and it is still accurate.
--
-- Depends on
--   0034 (guest_portal_journey and the journey tables), 0038 §2
--   (bookings.option_expires_at), 0033 (the portal session this feeds).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The projection learns the expiry
-- ============================================================================

create or replace function public.guest_portal_journey(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_booking     public.bookings%rowtype;
  v_settings    public.guest_journey_settings%rowtype;
  v_journey     public.booking_guest_journey%rowtype;
  v_content     public.guest_journey_content%rowtype;
  v_property    public.properties%rowtype;
  v_confirm     public.booking_guest_confirmations%rowtype;
  v_signature   public.booking_contract_signatures%rowtype;
  v_details     public.booking_guest_details%rowtype;
  v_template    public.guest_contract_templates%rowtype;
  v_check_in_at timestamptz;
  v_released    boolean;
  v_in_stay     boolean;
  v_confirmed   boolean;
  v_signed      boolean;
  v_requests    jsonb;
begin
  -- Re-resolved here. This function does not trust that a layout, a page or a
  -- caller checked; there is no code path into the projection that skips it.
  v_booking := public.guest_link_booking(p_token);

  v_settings := public.guest_journey_effective_settings(
    v_booking.organization_id, v_booking.property_id);

  select * into v_journey from public.booking_guest_journey
  where booking_id = v_booking.id;
  -- Absent is not an error: a booking acquires a journey row the first time
  -- anything is stamped on it, and until then every field is null, which is
  -- exactly what an unstarted journey means.
  if not found then
    v_journey.booking_id := v_booking.id;
    v_journey.organization_id := v_booking.organization_id;
  end if;

  select * into v_property from public.properties
  where id = v_booking.property_id
    and organization_id = v_booking.organization_id;

  select * into v_content from public.guest_journey_content
  where organization_id = v_booking.organization_id
    and property_id = v_booking.property_id;

  select * into v_confirm from public.booking_guest_confirmations
  where booking_id = v_booking.id and superseded_at is null
  order by confirmed_at desc limit 1;
  v_confirmed := v_confirm.id is not null;

  select * into v_signature from public.booking_contract_signatures
  where booking_id = v_booking.id and superseded_at is null
  limit 1;
  v_signed := v_signature.id is not null;

  select * into v_details from public.booking_guest_details
  where booking_id = v_booking.id;

  if v_settings.contract_mode <> 'disabled' and not v_signed then
    select * into v_template from public.guest_contract_templates
    where organization_id = v_booking.organization_id
      and is_active
      and (property_id = v_booking.property_id or property_id is null)
    order by (property_id is not null) desc
    limit 1;
  end if;

  v_check_in_at := (v_booking.check_in
      + coalesce(v_booking.arrival_time, v_property.default_check_in_time,
                 '15:00'::time))
    at time zone coalesce(v_property.timezone, 'Asia/Jerusalem');

  v_released := public.guest_arrival_released(
    v_booking, v_settings, v_journey, v_confirmed, v_signed, v_check_in_at);

  -- During-stay content opens when the stay does, by the calendar or by the
  -- status, whichever comes first — an early check-in is ordinary, and a guest
  -- sitting on the sofa should not be told the wifi is not available yet.
  v_in_stay := v_booking.status in ('checked_in', 'in_house', 'checkout_pending')
    or (current_date >= v_booking.check_in
        and current_date < v_booking.check_out);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',          r.id,
    'category',    r.category,
    'body',        r.body,
    'state',       r.state,
    'createdAt',   r.created_at,
    'completedAt', r.completed_at
  ) order by r.created_at desc), '[]'::jsonb)
  into v_requests
  from public.guest_requests r
  where r.booking_id = v_booking.id;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'contractMode',              v_settings.contract_mode,
      'requireGuestConfirmation',  v_settings.require_guest_confirmation,
      'requiredDetailFields',      to_jsonb(v_settings.required_detail_fields),
      'optionalDetailFields',      to_jsonb(v_settings.optional_detail_fields),
      'arrivalRelease',            v_settings.arrival_release,
      'arrivalReleaseHours',       v_settings.arrival_release_hours,
      'duringStayTopics',          to_jsonb(v_settings.during_stay_topics),
      'requestsEnabled',           v_settings.requests_enabled,
      'requestCategories',         to_jsonb(v_settings.request_categories),
      'checkoutDeclarationEnabled', v_settings.checkout_declaration_enabled,
      'reviewEnabled',             v_settings.review_enabled,
      'reviewUrl',                 v_settings.review_url,
      'rebookEnabled',             v_settings.rebook_enabled,
      'reconfirmationTriggers',    to_jsonb(v_settings.reconfirmation_triggers)
    ),

    -- The live terms, for the delta. Every one of these is already in 0033's
    -- projection; none of them is a new disclosure.
    'current', jsonb_build_object(
      'bookingVersion',    v_booking.version,
      'status',            v_booking.status,
      'checkIn',           v_booking.check_in,
      'checkOut',          v_booking.check_out,
      'adults',            v_booking.adults,
      'children',          v_booking.children,
      'infants',           v_booking.infants,
      'totalAgorot',       v_booking.total_agorot,
      'currency',          v_booking.currency,
      'cancellationTerms', v_property.cancellation_policy_text,
      'inStay',            v_in_stay,
      'holdExpiresAt',     v_booking.option_expires_at
    ),

    'confirmation', case when v_confirmed then jsonb_build_object(
      'confirmedAt',    v_confirm.confirmed_at,
      'bookingVersion', v_confirm.booking_version,
      'snapshot',       v_confirm.snapshot
    ) else null end,

    'contract', jsonb_build_object(
      'mode', v_settings.contract_mode,
      -- The template is offered only while there is something to sign. After
      -- signing, the frozen text is the only contract that exists here.
      'template', case
        when v_settings.contract_mode <> 'disabled' and not v_signed
             and v_template.id is not null
        then jsonb_build_object('title', v_template.title,
                                'body',  v_template.body)
        else null end,
      'signature', case when v_signed then jsonb_build_object(
        'signedAt',       v_signature.signed_at,
        'signerName',     v_signature.signer_name,
        'title',          v_signature.contract_title,
        'body',           v_signature.contract_body,
        'bookingVersion', v_signature.booking_version
      ) else null end
    ),

    'details', jsonb_build_object(
      'submittedAt', v_details.submitted_at,
      'fields',      coalesce(v_details.fields, '{}'::jsonb)
    ),

    -- Every field below is SQL NULL until the policy allows it. Not a value
    -- with a flag beside it — see §3.
    'arrival', jsonb_build_object(
      'released',           v_released,
      'checkInTime',        coalesce(v_booking.arrival_time,
                                     v_property.default_check_in_time),
      'addressNote',        case when v_released then v_content.address_note end,
      'addressLine1',       case when v_released then v_property.address_line1 end,
      'addressLine2',       case when v_released then v_property.address_line2 end,
      -- The city is not gated. It is on the booking confirmation the guest
      -- already has and in the property's public listing; withholding it would
      -- be theatre rather than protection.
      'city',               v_property.city,
      'directions',         case when v_released then v_content.directions end,
      'mapUrl',             case when v_released then v_content.map_url end,
      'parking',            case when v_released then v_content.parking end,
      'accessInstructions', case when v_released
                                 then v_content.access_instructions end,
      'accessCode',         case when v_released
                                 then coalesce(v_journey.access_code,
                                               v_content.access_code) end
    ),

    'stay', jsonb_build_object(
      'inStay',           v_in_stay,
      'wifiNetwork',      case when v_in_stay then v_content.wifi_network end,
      'wifiPassword',     case when v_in_stay then v_content.wifi_password end,
      'propertyGuide',    case when v_in_stay then v_content.property_guide end,
      'houseRules',       v_property.house_rules,
      'emergencyContact', case when v_in_stay
                               then v_content.emergency_contact end
    ),

    'requests', v_requests,

    'checkout', jsonb_build_object(
      'checkOutTime', v_property.default_check_out_time,
      'instructions', case when v_in_stay
                            or v_booking.status in ('checkout_pending',
                                                    'checked_out')
                           then v_content.checkout_instructions end,
      'declaredAt',   v_journey.checkout_declared_at,
      'enabled',      v_settings.checkout_declaration_enabled
    )
  );
end;
$$;


-- ============================================================================
-- 2 · Rehearsal
-- ============================================================================
-- Asserts the behaviour, not the text of this file. The first check is the one
-- that matters: `create or replace` with a signature that does not match makes
-- a second overload instead of failing, and the old body stays reachable. A
-- migration that "succeeded" while every caller still ran the old function is
-- the failure mode this is here to catch, so the count is checked before the
-- content is.

do $$
declare
  v_oid   oid;
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'guest_portal_journey';

  if v_count <> 1 then
    raise exception
      'expected exactly one public.guest_portal_journey, found % — the replace '
      'created an overload and the old body is still reachable', v_count;
  end if;

  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'guest_portal_journey';

  if pg_get_functiondef(v_oid) not like '%holdExpiresAt%' then
    raise exception
      'guest_portal_journey does not project holdExpiresAt; the countdown '
      'still cannot run';
  end if;

  -- The security posture 0034 declared, unchanged. The portal is unauthenticated
  -- and reaches this function as `anon`; losing that grant would take the whole
  -- guest journey offline, and losing `security definer` or the empty
  -- search_path would take the gating with it.
  if not exists (
    select 1 from pg_proc p
    where p.oid = v_oid
      and p.prosecdef
      and p.proconfig @> array['search_path=""']
      and p.provolatile = 's'
  ) then
    raise exception
      'guest_portal_journey lost security definer, the empty search_path or '
      'its stable volatility';
  end if;

  if not has_function_privilege('anon', v_oid, 'execute') then
    raise exception 'anon can no longer execute guest_portal_journey';
  end if;

  if not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'authenticated can no longer execute guest_portal_journey';
  end if;
end $$;
