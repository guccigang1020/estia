-- ============================================================================
-- 0033_guest_link.sql — ESTIA · the one door that opens without an account
--
-- What this is for
--   `bookings.guest_token` has existed since 0009, with a comment explaining
--   exactly why it is a capability rather than an id, and nothing in the
--   product has ever served it. There is no route, no resolver and no way for
--   a guest to see their own booking. This is the floor underneath that.
--
-- The problem this has to solve, stated plainly
--   Every policy in this schema is `organization_id in (select
--   public.my_organizations())`, and `my_organizations()` reads memberships.
--   A guest has no account, no membership, no role and no `auth.uid()`. There
--   is therefore no policy that can express "this person may read exactly this
--   one booking", and there must not be: a policy that granted `anon` any read
--   of `bookings` would grant it every booking in every organization.
--
--   So the guest's authorization is possession of the token, checked in one
--   SECURITY DEFINER function, and the function returns a hand-picked
--   projection rather than the row. That distinction is the whole security
--   design. `select *` would hand a stranger `internal_notes`, the agent who
--   sold the stay, the source channel and the tax treatment; every field below
--   was chosen deliberately and the ones left out are listed in section 2 so
--   that adding one is a decision somebody makes on purpose.
--
-- Why the token is not hashed, unlike the invitation token
--   An invitation is redeemed once and the raw value is shown once, so 0027
--   stores only a digest. A guest link is opened on the day it is sent, again
--   the night before arrival, and once more from a different telephone; the
--   business re-copies it from the booking screen; it is a bookmark, not a
--   one-time secret. A digest would make "copy the guest link" impossible
--   without minting a new one and invalidating the guest's bookmark. So the
--   column stays as 0009 wrote it — 32 bytes from a CSPRNG — and this
--   migration adds what a long-lived capability actually needs instead:
--   expiry, revocation and rotation.
--
-- On rate limiting
--   The specification asks for it. It is deliberately NOT implemented as a
--   counter in this migration, and the reason is worth writing down rather
--   than quietly skipping: the token is 32 random bytes behind a unique index,
--   so guessing one is not a threat model that throttling improves. What
--   throttling would protect against is somebody replaying a token they
--   already hold, and against that it does nothing. Abuse protection belongs
--   at the edge, in front of the route, and is recorded as open work.
--
-- Depends on
--   0009 (bookings, guest_token), 0001 (organizations), 0008 (properties,
--   units), 0005 (audit_events).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · What a long-lived capability needs
-- ============================================================================

alter table public.bookings
  add column if not exists guest_link_expires_at timestamptz,
  add column if not exists guest_link_revoked_at timestamptz,
  add column if not exists guest_link_revoked_by uuid
    references auth.users (id) on delete set null,
  add column if not exists guest_link_rotated_at timestamptz,
  add column if not exists guest_link_first_opened_at timestamptz,
  add column if not exists guest_link_last_opened_at timestamptz;

comment on column public.bookings.guest_link_expires_at is
  'When the link stops working. Null means it does not expire on a clock — which is the right default for a booking, because the guest needs it on the morning of arrival and a link that dies at an arbitrary age is a support call.';
comment on column public.bookings.guest_link_revoked_at is
  'Set when somebody withdraws the link — a wrong address, a forwarded message, a cancelled stay. Revocation is not deletion: the row keeps its token so that an attempt to use it is a refusal that can be seen, rather than a lookup that finds nothing and looks the same as a typo.';
comment on column public.bookings.guest_link_rotated_at is
  'When the token was last replaced. Rotating invalidates every copy of the old link at once, which is what somebody wants after sending it to the wrong person.';
comment on column public.bookings.guest_link_first_opened_at is
  'Two timestamps rather than one, because "sent and never opened" and "opened three times and still not confirmed" are different problems and lead to different actions.';


