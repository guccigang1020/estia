-- ============================================================================
-- 0020_phone_identity.sql — ESTIA · the telephone number as an identity key
--
-- What this does
--   Gives `user_profiles` a normalised phone column with a unique index, and
--   adds one SECURITY DEFINER function that answers a single question —
--   "which ESTIA user is this number?" — with a bare user id and nothing else.
--
-- ── Why "no such user" was the dangerous answer ─────────────────────────────
--
--   `findUserByPhone` is the first thing src/lib/agents/identity.ts asks when
--   somebody adds an agent, and its answer chooses between three branches:
--   invite a new person, attach an existing one, or point at the membership
--   they already have. Two independent faults made the answer always the same
--   wrong one.
--
--   **There was no normalised column.** `user_profiles.phone` is free text
--   with a permissive format CHECK, so it holds `050-123-4567`,
--   `+972-50-1234567`, `972501234567` and `0501234567` — one person, four
--   spellings. The domain's key is E.164 and src/lib/agents/phone.ts exists to
--   produce it. Matching `'+972501234567'` against that column finds nothing,
--   and finding nothing here is not a null answer: it sends identity.ts down
--   the `invite_new_user` branch, which creates a *second* identity for a
--   person who already has one. Four commission ledgers, four sets of
--   permissions, discovered on the day somebody asks why they were paid a
--   quarter of what they sold.
--
--   **The question is global and row level security is not.** "Does this
--   person exist in ESTIA" spans every organization by construction — the
--   whole point is that the same agent sells for five competing businesses.
--   `user_profiles_select` scopes a reader to themselves and to people they
--   share an organization with, so a signed-in owner asking about a stranger
--   correctly gets nothing back, and that nothing is indistinguishable from
--   "no such user". Correct isolation, wrong answer, same failure.
--
--   So the column is generated on write and the lookup is a definer function,
--   not the admin client. Reaching for the service role here would hand the
--   identity code the whole of `user_profiles` for every tenant in order to
--   answer one yes-or-no question, and every future caller of that code would
--   inherit the reach.
--
-- ── What the function must not reveal, and how ──────────────────────────────
--
--   **It returns `uuid`.** Not a row, not a composite type, not SETOF
--   anything. `ExistingUser` in src/lib/agents/identity.ts also carries
--   `displayName`, and that field is deliberately *not* returned: the caller
--   is asking about a stranger — somebody who by definition shares no
--   organization with them — and a name is the difference between "this
--   number is taken" and "this number belongs to Daniel Cohen, who sells for
--   your competitor". The adapter reports `displayName: null` for a stranger
--   and reads the real name from `user_profiles` for a colleague, where
--   `user_profiles_select` already permits it. A definer function cannot be
--   narrowed after the fact by its callers, so the narrowing is in the return
--   type where nothing can widen it.
--
--   **It cannot be used to enumerate.** Three properties together:
--
--     · *Exact match only.* The argument is normalised through
--       `normalize_phone_il` and compared with `=`. There is no LIKE, no
--       regex, no range and no prefix; a partial number, a wildcard, an empty
--       string and a number that does not normalise all return NULL. A caller
--       cannot ask "which numbers starting 05010 exist".
--     · *It is behind a grant.* An arbitrary signed-in user always gets NULL.
--       Only somebody holding `agent.invite` in at least one organization —
--       the grant src/lib/agents/operations.ts gates `addAgent` on, and an
--       owner-level one — can get an id back, plus anybody asking about their
--       own number. Sweeping the Israeli mobile space with `generate_series`
--       is still arithmetically possible for such a caller; what it yields is
--       covered by the third property.
--     · *The id unlocks nothing.* Every table an `auth.users` id could be used
--       against is still behind row level security, evaluated as the caller.
--       Learning the uuid of a stranger returns zero rows from
--       `user_profiles`, zero from `memberships`, zero from
--       `agent_organization_settings`. The id is an opaque token whose only
--       use is the one the domain has for it: telling `attach_existing_user`
--       apart from `invite_new_user`. That is asserted, with the id in hand,
--       in supabase/tests/agent_settings.sql.
--
--   **`anon` is revoked by name.** Supabase's ALTER DEFAULT PRIVILEGES grants
--   EXECUTE on every new function in `public` to anon individually, and a
--   REVOKE FROM PUBLIC leaves that grant standing — 0004 found this against
--   pg_proc.proacl rather than assuming it. An unauthenticated caller reaching
--   this over /rest/v1/rpc/ would be an open phone-number oracle.
--
-- ── The unique index, and what it costs ─────────────────────────────────────
--
--   `unique (phone_e164) where phone_e164 is not null`, and it is global
--   rather than per-organization on purpose: this is an identity key, and a
--   person is not owned by a tenant — `user_profiles` carries no
--   organization_id for exactly that reason. Two rows with one number are one
--   person entered twice, which is the failure the whole module prevents.
--
--   The cost is that the index has to be built against existing data. It was
--   confirmed empty of duplicates before this ran; on a database that already
--   holds two spellings of one number, this migration fails loudly rather than
--   picking a winner, which is the correct direction — merging two identities
--   means merging history, permissions and audit, and no migration should do
--   that silently.
--
-- Depends on
--   0001 (user_profiles), 0004 (memberships, my_organizations), 0009
--   (normalize_phone_il), 0012 (the agent.invite permission code).
-- ============================================================================

