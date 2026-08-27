-- ============================================================================
-- user_profiles.sql — ESTIA · proof that every account gets a profile
--
-- What this is
--   0007 made the database responsible for creating a `user_profiles` row
--   whenever an `auth.users` row appears. This file proves it does that in the
--   cases that actually happen — a normal sign-up, a user created through the
--   dashboard with no metadata at all, a metadata payload that is the wrong
--   shape, and a second run over a profile the person has since edited — and
--   that it cannot cost anybody an account when it fails.
--
--   Every insert into `auth.users` below fires the real trigger. Nothing here
--   writes a profile by hand; a profile that appears, appeared because the
--   database put it there.
--
--   The tenant assertions run as a real `authenticated` session, with
--   request.jwt.claims set the way GoTrue sets it, and each has a positive
--   control: the same statement aimed at the caller's own row, which must
--   affect exactly one. A zero-row result on its own proves nothing — a
--   missing GRANT produces the same zero.
--
-- Two things this file does temporarily, and undoes
--   · It attaches a second trigger on `auth.users` (and, later, one on UPDATE)
--     calling the same function, because that is the only honest way to make
--     the function run twice over one profile — which is what a re-run is.
--   · For the fault-injection assertion it adds a CHECK constraint to
--     `user_profiles` that rejects one specific name, so the trigger's insert
--     fails for a reason the trigger did not anticipate. That is the only way
--     to prove the sign-up survives an error rather than a shape the code
--     already handles. It takes an ACCESS EXCLUSIVE lock on `user_profiles`,
--     so it is left until the end of the script, and it is dropped explicitly
--     as well as by the ROLLBACK.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/user_profiles.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK; it leaves no rows behind. One result
--   row per assertion plus a TOTAL. `passed = false` anywhere is a defect.
--
-- Depends on
--   0001_identity.sql … 0007_user_profiles_trigger.sql, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table profile_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $outer$
declare
  org_a   constant uuid := '41111111-1111-4111-8111-111111111111';
  org_b   constant uuid := '42222222-2222-4222-8222-222222222222';

  user_a  constant uuid := 'a2aaaaaa-0000-4000-8000-00000000000a';
  user_c  constant uuid := 'c2cccccc-0000-4000-8000-00000000000c';
  user_b  constant uuid := 'b2bbbbbb-0000-4000-8000-00000000000b';
  u_nometa  constant uuid := 'e2000000-0000-4000-8000-000000000001';
  u_objmeta constant uuid := 'e2000000-0000-4000-8000-000000000002';
  u_arrmeta constant uuid := 'e2000000-0000-4000-8000-000000000003';
  u_blank   constant uuid := 'e2000000-0000-4000-8000-000000000004';
  u_long    constant uuid := 'e2000000-0000-4000-8000-000000000005';
  u_twice   constant uuid := 'e2000000-0000-4000-8000-000000000006';
  u_edit    constant uuid := 'e2000000-0000-4000-8000-000000000007';
  u_fault   constant uuid := 'e2000000-0000-4000-8000-000000000008';

  mem_a   constant uuid := 'f2000000-0000-4000-8000-00000000000a';
  mem_c   constant uuid := 'f2000000-0000-4000-8000-00000000000c';
  mem_b   constant uuid := 'f2000000-0000-4000-8000-00000000000b';

  -- The name the sign-up form sends, in the language the product is in: if the
  -- trigger mangles UTF-8 the assertion says so.
  name_a  constant text := 'Dana Cohen';
  name_he constant text := 'יואב לוי';

  owner_role uuid;

  n_rows  bigint;
  n_all   bigint;
  n_other bigint;
  got     text;
  got_2   text;
  ok_bool boolean;
  err     text;