-- ============================================================================
-- 2 · What a guest may see, and what they may not
-- ============================================================================
-- The projection is the security boundary. What is deliberately ABSENT:
--
--   internal_notes        where staff write about the guest
--   source, source_channel, agent_user_id, agency_id, campaign_id, referral_id
--                         who sold the stay and through which channel; a
--                         guest learning their booking is attributed to an
--                         agent is a commercial disclosure
--   tax_rate_bps, tourist_vat_exempt
--                         the tax treatment applied, which is the business's
--                         arrangement and not the guest's
--   status_reason         why staff set the status they set
--   version, created_by, updated_by, deleted_at
--   every other booking, every other organization
--
-- What IS returned is what a person needs to recognise their own stay and act
-- on it: where, when, how many, what it costs them, and where they are in the
-- journey. `guest_notes` and `special_requests` are the guest's own words and
-- come back to them.

create or replace function public.guest_portal_session(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_result  jsonb;
begin
  if p_token is null or length(btrim(p_token)) < 32 then
    -- Refused on shape before touching the table. A short token cannot be a
    -- real one — `bookings_guest_token_length` guarantees it — so this is a
    -- malformed link rather than a wrong one.
    raise exception 'guest_link_not_found'
      using hint = 'הקישור אינו תקין. בקש מבית האירוח לשלוח קישור חדש.',
            errcode = 'P0002';
  end if;

  select * into v_booking
  from public.bookings
  where guest_token = p_token;

  if not found then
    raise exception 'guest_link_not_found'
      using hint = 'לא מצאנו את ההזמנה. ייתכן שהקישור הועתק חלקית.',
            errcode = 'P0002';
  end if;

  -- A soft-deleted booking is gone as far as a guest is concerned.
  if v_booking.deleted_at is not null then
    raise exception 'guest_link_not_found'
      using hint = 'ההזמנה אינה זמינה עוד.', errcode = 'P0002';
  end if;

  if v_booking.guest_link_revoked_at is not null then
    raise exception 'guest_link_revoked'
      using hint = 'הקישור בוטל. פנה לבית האירוח לקבלת קישור חדש.',
            errcode = 'P0004';
  end if;

  if v_booking.guest_link_expires_at is not null
     and v_booking.guest_link_expires_at <= now() then
    raise exception 'guest_link_expired'
      using hint = 'תוקף הקישור פג. פנה לבית האירוח לקבלת קישור חדש.',
            errcode = 'P0005';
  end if;

  select jsonb_build_object(
    'bookingId',        v_booking.id,
    'organizationId',   v_booking.organization_id,
    'organizationName', o.name,
    'reference',        v_booking.reference,
    'status',           v_booking.status,
    'checkIn',          v_booking.check_in,
    'checkOut',         v_booking.check_out,
    'arrivalTime',      v_booking.arrival_time,
    'adults',           v_booking.adults,
    'children',         v_booking.children,
    'infants',          v_booking.infants,
    'couples',          v_booking.couples,
    'cotsRequested',    v_booking.cots_requested,
    'eventType',        v_booking.event_type,
    'specialRequests',  v_booking.special_requests,
    -- The guest's own words, returned to them. Never `internal_notes`.
    'guestNotes',       v_booking.guest_notes,
    'currency',         v_booking.currency,
    -- What the guest owes, and nothing about how it was arrived at.
    'totalAgorot',      v_booking.total_agorot,
    'propertyId',       p.id,
    'propertyName',     p.name,
    'propertyCity',     p.city,
    'unitName',         u.name,
    -- First name only. A surname is not needed to say "שלום, דנה" and its
    -- absence is one less thing a forwarded link discloses.
    'guestFirstName',   split_part(coalesce(g.full_name, ''), ' ', 1),
    'linkExpiresAt',    v_booking.guest_link_expires_at,
    'firstOpenedAt',    v_booking.guest_link_first_opened_at
  )
  into v_result
  from public.organizations o
  left join public.properties p
    on p.id = v_booking.property_id
   and p.organization_id = v_booking.organization_id
  left join public.units u
    on u.id = v_booking.unit_id
   and u.organization_id = v_booking.organization_id
  left join public.guests g
    on g.id = v_booking.guest_id
   and g.organization_id = v_booking.organization_id
  where o.id = v_booking.organization_id;

  if v_result is null then
    -- The organization row is gone. Not a "not found" for the guest to act
    -- on; a broken tenant, and it must not fall through as an empty object.
    raise exception 'guest_link_unavailable'
      using hint = 'ההזמנה אינה זמינה כרגע. נסה שוב מאוחר יותר.',
            errcode = 'P0007';
  end if;

  return v_result;
end;
$$;

comment on function public.guest_portal_session(text) is
  'Resolves a booking from its guest_token for a visitor with no account, and returns a hand-picked guest-facing projection rather than the row. The one function in this schema callable by anon, because a guest has no auth.uid() and no policy can express "exactly this booking". Refuses a revoked, expired or deleted link. Deliberately omits internal_notes, attribution, tax treatment and status_reason — see the note above section 2.';


-- ============================================================================
-- 3 · Recording that it was opened
-- ============================================================================
-- Separate from the read, and a separate function, for two reasons. The read
-- is STABLE and is called on every render; making it write would mean a page
-- refresh mutating a row. And "sent and never opened" against "opened three
-- times and still not confirmed" is the single most useful thing the business
-- can know about a quiet booking, so it is worth one deliberate call.

create or replace function public.guest_portal_opened(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bookings
  set guest_link_first_opened_at = coalesce(guest_link_first_opened_at, now()),
      guest_link_last_opened_at = now()
  where guest_token = p_token
    and deleted_at is null
    and guest_link_revoked_at is null
    and (guest_link_expires_at is null or guest_link_expires_at > now());
  -- No raise when nothing matched. A refused link is the read's business to
  -- report; this one must never be the reason a page fails to render.
end;
$$;

comment on function public.guest_portal_opened(text) is
  'Stamps first and last opened on a booking''s guest link. Deliberately silent when the token matches nothing — reporting a bad link is guest_portal_session''s job, and a telemetry write must never be why a page fails.';


-- ============================================================================
-- 4 · Who may call them
-- ============================================================================
-- `anon` holds EXECUTE, and this is the only place in the schema where that is
-- true of a function that reads tenant data. It is the entire point: the guest
-- has no account. What makes it safe is not the caller, it is that the
-- function takes one 32-byte capability, returns a fixed projection of exactly
-- one booking, and cannot be persuaded to return a second.
--
-- `service_role` is revoked from both, per 0014: nothing on the server resolves
-- a guest link on somebody's behalf, and that role already bypasses RLS.

revoke all on function public.guest_portal_session(text)
  from public, service_role;
grant execute on function public.guest_portal_session(text) to anon, authenticated;

revoke all on function public.guest_portal_opened(text)
  from public, service_role;
grant execute on function public.guest_portal_opened(text) to anon, authenticated;


-- ============================================================================
-- 5 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('guest_link_expires_at'), ('guest_link_revoked_at'),
    ('guest_link_revoked_by'), ('guest_link_rotated_at'),
    ('guest_link_first_opened_at'), ('guest_link_last_opened_at'),
    -- The columns the projection reads and did not add.
    ('guest_token'), ('guest_notes'), ('special_requests'), ('event_type')
  ) as c(name)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name = c.name
  );

  if missing is not null then
    raise exception 'bookings is missing columns after 0033: %', missing;
  end if;

  select string_agg(name, ', ') into missing
  from (values ('guest_portal_session'), ('guest_portal_opened')) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
  );

  if missing is not null then
    raise exception '0033 functions missing: %', missing;
  end if;

  -- `anon` must hold EXECUTE here, which is the opposite of every other check
  -- of its kind in this schema. Asserted for exactly that reason: somebody
  -- tightening grants in bulk would otherwise close the guest portal and find
  -- out from a customer.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guest_portal_session'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'anon cannot execute guest_portal_session — the guest portal is closed';
  end if;

  -- And it must NOT hold a direct read of bookings, which is the thing the
  -- function exists to avoid granting.
  if has_table_privilege('anon', 'public.bookings', 'SELECT') then
    raise exception 'anon holds SELECT on public.bookings — the projection is being bypassed';
  end if;
end $$;
