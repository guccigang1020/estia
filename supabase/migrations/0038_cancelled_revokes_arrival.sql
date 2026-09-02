-- ============================================================================
-- 0038_cancelled_revokes_arrival.sql — ESTIA · a cancelled booking was still
--                                      handing out the door code
--
-- The defect
--   `guest_arrival_released` in 0034 decides whether a guest may see the
--   address, the directions, the parking notes and the access code. It tests
--   the release policy and two overrides, and it tests the booking's status
--   only to *widen* disclosure — a guest already checked in is past the
--   argument.
--
--   It never tests for the statuses that should *close* it. So with the
--   shipped default `after_confirmation`, this sequence ends badly:
--
--     guest confirms          → p_confirmed = true
--     business cancels        → status = 'cancelled'
--     guest opens their link  → address, directions, parking, door code
--
--   `p_confirmed` is a fact about the past and stays true forever. Nothing
--   downstream re-closes the gate. The same holds for `manual` release: an
--   operator who released arrival details on Monday cannot un-release them by
--   cancelling on Tuesday.
--
--   Found by a worker building the during-stay screens, who noticed that
--   `redactCancelledJourney` strips these fields in TypeScript and asked the
--   obvious question — why does the layer below hand them over at all. The
--   TypeScript redaction is good defence in depth. It is not the fix, because
--   the whole design of 0034 is that gating happens in SQL precisely so that
--   deleting an `if` in a page yields empty rows rather than somebody's door
--   code. A page is not the last line of defence here; this function is.
--
-- Why the guard goes first, above the overrides
--   Both overrides in the original are unconditional `or` clauses, so a
--   guard added below them would be reached only when they were false. A
--   manually-released booking that is later cancelled is exactly the case that
--   matters — somebody deliberately opened the gate, and cancelling must close
--   it again. So the refusal is evaluated before anything else and short
--   circuits the whole expression.
--
-- What this does NOT do
--   It does not revoke the link. A cancelled booking's guest must still be
--   able to open their portal — to see that it was cancelled, what the refund
--   position is, and who to ring. Revoking the token would replace a clear
--   explanation with "this link is not valid", which is worse for the guest
--   and worse for the business. What is withheld is the operational secret,
--   not the page.
--
-- Depends on
--   0009 (booking_status), 0034 (guest_arrival_released and the journey
--   tables), 0033 (the portal session this feeds).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Cancellation closes the gate
-- ============================================================================
-- `create or replace` with the identical signature, so every caller — the
-- projection in 0034 §9 and anything added later — picks up the new body with
-- no other change. The signature is repeated exactly; a mismatch would create
-- a second overload and leave the old one still being called, which is the
-- quiet way to ship a fix that does nothing.

