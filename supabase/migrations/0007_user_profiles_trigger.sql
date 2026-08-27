-- ============================================================================
-- 0007_user_profiles_trigger.sql — ESTIA foundation · every account has a face
--
-- What this does
--   Closes a gap 0001 left open. `user_profiles` was created, and nothing ever
--   wrote to it: `supabase.auth.signUp()` puts the person's name into
--   `auth.users.raw_user_meta_data` and returns, so a confirmed user had an
--   account and no profile at all. Every screen that reads a display name got
--   nothing, and the profile row a member's own settings page updates did not
--   exist to be updated.
--
--   From here the row is created by the database, in the same transaction as
--   the account, for every user however they arrive: the sign-up form, the
--   Supabase dashboard, an admin API call, a seed script. A path that creates
--   users and forgets profiles is no longer possible to write.
--
--   Also backfills the users who already exist.
--
-- Depends on
--   0001_identity.sql (user_profiles). Independent of 0002–0006.
-- ============================================================================

set search_path = public, extensions;


-- ── The display name ────────────────────────────────────────────────────────
--
-- One function, used by the trigger and by the backfill below, so the two can
-- never disagree about what a person is called.
--
-- `full_name` is the key the sign-up action writes — see
-- src/app/(auth)/actions.ts, `signUpAction`, which passes
-- `data: { full_name: fullName }` to `supabase.auth.signUp()`. It is the only
-- key that action populates, so it is the only key read here. `avatar_url`,
-- `locale` and `timezone` are deliberately not read: nothing writes them yet,
-- and the table already has the right defaults for an Israeli product
-- (`he-IL`, `Asia/Jerusalem`). Reading keys nobody sets is how a schema
-- acquires fields that quietly mean nothing.
--
-- Three things it refuses to trust, because `raw_user_meta_data` is
-- client-supplied and arrives unvalidated from `signUp()`:
--
--   · A `full_name` that is not a JSON string. `'{"full_name":{"a":1}}' ->>
--     'full_name'` does not raise — it returns the text `{"a": 1}`, which
--     would then be displayed to colleagues as somebody's name. The
--     jsonb_typeof guard is the difference between a fallback and that.
--   · Metadata that is not an object at all — an array, a bare scalar, SQL
--     NULL. All three yield NULL from `->`, so they fall through to the
--     fallback rather than raising.
--   · A name of unbounded length. The sign-up form refuses more than 120
--     characters; an admin API call does not, and a name is rendered in a
--     table cell. Clamped to the same 120.
--
-- The fallback is the local part of the email address, which is what a user
-- created through the dashboard with no metadata gets: "dana" rather than an
-- empty cell the person cannot explain. Deliberately the local part and not
-- the whole address — `user_profiles` is readable by everyone the person
-- shares an organization with, and turning a colleague list into a mailing
-- list is not a feature anyone asked for. NULL is still possible (an account
-- with neither name nor email, which GoTrue permits for phone identities), and
-- that is fine: the row exists, and the person can name themselves.

create or replace function public.display_name_from_auth(meta jsonb, email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    coalesce(
      nullif(
        btrim(
          case
            when jsonb_typeof(meta -> 'full_name') = 'string'
              then meta ->> 'full_name'
          end
        ),
        ''
      ),
      nullif(split_part(coalesce(email, ''), '@', 1), '')
    ),
    120
  );
$$;

comment on function public.display_name_from_auth(jsonb, text) is
  'Derives a display name from auth.users.raw_user_meta_data, falling back to the local part of the email address. Shared by the sign-up trigger and the backfill so both agree. Treats a non-string full_name as absent rather than rendering raw JSON as somebody name.';

revoke all on function public.display_name_from_auth(jsonb, text) from public, anon, authenticated;
grant execute on function public.display_name_from_auth(jsonb, text) to service_role;


