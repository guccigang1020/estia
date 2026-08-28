-- ============================================================================
-- 0014_function_grants.sql — ESTIA · trigger functions are not an API
--
-- What this fixes
--   Every function 0009, 0010 and 0011 created was left with Supabase's
--   default privileges, which grant EXECUTE on any new function in `public` to
--   `anon`, `authenticated` and `service_role` individually. PostgREST exposes
--   `public` as an RPC surface, so the database linter reported eight of them
--   as callable without signing in:
--
--       tg_bookings_freeze_total        tg_bookings_record_status
--       tg_bookings_sync_occupancy      tg_holds_sync_occupancy
--       tg_price_lines_recalc_total     tg_refunds_recalc_payment
--       tg_credit_notes_within_invoice  tg_inventory_movements_apply
--
--   All eight are SECURITY DEFINER, which is what makes it worth fixing rather
--   than noting. The practical exposure is small — PostgreSQL refuses to run a
--   trigger function outside a trigger, so a direct call returns 0A000 rather
--   than doing anything — but "it happens to fail for an unrelated reason" is
--   not a security boundary, and 0004 and 0008 already established the rule
--   for this codebase: revoke from `anon` by name, because REVOKE ... FROM
--   PUBLIC does not remove the grant Supabase made to `anon` directly.
--
--   A trigger function needs no EXECUTE grant to fire. PostgreSQL checks that
--   privilege when the trigger is created, not each time it runs, so revoking
--   from every role except the owner leaves all fifteen triggers working
--   exactly as before. That is asserted rather than assumed: the test files
--   exercise every one of these paths and are re-run after this migration.
--
--   The three small constant functions are treated differently. They are
--   SECURITY INVOKER and return a literal array, so they are harmless, but
--   they were left executable by PUBLIC, which includes `anon`. They keep
--   EXECUTE for `authenticated` — a policy expression runs with the querying
--   role's privileges, and 0004 spells out why that grant is not optional —
--   and lose it for everybody else.
--
-- Depends on
--   0009, 0010, 0011, 0013.
-- ============================================================================

set search_path = public, extensions;


-- ── Trigger functions ───────────────────────────────────────────────────────
-- Nothing but the trigger mechanism ever calls these. The owner keeps EXECUTE
-- because it is the owner; every other role loses it.

revoke all on function public.tg_bookings_sync_occupancy()          from public, anon, authenticated, service_role;
revoke all on function public.tg_holds_sync_occupancy()             from public, anon, authenticated, service_role;
revoke all on function public.tg_bookings_record_status()           from public, anon, authenticated, service_role;
revoke all on function public.tg_bookings_freeze_total()            from public, anon, authenticated, service_role;
revoke all on function public.tg_price_lines_recalc_total()         from public, anon, authenticated, service_role;
revoke all on function public.tg_booking_status_history_append_only() from public, anon, authenticated, service_role;

revoke all on function public.tg_refunds_recalc_payment()           from public, anon, authenticated, service_role;
revoke all on function public.tg_invoices_freeze_issued()           from public, anon, authenticated, service_role;
revoke all on function public.tg_credit_notes_within_invoice()      from public, anon, authenticated, service_role;

revoke all on function public.tg_tasks_stamp_status()               from public, anon, authenticated, service_role;
revoke all on function public.tg_task_checklists_stamp()            from public, anon, authenticated, service_role;
revoke all on function public.tg_inventory_movements_apply()        from public, anon, authenticated, service_role;
revoke all on function public.tg_inventory_movements_append_only()  from public, anon, authenticated, service_role;
revoke all on function public.tg_approvals_stamp_decision()         from public, anon, authenticated, service_role;
revoke all on function public.tg_commissions_stamp_status()         from public, anon, authenticated, service_role;


-- ── The constant functions ──────────────────────────────────────────────────
-- Readable vocabulary, not a capability. `authenticated` keeps EXECUTE for the
-- reason 0004 gives; PUBLIC and `anon` lose it.

revoke all on function public.occupying_booking_statuses()   from public, anon;
revoke all on function public.terminal_booking_statuses()    from public, anon;
revoke all on function public.settled_payment_statuses()     from public, anon;
revoke all on function public.allocatable_inventory_states() from public, anon;
revoke all on function public.booking_status_occupies(public.booking_status) from public, anon;

grant execute on function public.occupying_booking_statuses()   to authenticated, service_role;
grant execute on function public.terminal_booking_statuses()    to authenticated, service_role;
grant execute on function public.settled_payment_statuses()     to authenticated, service_role;
grant execute on function public.allocatable_inventory_states() to authenticated, service_role;
grant execute on function public.booking_status_occupies(public.booking_status) to authenticated, service_role;
