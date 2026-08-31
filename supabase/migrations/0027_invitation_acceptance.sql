-- ============================================================================
-- 0027_invitation_acceptance.sql — ESTIA · the other half of an invitation
--
-- What this closes
--   0001 created `invitations` and said the raw token is shown once and never
--   stored. `src/lib/invitations` mints one, hashes it and writes the row. And
--   then nothing could redeem it: there is no path in the product that turns a
--   link into a membership, so every invitation ever sent was a dead letter.
--
--   0004 already named the reason it could not be written in the application
--   the way every other write is, and named the remedy too:
--
--     "Accepting an invitation is not expressible here either: the invitee is
--      a stranger to the organization until the moment they accept. That path
--      is a SECURITY DEFINER function ... which verifies the token hash, the
--      expiry and the single-use flags, and creates the membership."
--
--   Every policy in this schema is written as
--   `organization_id in (select public.my_organizations())`, and
--   `my_organizations()` reads memberships with status `active`. The invitee
--   has no membership at all. `memberships_insert` additionally demands
--   `has_permission(organization_id, 'user.invite')`, and `membership_roles`
--   and `membership_scopes` demand `role.assign`. A person accepting an
--   invitation holds none of the three, and should not: an invitee who could
--   satisfy `memberships_insert` could admit themselves to any organization
--   whose id they could guess.
--
--   So the token is the authorization. This function is the only place in the
--   schema where possession of a secret, rather than a grant, decides that a
--   row may be written — which is why every one of its refusals is spelled out
--   below and why it takes no argument other than the hash.
--
-- Why the hash, and not the token
--   The caller hashes the token with `hashInvitationToken` in
--   `src/lib/invitations/token.ts` — the same function the creation path used,
--   which is the point of exporting it — and passes the digest. The raw token
--   therefore never reaches the database, never appears in a statement, and
--   never lands in a Postgres log. The trade is that anybody who can already
--   read `invitations.token_hash` can redeem an invitation; that is a person
--   with direct table access, who by then has the whole tenant anyway.
--
-- Why it returns jsonb
--   `returns table (organization_id uuid, ...)` would declare `organization_id`
--   as a variable with the same name as a column on three of the tables this
--   function touches, and plpgsql resolves that ambiguity by raising. A single
--   jsonb result has one shape, is read by one parser in
--   `src/lib/invitations/acceptance.ts`, and cannot drift column by column.
--
-- Why every refusal raises rather than returns a flag
--   A function that returns `{ ok: false }` writes nothing but commits the
--   transaction it ran in. A raise rolls back — and the rollback is the point
--   on a path where the membership, its roles, its scope and the consumption
--   of the token must either all happen or none of them do. `DATABASE_URL` is
--   not set in this deployment, so the application's own unit of work is
--   sequential rather than transactional; a plpgsql function is one statement
--   and therefore one transaction regardless. Acceptance is atomic here even
--   while the rest of the product's writes are not.
--
-- Depends on
--   0001 (memberships, invitations, membership_status), 0002 (membership_roles,
--   membership_scopes, tg_membership_role_assignable), 0004 (the policies this
--   deliberately runs outside of), 0005 + 0006 (audit_events, including
--   on_behalf_of_user_id), 0014 (the rule that a function in `public` is an
--   API surface until its grants say otherwise).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Redeeming a token
-- ============================================================================

create or replace function public.accept_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id        uuid := (select auth.uid());
  v_email          text;
  v_label          text;
  v_inv            public.invitations%rowtype;
  v_membership     public.memberships%rowtype;
  v_membership_id  uuid;
  v_org_name       text;
  v_role_code      text;
  v_created        boolean := false;
  v_scope_rows     integer := 0;