-- ── handle_new_user ─────────────────────────────────────────────────────────
--
-- SECURITY DEFINER with an explicitly empty search_path, matching 0004: the
-- inserting role is GoTrue's `supabase_auth_admin`, which has no business
-- holding rights on `public.user_profiles`, and a definer function that
-- resolves an unqualified name through the caller's search_path is a privilege
-- escalation waiting to be found. Every object below is schema-qualified.
--
-- Three decisions, one for each thing that actually happens:
--
--   1. Idempotent — `on conflict (id) do nothing`. A profile may already
--      exist: the backfill below may have created it, a restore may replay the
--      insert, a future migration may add a second trigger. DO NOTHING rather
--      than DO UPDATE, and that is the whole point: by the time this fires a
--      second time the row is the person's own, edited through their settings
--      page, and a trigger that "refreshed" it from sign-up metadata would
--      silently undo their change.
--
--   2. It cannot abort the sign-up. The insert sits inside a BEGIN … EXCEPTION
--      block, and in PL/pgSQL that block is an implicit subtransaction: a
--      failure inside it rolls back the profile insert and nothing else, so
--      the INSERT into auth.users still commits. Failing to build a profile is
--      not a reason to refuse somebody an account — the account is the thing
--      they are owed, and the profile is repairable afterwards. The whole body
--      is inside the block, because a statement outside it would not be
--      covered by it.
--
--      Silence would be worse than the bug, so the failure is logged as a
--      WARNING with the sqlstate and the user id. It lands in the Postgres
--      logs, where a missing profile can be traced to a cause instead of being
--      discovered by a customer looking at a blank name.
--
--   3. AFTER INSERT, not BEFORE: the auth.users row must exist before a
--      profile can reference it — `user_profiles.id` is a foreign key to it.
--      It fires at sign-up rather than at email confirmation, so an
--      unconfirmed account also has a profile. That is harmless — a profile
--      carries no entitlement, and membership is what grants reach — and it
--      avoids a second trigger watching `email_confirmed_at`.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.user_profiles (id, full_name)
    values (
      new.id,
      public.display_name_from_auth(new.raw_user_meta_data, new.email)
    )
    on conflict (id) do nothing;
  exception when others then
    -- Never re-raise. See decision 2 above.
    raise warning 'handle_new_user: no profile created for auth user % (% - %)',
      new.id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the matching public.user_profiles row. Idempotent (on conflict do nothing, never do update, so an edited profile is not overwritten) and incapable of failing the sign-up (the insert runs inside a plpgsql exception block, which is a subtransaction; a failure is logged as a warning and the account is still created).';

-- The trigger function is not part of anyone API. PostgreSQL checks EXECUTE on
-- a trigger function when the trigger is created rather than when it fires, so
-- the grant to supabase_auth_admin is not load-bearing today — it states the
-- intent, and it is what a future release that does check at fire time would
-- need. `anon` and `authenticated` are named explicitly for the reason spelled
-- out in 0004: Supabase's ALTER DEFAULT PRIVILEGES grants them EXECUTE on
-- every new function in `public` individually, and a REVOKE FROM PUBLIC leaves
-- those grants standing.
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ── Why metadata updates do NOT flow through ────────────────────────────────
--
-- There is deliberately no trigger on UPDATE of auth.users.
--
-- `user_profiles` is the system of record for the profile. The person edits it
-- themselves — 0004 gives them UPDATE on their own row — and `full_name` in
-- `raw_user_meta_data` is a copy of what they typed into the sign-up form
-- once, months ago.
--
-- GoTrue rewrites `raw_user_meta_data` on events that have nothing to do with
-- the name: linking an identity, refreshing a provider profile, an admin
-- editing a user in the dashboard. A sync trigger would let any of those
-- silently overwrite a name the person deliberately changed, and there is no
-- way for the database to tell "the user renamed themselves in auth" from "an
-- unrelated event rewrote the metadata blob". Between two sources with no
-- rule for deciding a winner, the safe design is one direction and one moment:
-- seed at creation, never again.
--
-- It would also bump `version` and `updated_at` behind an open settings form,
-- which is precisely the lost-update the optimistic locking in 0001 exists to
-- catch — the form would be told its data is stale by a change nobody made.
--
-- If the product ever wants "update my name everywhere", it belongs in the
-- service layer, which knows the change came from the person and can write
-- both sides on purpose.


-- ── Backfill ────────────────────────────────────────────────────────────────
-- The users who signed up before this migration existed. Same derivation as
-- the trigger, same ON CONFLICT, so re-running the file is safe and the two
-- can never disagree about a name.

insert into public.user_profiles (id, full_name)
select u.id, public.display_name_from_auth(u.raw_user_meta_data, u.email)
from auth.users u
on conflict (id) do nothing;