create or replace function public.guest_arrival_released(
  p_booking public.bookings,
  p_settings public.guest_journey_settings,
  p_journey public.booking_guest_journey,
  p_confirmed boolean,
  p_signed boolean,
  p_check_in_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- First, and above the overrides below. A stay that is not happening
    -- discloses nothing operational, however it was released and whoever
    -- released it. `p_confirmed` is a fact about the past and stays true after
    -- a cancellation; without this line it keeps the gate open forever.
    when p_booking.status in ('cancelled', 'no_show') then false

    else
      case p_settings.arrival_release
        when 'immediate'          then true
        when 'after_confirmation' then p_confirmed
        when 'after_contract'     then p_signed
        when 'after_deposit'      then p_journey.deposit_settled_at is not null
        when 'after_full_payment' then p_journey.payment_settled_at is not null
        when 'hours_before'       then
          now() >= p_check_in_at
            - make_interval(hours => p_settings.arrival_release_hours)
        when 'manual'             then p_journey.manual_released_at is not null
        else false
      end
      -- The override, on every branch. Without it a business that chose
      -- `after_deposit` before the payment module exists could never show an
      -- address at all, and the workaround would be to change the policy —
      -- which would then be wrong for every other booking.
      or p_journey.manual_released_at is not null
      -- A guest standing in the doorway is past the argument. Withholding the
      -- door code from somebody the business has already checked in is not a
      -- policy, it is a support call at eleven at night.
      or p_booking.status in ('checked_in', 'in_house', 'checkout_pending',
                              'checked_out', 'inspection', 'deposit_release',
                              'completed', 'review_requested')
  end;
$$;

comment on function public.guest_arrival_released(public.bookings, public.guest_journey_settings, public.booking_guest_journey, boolean, boolean, timestamptz) is
  'Whether the address, directions and access code may be disclosed. Its own function because it is the security decision in this migration, and one buried inside a two-hundred-line projection is one nobody reviews. A cancelled or no-show booking discloses nothing, checked first so that it overrides both widening clauses below it — including an operator''s manual release, which cancelling must be able to undo. Two unconditional overrides otherwise: the manual release, and a guest the business has already checked in, because withholding a door code from somebody standing at the door is not a policy.';


-- ============================================================================
-- 2 · A hold that can expire
-- ============================================================================
-- The guest portal can render a held booking with a countdown — the domain
-- already has `hold.created`, `hold.extended`, `hold.released` and
-- `hold.expired` in the frozen event catalogue, and `guestHoldView` in
-- `src/lib/guest-journey` already handles an expiry. It has never had one to
-- read, so every held booking renders as undated with no countdown.
--
-- That is the honest rendering of a missing column and it is the right
-- behaviour to have shipped, but it means the whole hold experience is
-- unreachable. One column makes it live.
--
-- Nullable, and null means "no expiry", not "expired". A booking whose dates
-- are held indefinitely is a real arrangement — the business rang the guest
-- and said the week is theirs — and a null read as "already gone" would show a
-- guest that their dates had lapsed when they had not.

alter table public.bookings
  add column if not exists option_expires_at timestamptz;

comment on column public.bookings.option_expires_at is
  'When a hold on these dates lapses. Null means no expiry rather than expired: dates held indefinitely by arrangement are a real thing, and reading null as "gone" would tell a guest their week had lapsed when it had not. Drives the countdown on the guest portal, and the hold.expired event.';

-- Only for a stay that is actually being held. A partial index because the
-- overwhelming majority of bookings never carry one, and a job looking for
-- lapsed holds should not walk the whole table to find the handful.
create index if not exists bookings_option_expiry_idx
  on public.bookings (organization_id, option_expires_at)
  where option_expires_at is not null;


-- ============================================================================
-- 3 · Rehearsal
-- ============================================================================
-- The security fix is asserted by *calling the function*, not by reading its
-- source. A `create or replace` that silently created a second overload would
-- pass a source check and change nothing at run time, which is precisely the
-- failure this block exists to catch. Everything happens on rows that are
-- rolled back with the migration if anything raises.

do $$
declare
  v_released boolean;
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_journey  public.booking_guest_journey%rowtype;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bookings'
      and column_name = 'option_expires_at'
  ) then
    raise exception '0038 did not add bookings.option_expires_at';
  end if;

  -- Exactly one function with this name and arity. Two would mean the replace
  -- created an overload and the old body is still what callers reach.
  if (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'guest_arrival_released'
  ) <> 1 then
    raise exception
      'guest_arrival_released is overloaded — the old body is still reachable';
  end if;

  -- Now the behaviour, on composite values built in memory. No table is
  -- touched and nothing is inserted; these are row variables, not rows.
  v_booking.status := 'cancelled'::public.booking_status;
  v_settings.arrival_release := 'after_confirmation';
  v_settings.arrival_release_hours := 24;
  v_journey.manual_released_at := now();

  -- Confirmed, manually released, and cancelled. Before this migration every
  -- one of the three clauses said "disclose"; the guard must beat all of them.
  v_released := public.guest_arrival_released(
    v_booking, v_settings, v_journey, true, true, now()
  );

  if v_released is not false then
    raise exception
      'a cancelled booking still releases arrival details (got %)', v_released;
  end if;

  -- And the ordinary case still works, or the fix has broken the feature it
  -- was protecting.
  v_booking.status := 'confirmed'::public.booking_status;
  v_journey.manual_released_at := null;

  v_released := public.guest_arrival_released(
    v_booking, v_settings, v_journey, true, false, now()
  );

  if v_released is not true then
    raise exception
      'a confirmed booking no longer releases arrival details (got %)',
      v_released;
  end if;

  -- A no-show is withheld for the same reason as a cancellation.
  v_booking.status := 'no_show'::public.booking_status;
  v_released := public.guest_arrival_released(
    v_booking, v_settings, v_journey, true, true, now()
  );

  if v_released is not false then
    raise exception 'a no-show booking still releases arrival details';
  end if;
end $$;
