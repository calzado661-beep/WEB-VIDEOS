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