begin
  -- Signing in is not the authorization — the token is — but it is how the
  -- membership gets a person to belong to. There is no anonymous acceptance.
  if v_user_id is null then
    raise exception 'not_authenticated'
      using hint = 'התחבר או הירשם כדי לקבל את ההזמנה.', errcode = '28000';
  end if;

  if p_token_hash is null or length(btrim(p_token_hash)) = 0 then
    raise exception 'invitation_not_found'
      using hint = 'הקישור אינו תקין. בקש מהמזמין לשלוח קישור חדש.',
            errcode = 'P0002';
  end if;

  -- FOR UPDATE, because two clicks on the same link half a second apart is the
  -- ordinary case, not the exotic one. Without the lock both transactions read
  -- `accepted_at is null`, both pass every check below, and the second fails on
  -- `memberships_user_organization_key` with a constraint name instead of a
  -- sentence — or worse, succeeds at inserting a second role row.
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'invitation_not_found'
      using hint = 'ההזמנה לא נמצאה. ייתכן שהקישור שונה, או שההזמנה בוטלה.',
            errcode = 'P0002';
  end if;

  select email into v_email from auth.users where id = v_user_id;

  -- Already used. If this same person used it, say so calmly and hand back the
  -- membership they already have: a person who refreshes the confirmation page
  -- has done nothing wrong, and an error there reads as "your access failed"
  -- when their access is fine.
  if v_inv.accepted_at is not null then
    if v_inv.accepted_by = v_user_id then
      select * into v_membership
      from public.memberships
      where user_id = v_user_id and organization_id = v_inv.organization_id;

      if found then
        select name into v_org_name
        from public.organizations where id = v_inv.organization_id;

        return jsonb_build_object(
          'membershipId',   v_membership.id,
          'organizationId', v_inv.organization_id,
          'organizationName', v_org_name,
          'roleId',         v_inv.role_id,
          'created',        false,
          'replay',         true
        );
      end if;
    end if;

    raise exception 'invitation_already_used'
      using hint = 'ההזמנה הזאת כבר נוצלה. בקש מהמזמין לשלוח הזמנה חדשה.',
            errcode = 'P0003';
  end if;

  if v_inv.revoked_at is not null then
    raise exception 'invitation_revoked'
      using hint = 'ההזמנה בוטלה. פנה למי שהזמין אותך.', errcode = 'P0004';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired'
      using hint = 'תוקף ההזמנה פג. בקש מהמזמין לשלוח קישור חדש.',
            errcode = 'P0005';
  end if;

  -- The invitation names an address, and `invitations_one_live_per_email_idx`
  -- is written on that address. Letting a different account redeem the link
  -- would make that index guard nothing and would mean a forwarded email hands
  -- somebody else the role. Compared on the text, lower-cased: `email` is
  -- citext, `auth.users.email` is text, and this function runs with an empty
  -- search_path where the citext operators are not visible by name.
  if v_email is null or lower(v_email) <> lower(v_inv.email::text) then
    raise exception 'invitation_email_mismatch'
      using hint = 'ההזמנה נשלחה לכתובת דוא״ל אחרת. התחבר עם הכתובת שאליה נשלחה ההזמנה.',
            errcode = 'P0006';
  end if;

  select name into v_org_name
  from public.organizations where id = v_inv.organization_id;

  if v_org_name is null then
    raise exception 'organization_missing'
      using hint = 'הארגון שאליו הוזמנת אינו קיים עוד.', errcode = 'P0007';
  end if;

  -- The role, re-checked here even though `tg_membership_role_assignable`
  -- fires on the insert below. The trigger raises about a role; this raises
  -- about an invitation, which is what the person is looking at.
  select code into v_role_code
  from public.roles
  where id = v_inv.role_id
    and (organization_id is null or organization_id = v_inv.organization_id);

  if v_role_code is null then
    raise exception 'role_missing'
      using hint = 'התפקיד שבהזמנה כבר אינו קיים. בקש הזמנה חדשה.',
            errcode = 'P0008';
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and organization_id = v_inv.organization_id;

  if found then
    -- An active member redeeming a second invitation is not a re-admission,
    -- it is a role change, and a role change belongs on the roles screen where
    -- somebody holding `role.assign` makes it deliberately. Silently widening a
    -- colleague's authority because a link was clicked is exactly the kind of
    -- grant nobody remembers approving.
    if v_membership.status = 'active'::public.membership_status then
      raise exception 'already_member'
        using hint = 'אתה כבר חבר בארגון הזה. לשינוי תפקיד פנה למנהל.',
              errcode = 'P0009';
    end if;

    -- invited · pending · suspended · removed. Re-admission, and the token is
    -- the authority for it — somebody holding `user.invite` minted it for this
    -- address, within their own scope, and 0001 keeps the row rather than
    -- deleting it precisely so that the person's history survives their
    -- absence.
    update public.memberships
    set status     = 'active'::public.membership_status,
        joined_at  = coalesce(joined_at, now()),
        invited_by = coalesce(v_inv.invited_by, invited_by),
        updated_by = v_user_id
    where id = v_membership.id;

    v_membership_id := v_membership.id;
  else
    insert into public.memberships (
      user_id, organization_id, status, joined_at,
      invited_by, created_by, updated_by
    )
    values (
      v_user_id, v_inv.organization_id,
      'active'::public.membership_status, now(),
      v_inv.invited_by, v_user_id, v_user_id
    )
    returning id into v_membership_id;

    v_created := true;
  end if;

  -- ON CONFLICT DO NOTHING, not an error: a returning member may still hold
  -- the role from last time, and the primary key is (membership_id, role_id).
  insert into public.membership_roles (
    membership_id, organization_id, role_id, created_by
  )
  values (v_membership_id, v_inv.organization_id, v_inv.role_id, v_user_id)
  on conflict (membership_id, role_id) do nothing;

  -- The scope is written for a membership that did not exist, and left alone
  -- for one that did. `membership_scopes_membership_key` makes it one row per
  -- membership, so an upsert here would silently rewrite a returning member's
  -- reach — narrowing an organization-wide manager to two properties, or
  -- widening somebody to the whole tenant — on a path where nobody with
  -- `role.assign` is present to intend it. What the invitation offers a
  -- stranger, it offers; what an existing membership already carries stands
  -- until somebody changes it on purpose.
  insert into public.membership_scopes (
    membership_id, organization_id, kind,
    property_ids, unit_ids, team_ids, created_by, updated_by
  )
  values (
    v_membership_id, v_inv.organization_id, v_inv.scope_kind,
    v_inv.scope_property_ids, v_inv.scope_unit_ids, v_inv.scope_team_ids,
    v_user_id, v_user_id
  )
  on conflict (membership_id) do nothing;

  -- Did the scope row land, or did a returning member already carry one?
  -- `row_count` is an integer, so it cannot be read into a boolean.
  get diagnostics v_scope_rows = row_count;

  -- Consumed. `invitations_single_outcome` and `invitations_accepted_pair`
  -- both hold, and the FOR UPDATE above means no second transaction reached
  -- here first.
  update public.invitations
  set accepted_at = now(),
      accepted_by = v_user_id,
      updated_by  = v_user_id
  where id = v_inv.id;

  select coalesce(
    nullif(btrim(p.full_name), ''),
    v_email,
    v_user_id::text
  )
  into v_label
  from public.user_profiles p
  where p.id = v_user_id;

  v_label := coalesce(v_label, v_email, v_user_id::text);

  -- The audit row, written here rather than by the application, because the
  -- application cannot: `audit_events_insert` also demands
  -- `my_organizations()`, and the caller only becomes a member two statements
  -- ago inside this same transaction, where the policy's STABLE helper may
  -- still be reading its snapshot. Writing it here also means a rollback takes
  -- the event with it, which is the correct relationship between the two.
  insert into public.audit_events (
    organization_id, actor_user_id, actor_type, actor_label,
    action, resource_type, resource_id, after, summary
  )
  values (
    v_inv.organization_id, v_user_id, 'user'::public.audit_actor_type, v_label,
    'invitation.accept', 'invitation', v_inv.id::text,
    jsonb_build_object(
      'membershipId',  v_membership_id,
      'roleId',        v_inv.role_id,
      'roleCode',      v_role_code,
      'scopeKind',     v_inv.scope_kind,
      'membershipCreated', v_created,
      'scopeApplied',  v_scope_rows > 0,
      'invitedBy',     v_inv.invited_by
    ),
    v_label || ' קיבל את ההזמנה לארגון ' || v_org_name ||
      ' בתפקיד ' || v_role_code || '.'
  );

  return jsonb_build_object(
    'membershipId',     v_membership_id,
    'organizationId',   v_inv.organization_id,
    'organizationName', v_org_name,
    'roleId',           v_inv.role_id,
    'created',          v_created,
    'replay',           false
  );