set search_path = public, extensions;


-- ── The normalised key ──────────────────────────────────────────────────────
-- Generated, not written. The same decision guests.phone_e164 and
-- agencies.contact_phone_e164 make, for the same reason: normalisation that a
-- write path can skip is normalisation that a write path eventually skips, and
-- the repair afterwards is a merge of real people who have made real bookings.

alter table public.user_profiles
  add column if not exists phone_e164 text
  generated always as (public.normalize_phone_il(phone)) stored;

comment on column public.user_profiles.phone_e164 is
  'The telephone number in E.164, generated from phone. For an external seller this is not a contact detail — it is the identity key: what an owner types to add somebody, what is searched to find out whether they are already in ESTIA, and where the one-time login code goes. Unique across the whole product, because a person is not owned by a tenant.';

create unique index if not exists user_profiles_phone_e164_idx
  on public.user_profiles (phone_e164) where phone_e164 is not null;


-- ── The lookup ──────────────────────────────────────────────────────────────

create or replace function public.find_user_id_by_phone(phone_e164 text)
returns uuid
language sql
stable
strict
security definer
set search_path = ''
as $$
  select p.id
  from public.user_profiles p
  where
    -- The gate first: a caller who cannot invite agents gets NULL for every
    -- number, including numbers that exist. Indistinguishable from "no such
    -- user", which is the only safe way for a refusal to look here.
    (
      exists (
        select 1
        from public.memberships m
        join public.membership_roles mr on mr.membership_id = m.id
        join public.role_permissions rp on rp.role_id = mr.role_id
        where m.user_id = (select auth.uid())
          and m.status = 'active'::public.membership_status
          and rp.permission_code = 'agent.invite'
      )
      or p.id = (select auth.uid())
    )
    -- Exact equality against the normalised key. A number that does not
    -- normalise — a wildcard, a fragment, an empty string — normalises to NULL
    -- and matches nothing, because NULL = NULL is not true.
    and p.phone_e164 = public.normalize_phone_il(find_user_id_by_phone.phone_e164)
  limit 1;
$$;

comment on function public.find_user_id_by_phone(text) is
  'The ESTIA user behind a telephone number, as a bare uuid. Returns nothing else — not the name, not the email, not which organizations they belong to — because the caller is by definition asking about somebody they share no organization with, and a name would turn "this number is taken" into competitive intelligence about a rival business''s agents. SECURITY DEFINER because the question is global and user_profiles_select is not; gated on holding agent.invite somewhere, or on asking about your own number, so an ordinary signed-in user gets NULL for every number in the product. Exact match only: there is no prefix, pattern or range form, so it cannot be swept. The id it returns unlocks nothing on its own — every table it could name is still behind row level security evaluated as the caller.';

-- `anon` by name. REVOKE FROM PUBLIC does not remove the direct grant Supabase
-- issues through ALTER DEFAULT PRIVILEGES, and an unauthenticated caller
-- reaching this over /rest/v1/rpc/ is an open phone-number oracle.
revoke all on function public.find_user_id_by_phone(text) from public, anon;
grant execute on function public.find_user_id_by_phone(text) to authenticated, service_role;
