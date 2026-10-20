-- Run after the operational role migrations in the portal's Supabase SQL Editor.
-- Existing site managers keep role 'admin'. The new 'administrator' role only
-- receives explicitly assigned content. Preserve the separate transactions.
begin;

-- Preserve the existing audience column and legacy single-role values. Multiple
-- roles are stored as a comma-separated list; "both" still means all section roles.
alter table public.section_documents drop constraint section_documents_audience_check;
alter table public.section_documents add constraint section_documents_audience_check
  check (
    audience = 'both'
    or (
      audience <> ''
      and string_to_array(audience, ',') <@ enum_range(null::public.app_role)::text[]
    )
  );

-- The existing metadata and Storage policies both call this private function.
-- Preserve its admin/organization checks and require section visibility as before.
create or replace function private.can_view_section_document(
  p_section_id uuid,
  p_organization_id uuid,
  p_audience text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.is_admin_for(p_organization_id)
    or (
      private.can_view_section(p_section_id)
      and (p_audience = 'both' or private.current_role()::text = any(string_to_array(p_audience, ',')))
    ), false
  )
$$;

revoke execute on function private.can_view_section_document(uuid, uuid, text) from public, anon;
grant execute on function private.can_view_section_document(uuid, uuid, text) to authenticated;

commit;


begin;
-- The content role is independent from "admin", the existing site manager.
-- Commit this enum addition before applying its permissions migration.
alter type public.app_role add value if not exists 'administrator';

commit;

begin;

-- Preserve all existing users and assignments. No account is promoted or
-- reclassified based on a job title. The new content role starts hidden.
insert into public.section_roles (section_id, organization_id, role, visible)
select id, organization_id, 'administrator'::public.app_role, false
from public.sections
on conflict (section_id, role) do nothing;

alter table public.section_documents drop constraint section_documents_audience_check;
alter table public.section_documents add constraint section_documents_audience_check
  check (
    audience = 'both'
    or (
      audience <> ''
      and string_to_array(audience, ',') <@ array['admin', 'operator', 'boss', 'salesperson', 'management', 'administrator']::text[]
    )
  );

-- Existing RLS policies authorize management only for role = 'admin'. The new
-- role follows section visibility, video assignments, prerequisites and Storage
-- rules like every other content viewer; it receives no management privileges.
create or replace function public.get_role_configuration()
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
begin
  if current_user <> 'service_role' then
    if private.current_organization_id() is null then return null; end if;
  end if;
  return jsonb_build_object(
    'version', 4,
    'userRoles', to_jsonb(enum_range(null::public.app_role)),
    'contentRoles', to_jsonb(array(
      select role::text from unnest(enum_range(null::public.app_role)) as roles(role)
      where role <> 'admin'::public.app_role
    )),
    'documentAudiences', jsonb_build_array('both') || to_jsonb(enum_range(null::public.app_role)),
    'adminAccess', 'automatic'
  );
end
$$;
revoke all on function public.get_role_configuration() from public, anon;
grant execute on function public.get_role_configuration() to authenticated, service_role;

-- save_admin_snapshot already validates a complete row set using enum_range.
-- Invalidate open copies so an old client cannot erase the new role's rows.
update public.organizations set content_revision = content_revision + 1;

commit;


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