end;
$$;

comment on function public.accept_invitation(text) is
  'Redeems an invitation token hash: verifies the row exists, is neither used nor revoked, has not expired and was addressed to the caller''s own email, then creates or re-activates the membership, attaches the invited role, writes the scope for a new membership only, consumes the invitation and records an audit event. The one place in this schema where a secret rather than a grant authorizes a write, which is why it is SECURITY DEFINER and why every refusal is explicit. Raises on every failure so the whole act rolls back together.';


-- ============================================================================
-- 2 · Who may call it
-- ============================================================================
-- 0014's rule, applied to a function that is genuinely an API surface rather
-- than accidentally one: Supabase grants EXECUTE on a new function in `public`
-- to `anon`, `authenticated` and `service_role` individually, and REVOKE FROM
-- PUBLIC does not take those back. `anon` must not hold it — the function
-- raises for a null `auth.uid()`, but "it happens to fail for another reason"
-- is not a boundary. `service_role` loses it because nothing on the server
-- redeems an invitation on somebody's behalf; the person does, signed in.

revoke all on function public.accept_invitation(text)
  from public, anon, service_role;

grant execute on function public.accept_invitation(text) to authenticated;


-- ============================================================================
-- 3 · Rehearsal
-- ============================================================================
-- The same shape 0026 used: assert the things this migration assumed, so a
-- schema that has drifted fails here rather than at the moment somebody clicks
-- an invitation link.

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('invitations'), ('memberships'), ('membership_roles'),
    ('membership_scopes'), ('audit_events'), ('organizations'),
    ('user_profiles'), ('roles')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0027: %', missing;
  end if;

  -- The two unique constraints the upserts above name by column. Losing either
  -- turns `on conflict` into a runtime 42P10 on the acceptance path.
  if not exists (
    select 1 from pg_constraint
    where conname = 'membership_roles_pkey'
  ) then
    raise exception 'membership_roles_pkey missing — the role upsert has no arbiter';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'membership_scopes_membership_key'
  ) then
    raise exception 'membership_scopes_membership_key missing — the scope upsert has no arbiter';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'invitations_token_hash_key'
  ) then
    raise exception 'invitations_token_hash_key missing — the token lookup is not unique';
  end if;

  -- `anon` holding EXECUTE would mean an unauthenticated caller can reach the
  -- one function that writes a membership.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'accept_invitation'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'anon still holds EXECUTE on accept_invitation';
  end if;
end $$;
