begin;

-- A section can contain videos and documents together. Authorize uploads by
-- site-management access, organization and active section, not content_type.
create or replace function private.can_admin_document_path(p_object_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_section_id uuid;
begin
  v_organization_id := split_part(p_object_name, '/', 1)::uuid;
  v_section_id := split_part(p_object_name, '/', 2)::uuid;
  return exists (
    select 1 from public.sections section
    where section.id = v_section_id
      and section.organization_id = v_organization_id
      and section.active
      and private.is_admin_for(section.organization_id)
  );
exception
  when invalid_text_representation then return false;
end
$$;
revoke all on function private.can_admin_document_path(text) from public, anon;
grant execute on function private.can_admin_document_path(text) to authenticated;

-- The metadata insert must use the same mixed-section rule as Storage.
create or replace function private.require_document_section()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.sections section
    where section.id = new.section_id
      and section.organization_id = new.organization_id
      and section.active
  ) then
    raise exception 'DOCUMENT_SECTION_REQUIRED' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.require_document_section() from public, anon, authenticated;

drop policy if exists document_assets_admin_insert on storage.objects;
create policy document_assets_admin_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'document-assets'
  and (select private.can_admin_document_path(name))
);

commit;
