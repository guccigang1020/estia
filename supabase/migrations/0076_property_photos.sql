-- ============================================================================
-- 0076_property_photos.sql — ESTIA · somewhere to put the photograph
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- **The product cannot store an image.** Measured, not assumed: `storage.buckets`
-- is empty, and nothing in `src/` calls `storage.from()` or `.upload()`.
-- `site_media.url` is a text column that no code path has ever written, and
-- `properties.cover_image_url` has no writer either.
--
-- For a hospitality product this is close to the middle of the thing. A guest
-- chooses a villa by looking at it; `listing-quality` marks a listing down for
-- having no cover image and no gallery; the website module renders a gallery
-- from `site_media`. All three were waiting on a bucket that did not exist.
--
-- ── THE PATH IS THE AUTHORIZATION ══════════════════════════════════════════
--
-- Supabase Storage has no per-row tenant column. What it has is the object
-- name, so the tenant boundary has to BE the name:
--
--     property-photos/{organization_id}/{property_id}/{uuid}.{ext}
--
-- Every policy below reads `storage.foldername(name)[1]` as the organization
-- and checks it against `my_organizations()`. That is the whole isolation, and
-- it is why the first segment is validated as a uuid rather than trusted: a
-- name like `../x` or `nonsense/1.jpg` must fail the check rather than raise a
-- cast error the client could read as something else.
--
-- ── WHY THE BUCKET IS PUBLIC, DELIBERATELY ═════════════════════════════════
--
-- These photographs are marketing material. The customer's own website shows
-- them to guests who are not signed in, so a private bucket would mean a
-- signed URL for every image on every public page — links that expire, cannot
-- be cached by a CDN, and cannot be shared. The trade is stated plainly:
-- **anybody holding the URL can view the picture.** That is what a villa
-- photograph is for.
--
-- WRITING is not public and never becomes public. Insert, update and delete
-- are `authenticated` only, scoped to the organization in the path and to
-- `property.update`.
--
-- ── LIMITS ═════════════════════════════════════════════════════════════════
--
-- 8 MB, and images only. The MIME list is enforced by the bucket rather than
-- only by the client, because a client check is a courtesy: a business on a
-- rural connection uploading a 40 MB camera original is the ordinary case
-- this stops, and an executable renamed to .jpg is the other one.
--
-- Depends on 0002 (organizations, `my_organizations`), 0008 (`properties`,
-- `has_permission`).
-- ============================================================================

set search_path = public, extensions;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'property-photos',
  'property-photos',
  true,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The organization segment of an object name, as a uuid, or null when the name
-- is not shaped like one of ours. Null can never match `my_organizations()`,
-- so a malformed path is refused by the same expression that enforces tenancy
-- rather than by a separate branch somebody could forget.
create or replace function public.storage_object_organization(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name is null then null
    when (pg_catalog.string_to_array(p_name, '/'))[1]
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then ((pg_catalog.string_to_array(p_name, '/'))[1])::uuid
    else null
  end;
$$;

comment on function public.storage_object_organization(text) is
  'The organization id encoded in a storage object name, or null when the name is not shaped like one of ours. Storage has no tenant column, so the path IS the tenant boundary; returning null for a malformed name means a bad path fails the same membership test as a foreign one instead of raising a cast error.';

revoke all on function public.storage_object_organization(text) from public, anon;
grant execute on function public.storage_object_organization(text)
  to authenticated, service_role;

/* ------------------------------------------------------------- policies -- */

drop policy if exists property_photos_read on storage.objects;
create policy property_photos_read on storage.objects
  for select
  using (bucket_id = 'property-photos');

drop policy if exists property_photos_insert on storage.objects;
create policy property_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'property-photos'
    and public.storage_object_organization(name)
        in (select public.my_organizations())
    and public.has_permission(
          public.storage_object_organization(name), 'property.update')
  );

drop policy if exists property_photos_update on storage.objects;
create policy property_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'property-photos'
    and public.storage_object_organization(name)
        in (select public.my_organizations())
    and public.has_permission(
          public.storage_object_organization(name), 'property.update')
  )
  with check (
    bucket_id = 'property-photos'
    and public.storage_object_organization(name)
        in (select public.my_organizations())
  );

-- Delete is granted, unlike on `guest_reviews` and `conversation_messages`.
-- A photograph is a setting, not a record of what happened: a business that
-- uploaded the wrong picture of its own villa must be able to remove it, and
-- keeping every draft would fill a bucket nobody can read.
drop policy if exists property_photos_delete on storage.objects;
create policy property_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'property-photos'
    and public.storage_object_organization(name)
        in (select public.my_organizations())
    and public.has_permission(
          public.storage_object_organization(name), 'property.update')
  );

-- ── Rehearsal ──────────────────────────────────────────────────────────────
--
-- Exercised, not asserted. The path parser is the whole tenant boundary here,
-- so it is RUN against the names an attacker would actually try.
do $$
declare
  v_org  uuid := '11111111-1111-4111-8111-111111111111';
  v_cfg  text;
  v_n    integer;
begin
  if not exists (select 1 from storage.buckets where id = 'property-photos') then
    raise exception 'the property-photos bucket was not created';
  end if;

  if exists (
    select 1 from storage.buckets
    where id = 'property-photos'
      and (file_size_limit is null or allowed_mime_types is null)
  ) then
    raise exception 'the bucket accepts any size or any type';
  end if;

  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'storage_object_organization';
  if v_cfg is null or v_cfg not like '%search_path=%' then
    raise exception 'the path parser has a mutable search_path';
  end if;

  /* the parser, run against real names */

  if public.storage_object_organization(v_org || '/p/abc.jpg') <> v_org then
    raise exception 'a well formed object name did not yield its organization';
  end if;

  -- Everything below must be NULL, because null matches no organization.
  if public.storage_object_organization('../etc/passwd') is not null then
    raise exception 'a traversal path resolved to an organization';
  end if;
  if public.storage_object_organization('nonsense/p/a.jpg') is not null then
    raise exception 'a non-uuid first segment resolved to an organization';
  end if;
  if public.storage_object_organization('a.jpg') is not null then
    raise exception 'a bare filename resolved to an organization';
  end if;
  if public.storage_object_organization('') is not null then
    raise exception 'an empty name resolved to an organization';
  end if;
  if public.storage_object_organization(null) is not null then
    raise exception 'a null name resolved to an organization';
  end if;
  -- A uuid-shaped segment that is not this caller's is still parsed; it is
  -- `my_organizations()` that refuses it, and that separation is the point.
  if public.storage_object_organization(
       '22222222-2222-4222-8222-222222222222/p/a.jpg') is null then
    raise exception 'a foreign but valid organization name failed to parse';
  end if;

  /* the policies exist, and writing is never public */

  select count(*) into v_n from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
    and p.polname like 'property_photos_%';
  if v_n <> 4 then
    raise exception 'expected four property photo policies, found %', v_n;
  end if;

  if exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and p.polname in ('property_photos_insert', 'property_photos_update',
                        'property_photos_delete')
      and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
          not like '%my_organizations%'
  ) then
    raise exception 'a write policy does not check membership';
  end if;
end $$;
