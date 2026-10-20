-- Activate folders after the existing operational role migrations.
-- Preserves users and files. Includes the preceding content-role and upload fixes.
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


begin;

alter table public.sections add column if not exists parent_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sections_parent_organization_fkey') then
    alter table public.sections add constraint sections_parent_organization_fkey
      foreign key (parent_id, organization_id) references public.sections(id, organization_id);
    alter table public.sections add constraint sections_not_own_parent check (parent_id is distinct from id);
  end if;
end $$;
create index if not exists sections_parent_order_idx on public.sections(parent_id, sort_order) where parent_id is not null;
create unique index if not exists sections_folder_name_unique on public.sections(parent_id, lower(btrim(name))) where parent_id is not null and active;

-- Exactly one folder level. The check is deferred to allow the atomic save to
-- create parent and child in either order without accepting orphaned folders.
create or replace function private.check_section_folder_parent()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if exists (
    select 1 from public.sections child
    left join public.sections parent on parent.id = child.parent_id and parent.organization_id = child.organization_id
    where child.organization_id = new.organization_id and child.active and child.parent_id is not null
      and (parent.id is null or not parent.active or parent.parent_id is not null)
  ) then
    raise exception 'FOLDER_HIERARCHY_INVALID' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.check_section_folder_parent() from public, anon, authenticated;
drop trigger if exists sections_folder_parent_valid on public.sections;
create constraint trigger sections_folder_parent_valid after insert or update on public.sections
deferrable initially deferred for each row execute function private.check_section_folder_parent();

-- Existing video, document, quiz and Storage policies use this same helper.
-- Keep its existing definer boundary to read role rows without recursive RLS.
create or replace function private.can_view_section(p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1 from public.sections s
    where s.id = p_section_id and (
      private.is_admin_for(s.organization_id)
      or (
        s.organization_id = private.current_organization_id() and s.active
        and exists (select 1 from public.section_roles sr where sr.section_id = s.id and sr.organization_id = s.organization_id and sr.role = private.current_role() and sr.visible)
        and (s.parent_id is null or exists (
          select 1 from public.sections parent
          join public.section_roles pr on pr.section_id = parent.id and pr.organization_id = parent.organization_id
          where parent.id = s.parent_id and parent.organization_id = s.organization_id
            and parent.active and parent.parent_id is null and pr.role = private.current_role() and pr.visible
        ))
      )
    )
  ), false)
$$;
revoke all on function private.can_view_section(uuid) from public, anon;
grant execute on function private.can_view_section(uuid) to authenticated;

-- Older playback helpers inline section permissions. Apply the inherited
-- section check there too, retaining manual locks and learning prerequisites.
do $playback$
declare signature text; definition text;
begin
  foreach signature in array array['private.can_view_video_card(uuid)', 'private.can_play_video(uuid)', 'private.learning_prerequisites_met(uuid)'] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if strpos(definition, 'private.can_view_section(s.id)') = 0 then
      if strpos(definition, 'and s.active') = 0 then raise exception 'Unsupported playback helper: %', signature; end if;
      definition := replace(definition, 'and s.active', 'and s.active and private.can_view_section(s.id)');
      execute definition;
    end if;
  end loop;
end $playback$;

-- Extend the installed atomic save, retaining revision checks, locking,
-- learning-path validation and all current role definitions.
do $upgrade$
declare definition text;
begin
  definition := replace(pg_get_functiondef('public.save_admin_snapshot(jsonb,bigint)'::regprocedure), E'\r\n', E'\n');
  if strpos(definition, 'FOLDER_CLIENT_REQUIRED') = 0 then
    if strpos(definition, '  update public.sections section' || E'\n' || '  set active = false') = 0
      or strpos(definition, '  perform private.validate_learning_paths(v_organization_id);') = 0 then
      raise exception 'Install the current operational role save function before section_subfolders';
    end if;
    definition := replace(definition, '  update public.sections section' || E'\n' || '  set active = false', $move$
  -- Removing a folder returns its documents to its parent, preserving files.
  update public.section_documents document
  set section_id = folder.parent_id
  from public.sections folder
  where document.section_id = folder.id and folder.organization_id = v_organization_id
    and folder.parent_id is not null
    and not exists (select 1 from jsonb_to_recordset(p_snapshot -> 'sections') as desired(id uuid) where desired.id = folder.id)
    and exists (select 1 from jsonb_to_recordset(p_snapshot -> 'sections') as desired(id uuid) where desired.id = folder.parent_id);

  update public.sections section
  set active = false$move$);
    definition := replace(definition, '  perform private.validate_learning_paths(v_organization_id);', $folders$
  if exists (select 1 from public.sections where organization_id = v_organization_id and parent_id is not null)
    and exists (select 1 from jsonb_array_elements(p_snapshot -> 'sections') item where not (item ? 'parent_id')) then
    raise exception 'FOLDER_CLIENT_REQUIRED' using errcode = '22023';
  end if;

  update public.sections section set parent_id = desired.parent_id
  from jsonb_to_recordset(p_snapshot -> 'sections') as desired(id uuid, parent_id uuid)
  where section.id = desired.id and section.organization_id = v_organization_id
    and section.parent_id is distinct from desired.parent_id;

  if exists (
    select 1 from public.sections child
    left join public.sections parent on parent.id = child.parent_id and parent.organization_id = child.organization_id
    where child.organization_id = v_organization_id and child.active and child.parent_id is not null
      and (parent.id is null or not parent.active or parent.parent_id is not null)
  ) then
    raise exception 'FOLDER_HIERARCHY_INVALID' using errcode = '23514';
  end if;
  perform private.validate_learning_paths(v_organization_id);$folders$);
    execute definition;
  end if;
end $upgrade$;

update public.organizations set content_revision = content_revision + 1;
commit;