begin
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  ---------------------------------------------------------------------------
  -- Sanity: the trigger is actually installed, and on the right event.
  ---------------------------------------------------------------------------
  select count(*) into n_all
    from pg_trigger t
   where t.tgrelid = 'auth.users'::regclass
     and t.tgname = 'on_auth_user_created'
     and not t.tgisinternal
     and t.tgtype & 4 = 4      -- on INSERT
     and t.tgtype & 2 = 0      -- AFTER, not BEFORE
     and t.tgtype & 1 = 1;     -- FOR EACH ROW
  insert into profile_results (area, name, expected, actual, passed) values
    ('sanity', 'on_auth_user_created is an AFTER INSERT ... FOR EACH ROW trigger',
     '1', n_all::text, n_all = 1);

  ---------------------------------------------------------------------------
  -- Sign-ups. Each of these is one INSERT into auth.users and nothing else;
  -- every profile that exists afterwards was created by the trigger.
  ---------------------------------------------------------------------------
  insert into auth.users (id, email, raw_user_meta_data) values
    (user_a, 'a@profiles.test',              jsonb_build_object('full_name', name_a)),
    (user_c, 'c@profiles.test',              jsonb_build_object('full_name', name_he)),
    (user_b, 'b@profiles.test',              '{"full_name":"Bob"}'::jsonb);

  -- Created through the Supabase dashboard or an admin API call: no metadata.
  insert into auth.users (id, email) values
    (u_nometa, 'dashboard-user@profiles.test');

  -- full_name present but not a string. `->>` would return the text {"a": 1}
  -- and it would be displayed to colleagues as this person's name.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_objmeta, 'obj-meta@profiles.test', '{"full_name":{"a":1}}'::jsonb);

  -- The metadata blob is not an object at all.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_arrmeta, 'arr-meta@profiles.test', '[1,2,3]'::jsonb);

  -- A name that is only whitespace is not a name.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_blank, 'blank-name@profiles.test', '{"full_name":"   "}'::jsonb);

  -- The form refuses more than 120 characters. An admin API call does not.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_long, 'long-name@profiles.test',
     jsonb_build_object('full_name', repeat('x', 300)));

  select full_name into got from public.user_profiles where id = user_a;
  select count(*) into n_all from public.user_profiles where id = user_a;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'a normal sign-up produces exactly one profile with the sent name',
     '1 row, ' || name_a,
     n_all::text || ' row(s), ' || coalesce(got, 'null'),
     n_all = 1 and got = name_a);

  select locale, timezone into got, got_2 from public.user_profiles where id = user_a;
  select version = 1 into ok_bool from public.user_profiles where id = user_a;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'the new profile takes the table defaults and is version 1',
     'he-IL, Asia/Jerusalem, v1',
     coalesce(got, 'null') || ', ' || coalesce(got_2, 'null')
       || ', v' || case when ok_bool then '1' else 'other' end,
     got = 'he-IL' and got_2 = 'Asia/Jerusalem' and ok_bool);

  select full_name into got from public.user_profiles where id = u_nometa;
  select count(*) into n_all from public.user_profiles where id = u_nometa;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'a user with no metadata still gets a profile, named from the email',
     '1 row, dashboard-user',
     n_all::text || ' row(s), ' || coalesce(got, 'null'),
     n_all = 1 and got = 'dashboard-user');

  select full_name into got from public.user_profiles where id = u_objmeta;
  select count(*) into n_all from public.user_profiles where id = u_objmeta;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'a non-string full_name falls back instead of storing raw JSON',
     '1 row, obj-meta',
     n_all::text || ' row(s), ' || coalesce(got, 'null'),
     n_all = 1 and got = 'obj-meta');

  select full_name into got from public.user_profiles where id = u_arrmeta;
  select count(*) into n_all from public.user_profiles where id = u_arrmeta;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'metadata that is an array does not stop the profile being created',
     '1 row, arr-meta',
     n_all::text || ' row(s), ' || coalesce(got, 'null'),
     n_all = 1 and got = 'arr-meta');

  select full_name into got from public.user_profiles where id = u_blank;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'a whitespace-only name falls back to the email local part',
     'blank-name', coalesce(got, 'null'), got = 'blank-name');

  select length(full_name) into n_all from public.user_profiles where id = u_long;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'an oversized name is clamped to 120 characters',
     '120', coalesce(n_all::text, 'null'), n_all = 120);

  select full_name into got from public.user_profiles where id = user_c;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'a name survives the round trip byte for byte',
     name_he, coalesce(got, 'null'), got = name_he);

  ---------------------------------------------------------------------------
  -- Idempotency. A re-run is the function seeing an id it has already made a
  -- profile for. The only honest way to produce that is to make it run twice,
  -- so a second trigger calling the same function is attached for one insert.
  ---------------------------------------------------------------------------
  execute 'create trigger zz_on_auth_user_created_again
             after insert on auth.users
             for each row execute function public.handle_new_user()';

  insert into auth.users (id, email, raw_user_meta_data) values
    (u_twice, 'double-trigger@profiles.test', '{"full_name":"Twice"}'::jsonb);

  execute 'drop trigger zz_on_auth_user_created_again on auth.users';

  select count(*) into n_all from public.user_profiles where id = u_twice;
  insert into profile_results (area, name, expected, actual, passed) values
    ('idempotent', 'the function running twice produces one profile, not two',
     '1', n_all::text, n_all = 1);

  select version into n_all from public.user_profiles where id = u_twice;
  insert into profile_results (area, name, expected, actual, passed) values
    ('idempotent', 'the second run wrote nothing at all (version still 1)',
     '1', coalesce(n_all::text, 'null'), n_all = 1);

  -- And the case that matters: the person has since edited their name. A
  -- second run must not put the sign-up metadata back. The temporary UPDATE
  -- trigger calls the same function, which reads NEW exactly as it does on an
  -- insert.
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_edit, 'edit@profiles.test', '{"full_name":"Name From Signup"}'::jsonb);

  update public.user_profiles set full_name = 'Name The User Chose' where id = u_edit;

  execute 'create trigger zz_on_auth_user_updated
             after update on auth.users
             for each row execute function public.handle_new_user()';
  update auth.users
     set raw_user_meta_data = '{"full_name":"Name Rewritten By Gotrue"}'::jsonb
   where id = u_edit;
  execute 'drop trigger zz_on_auth_user_updated on auth.users';

  select full_name, version into got, n_all from public.user_profiles where id = u_edit;
  insert into profile_results (area, name, expected, actual, passed) values
    ('idempotent', 'a re-run does not overwrite a profile the person edited',
     'Name The User Chose, v2',
     coalesce(got, 'null') || ', v' || coalesce(n_all::text, 'null'),
     got = 'Name The User Chose' and n_all = 2);

  -- Nobody was left without one.
  select count(*) into n_all
    from auth.users u
    left join public.user_profiles p on p.id = u.id
   where u.email like '%@profiles.test' and p.id is null;
  insert into profile_results (area, name, expected, actual, passed) values
    ('create', 'every account created so far has a profile', '0',
     n_all::text, n_all = 0);

  ---------------------------------------------------------------------------
  -- Row level security on user_profiles still holds, and still holds for rows
  -- the trigger created rather than the application.
  ---------------------------------------------------------------------------
  insert into public.organizations (id, slug, name) values
    (org_a, 'profiles-org-a', 'Organization A'),
    (org_b, 'profiles-org-b', 'Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_c, user_c, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_c, org_a, owner_role),
    (mem_b, org_b, owner_role);

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.user_profiles where id = user_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('select', 'A cannot read B''s profile', '0',
     n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.user_profiles where id = user_a;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('control', 'A CAN read its own profile', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  -- The second control, and the one that makes the first assertion mean
  -- something: the policy is not simply refusing every row but the caller's.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.user_profiles where id = user_c;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('control', 'A CAN read a colleague''s profile in the same organization', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  -- A profile the trigger created, in another tenant, is as invisible as any
  -- other row: the whole table, as A sees it, is A plus A's colleagues.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.user_profiles;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('select', 'A sees exactly two profiles: its own and its colleague''s', '2',
     n_all::text || coalesce(' err=' || err, ''), n_all = 2);

  begin
    execute 'set local role authenticated';
    update public.user_profiles set full_name = 'HACKED' where id = user_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('update', 'A''s UPDATE of B''s profile affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- A colleague is readable, not writable.
  begin
    execute 'set local role authenticated';
    update public.user_profiles set full_name = 'HACKED' where id = user_c;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('update', 'A''s UPDATE of a colleague''s profile affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.user_profiles set full_name = 'Dana C.' where id = user_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own profile', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  select full_name into got from public.user_profiles where id = user_b;
  insert into profile_results (area, name, expected, actual, passed) values
    ('update', 'B''s profile still carries B''s name', 'Bob',
     coalesce(got, 'null'), got = 'Bob');

  begin
    execute 'set local role authenticated';
    insert into public.user_profiles (id, full_name) values (user_b, 'Forged');
    err := 'NO ERROR - ROW WAS WRITTEN FOR ANOTHER USER';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('insert', 'A cannot insert a profile row for B', '42501', err, err = '42501');

  -- Positive control for that refusal: the same statement aimed at the
  -- caller's own id succeeds. The row is removed first, as the owner, because
  -- the trigger already created it.
  delete from public.user_profiles where id = user_c;
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_c::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    insert into public.user_profiles (id, full_name) values (user_c, 'Yoav L.');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('control', 'C CAN insert its own profile row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'set local role anon';
    select count(*) into n_all from public.user_profiles;
    err := 'NO ERROR - anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read user_profiles at all', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- Neither function is part of anyone's API.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    perform public.handle_new_user();
    err := 'NO ERROR - authenticated executed handle_new_user()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('grants', 'authenticated cannot execute handle_new_user()', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    perform public.display_name_from_auth('{"full_name":"x"}'::jsonb, 'x@y.test');
    err := 'NO ERROR - authenticated executed display_name_from_auth()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into profile_results (area, name, expected, actual, passed) values
    ('grants', 'authenticated cannot execute display_name_from_auth()', '42501',
     err, err = '42501');

  perform set_config('request.jwt.claims', '', true);

  ---------------------------------------------------------------------------
  -- The guarantee that matters most: a failure inside the trigger must not
  -- cost somebody their account.
  --
  -- Nothing about a metadata payload can make the insert fail — every shape is
  -- handled — so the failure is injected from outside, with a constraint the
  -- trigger cannot know about. This is what a future migration adding a NOT
  -- NULL column, or a bug in a later version of the function, would look like.
  --
  -- Left until last because ADD CONSTRAINT holds an ACCESS EXCLUSIVE lock on
  -- user_profiles for the rest of the transaction.
  ---------------------------------------------------------------------------
  execute 'alter table public.user_profiles
             add constraint tmp_handle_new_user_fault
             check (full_name is distinct from ''FAULT-INJECTION'')';

  begin
    insert into auth.users (id, email, raw_user_meta_data) values
      (u_fault, 'fault@profiles.test', '{"full_name":"FAULT-INJECTION"}'::jsonb);
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  insert into profile_results (area, name, expected, actual, passed) values
    ('never_aborts', 'a failing profile insert does not fail the sign-up', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  select count(*) into n_all from auth.users where id = u_fault;
  insert into profile_results (area, name, expected, actual, passed) values
    ('never_aborts', 'the account exists and is usable', '1',
     n_all::text, n_all = 1);

  -- The subtransaction rolled the profile insert back and nothing else: there
  -- is no half-written row, and the rest of the transaction is still alive.
  select count(*) into n_all from public.user_profiles where id = u_fault;
  insert into profile_results (area, name, expected, actual, passed) values
    ('never_aborts', 'no profile row was left behind by the failed insert', '0',
     n_all::text, n_all = 0);

  execute 'alter table public.user_profiles drop constraint tmp_handle_new_user_fault';

  -- And the trigger still works afterwards, so the failure was contained
  -- rather than having poisoned the session.
  insert into auth.users (id, email, raw_user_meta_data) values
    ('e2000000-0000-4000-8000-000000000009', 'after-fault@profiles.test',
     '{"full_name":"Still Working"}'::jsonb);
  select full_name into got from public.user_profiles
   where id = 'e2000000-0000-4000-8000-000000000009';
  insert into profile_results (area, name, expected, actual, passed) values
    ('never_aborts', 'the next sign-up after the failure still gets a profile',
     'Still Working', coalesce(got, 'null'), got = 'Still Working');

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $outer$;

insert into profile_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from profile_results;

select seq, area, name, expected, actual, passed from profile_results order by seq;

rollback;
