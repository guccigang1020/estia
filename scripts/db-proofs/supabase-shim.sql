-- ============================================================================
-- supabase-shim.sql — ESTIA · the part of Supabase the migrations assume
--
-- Why this file exists
--   Every file in supabase/tests/ is a security proof, and until now no gate
--   ran any of them. The obstacle was always credentials: the proofs need a
--   real database, and the main suite is deliberately database-free.
--
--   This file removes the obstacle. `0001_identity.sql` states its own
--   dependency in its header — "an empty Supabase database: schema `auth`
--   with `auth.users`, and the roles `anon`, `authenticated`, `service_role`"
--   — and that is the whole of it. Recreate those few objects on a stock
--   PostgreSQL container and the migrations apply unchanged, the proofs run
--   unchanged, and no shared project is touched by a pull request.
--
-- Why this is faithful rather than approximate
--   The one thing that could make a shim lie is privileges: if Supabase
--   granted rights that a bare Postgres does not, an isolation assertion could
--   pass here and fail in production. It does not. The live project was
--   introspected before this file was written:
--
--     · `pg_default_acl` carries entries for storage, auth, graphql,
--       graphql_public, extensions and realtime — and NOT for `public`.
--     · `public.organizations` has exactly `{postgres=arwdDxtm/postgres,
--       authenticated=rw/postgres, service_role=arwdDxtm/postgres}`, which is
--       precisely what `0004_rls.sql` grants and nothing more.
--
--   So every privilege on every `public` object in the live database was put
--   there by a migration in this repository. A stock Postgres reproduces them
--   exactly, because the migrations are the only thing granting anything.
--
-- What this file is NOT
--   It is not a Supabase emulator, and it must never grow into one. It has no
--   GoTrue, no PostgREST, no Storage and no Realtime. It exists so that SQL
--   proofs can run; anything that needs the Auth server itself is out of its
--   reach, and `supabase/tests/user_profiles.sql` says so in its own header.
--
--   Because of that, this shim never replaces a run against a real Supabase
--   project — it makes the cheap run possible on every pull request, and the
--   scheduled run against the real thing is what catches the day Supabase
--   changes something underneath us.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-proofs/supabase-shim.sql
--   then the migrations in order, then the files in supabase/tests/.
--   `node scripts/run-db-proofs.mjs --migrate` does all three.
--
--   Idempotent, and safe to run twice. It is NOT safe to run against a
--   Supabase project — it would try to recreate objects Supabase owns. The
--   runner refuses to apply it unless the target has no `auth` schema.
-- ============================================================================

-- ── Roles ───────────────────────────────────────────────────────────────────
-- The attributes below are copied from the live project, not guessed:
--
--   anon                 super=false bypassrls=false login=false
--   authenticated        super=false bypassrls=false login=false
--   service_role         super=false bypassrls=true  login=false
--   supabase_auth_admin  super=false bypassrls=false login=true
--
-- `service_role` having BYPASSRLS is the reason `0005_audit.sql` defends the
-- append-only guarantee with a trigger rather than with a policy. A shim that
-- got this one attribute wrong would make that assertion pass for the wrong
-- reason, which is worse than not running it.

do $$ begin
  create role anon nologin noinherit;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role authenticated nologin noinherit;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role service_role nologin noinherit bypassrls;
exception when duplicate_object then null;
end $$;

-- GoTrue's role. `0007_user_profiles_trigger.sql` grants EXECUTE on
-- handle_new_user() to it. The grant is not load-bearing in this shim — there
-- is no GoTrue here — but the statement has to resolve or the migration fails.
do $$ begin
  create role supabase_auth_admin nologin noinherit;
exception when duplicate_object then null;
end $$;

-- Live project: {pg_database_owner=UC/…, =U/…, postgres=U, anon=U,
-- authenticated=U, service_role=U}. Stock Postgres 15+ already gives PUBLIC
-- usage on `public`; these are stated explicitly so the shim does not depend
-- on that default staying put.
grant usage on schema public to anon, authenticated, service_role;


-- ── Extensions ──────────────────────────────────────────────────────────────
-- `0001` creates the `extensions` schema and citext itself, and `0009` creates
-- btree_gist. Neither creates pgcrypto — Supabase ships it — yet `0002` calls
-- `extensions.gen_random_bytes()` for the invitation token. That is the one
-- extension a bare Postgres has to be told about.
--
-- `gen_random_uuid()` is deliberately absent from this list: it has been in
-- core since PostgreSQL 13 and resolves from pg_catalog.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;


-- ── The auth schema ─────────────────────────────────────────────────────────
-- Only what the migrations and the proofs actually touch. The live
-- `auth.users` has some fifty columns; exactly one of them is NOT NULL without
-- a default (`id`), and the repository reads three:
--
--   id                  every `references auth.users (id)` in the migrations
--   email               the fallback display name in `0007`
--   raw_user_meta_data  where signUpAction puts `full_name`
--
-- Adding the other forty-odd would be fidelity theatre: nothing here reads
-- them, and each one is another thing to keep in step with Supabase.

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb,
  created_at         timestamptz not null default now()
);

-- Live ACL is {supabase_auth_admin=…, dashboard_user=…, postgres=ar*wdDxtm/…}
-- — no grant to anon or authenticated at all. Matching that matters: a proof
-- that a member cannot read another tenant's identity must fail for the same
-- reason it would fail in production.
revoke all on auth.users from public;
grant usage on schema auth to postgres, service_role;

-- RLS is enabled on auth.users in the live project, with no policies. Enabled
-- here for the same shape. It constrains nobody in this shim — the owner and
-- service_role both bypass it — but leaving it off would be a silent
-- divergence in exactly the table this repository's proofs care most about.
alter table auth.users enable row level security;

-- Copied verbatim from the live project:
--   select pg_get_functiondef('auth.uid()'::regprocedure)
-- The COALESCE matters. GoTrue sets `request.jwt.claims` as a JSON blob, and
-- every helper in supabase/tests/ sets exactly that key, so the second branch
-- is the one the proofs exercise. The first branch is kept because it is what
-- production has, and a shim that quietly simplifies is a shim that stops
-- being evidence.
create or replace function auth.uid() returns uuid
  language sql
  stable
as $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

grant execute on function auth.uid() to anon, authenticated, service_role;

comment on schema auth is
  'CI shim, not Supabase. Created by scripts/db-proofs/supabase-shim.sql so the SQL proofs in supabase/tests/ can run on a throwaway Postgres with no credentials. A real Supabase project has far more here.';
