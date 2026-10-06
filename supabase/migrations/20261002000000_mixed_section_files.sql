begin;

-- Las secciones pueden contener videos y documentos al mismo tiempo.
drop trigger if exists section_content_settings_keep_document_mode on public.section_content_settings;
drop function if exists private.prevent_document_mode_disable_with_files();

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

create or replace function private.can_admin_document_path(p_object_name text)
returns boolean
language plpgsql
stable
security definer
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

update public.section_content_settings set content_type = 'videos'
where content_type = 'documents';

commit;
