begin;

create table public.section_content_settings (
  section_id uuid primary key,
  organization_id uuid not null,
  content_type text not null default 'videos'
    check (content_type in ('videos', 'documents')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (section_id, organization_id),
  foreign key (section_id, organization_id)
    references public.sections(id, organization_id) on delete cascade
);

create table public.section_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  section_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 180),
  file_name text not null check (length(trim(file_name)) between 1 and 255),
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  file_size bigint not null check (file_size > 0 and file_size <= 26214400),
  storage_bucket text not null default 'document-assets'
    check (storage_bucket = 'document-assets'),
  storage_object_path text not null unique,
  sort_order integer not null default 0 check (sort_order >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (section_id, organization_id)
    references public.sections(id, organization_id) on delete restrict
);

create index section_documents_section_order_idx
  on public.section_documents(organization_id, section_id, active, sort_order, created_at);

create trigger section_content_settings_set_updated_at
before update on public.section_content_settings
for each row execute function private.set_updated_at();

create trigger section_documents_set_updated_at
before update on public.section_documents
for each row execute function private.set_updated_at();

insert into public.section_content_settings (section_id, organization_id, content_type)
select id, organization_id, 'videos'
from public.sections
on conflict (section_id) do nothing;

create or replace function private.create_default_section_content_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.section_content_settings (section_id, organization_id, content_type)
  values (new.id, new.organization_id, 'videos')
  on conflict (section_id) do nothing;
  return new;
end
$$;

create trigger sections_create_default_content_settings
after insert on public.sections
for each row execute function private.create_default_section_content_settings();

create or replace function private.require_document_section()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.section_content_settings settings
    where settings.section_id = new.section_id
      and settings.organization_id = new.organization_id
      and settings.content_type = 'documents'
  ) then
    raise exception 'DOCUMENT_SECTION_REQUIRED' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger section_documents_require_document_section
before insert or update of section_id, organization_id on public.section_documents
for each row execute function private.require_document_section();

create or replace function private.prevent_document_mode_disable_with_files()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.content_type = 'documents' and new.content_type = 'videos' and exists (
    select 1 from public.section_documents document
    where document.section_id = new.section_id and document.active
  ) then
    raise exception 'SECTION_HAS_DOCUMENTS' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger section_content_settings_keep_document_mode
before update of content_type on public.section_content_settings
for each row execute function private.prevent_document_mode_disable_with_files();

create or replace function private.can_read_document_object(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.section_documents document
    where document.storage_bucket = p_bucket_id
      and document.storage_object_path = p_object_name
      and document.active
      and private.can_view_section(document.section_id)
  ), false)
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
    select 1
    from public.sections section
    join public.section_content_settings settings
      on settings.section_id = section.id
     and settings.organization_id = section.organization_id
    where section.id = v_section_id
      and section.organization_id = v_organization_id
      and settings.content_type = 'documents'
      and private.is_admin_for(section.organization_id)
  );
exception
  when invalid_text_representation then return false;
end
$$;

revoke execute on function private.create_default_section_content_settings() from public, anon, authenticated;
revoke execute on function private.require_document_section() from public, anon, authenticated;
revoke execute on function private.prevent_document_mode_disable_with_files() from public, anon, authenticated;
revoke execute on function private.can_read_document_object(text, text) from public, anon;
revoke execute on function private.can_admin_document_path(text) from public, anon;
grant execute on function private.can_read_document_object(text, text) to authenticated;
grant execute on function private.can_admin_document_path(text) to authenticated;

alter table public.section_content_settings enable row level security;
alter table public.section_documents enable row level security;

create policy section_content_settings_read_allowed
on public.section_content_settings for select to authenticated
using ((select private.can_view_section(section_id)));

create policy section_content_settings_admin_insert
on public.section_content_settings for insert to authenticated
with check ((select private.is_admin_for(organization_id)));

create policy section_content_settings_admin_update
on public.section_content_settings for update to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

create policy section_content_settings_admin_delete
on public.section_content_settings for delete to authenticated
using ((select private.is_admin_for(organization_id)));

create policy section_documents_read_allowed
on public.section_documents for select to authenticated
using (
  active
  and (select private.can_view_section(section_id))
);

create policy section_documents_admin_insert
on public.section_documents for insert to authenticated
with check ((select private.is_admin_for(organization_id)));

create policy section_documents_admin_update
on public.section_documents for update to authenticated
using ((select private.is_admin_for(organization_id)))
with check ((select private.is_admin_for(organization_id)));

create policy section_documents_admin_delete
on public.section_documents for delete to authenticated
using ((select private.is_admin_for(organization_id)));

grant select, insert, update, delete on public.section_content_settings to authenticated;
grant select, insert, update, delete on public.section_documents to authenticated;
grant all on public.section_content_settings, public.section_documents to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'document-assets',
  'document-assets',
  false,
  26214400,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy document_assets_read_allowed
on storage.objects for select to authenticated
using (
  bucket_id = 'document-assets'
  and (select private.can_read_document_object(bucket_id, name))
);

create policy document_assets_admin_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'document-assets'
  and (select private.can_admin_document_path(name))
);

create policy document_assets_admin_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'document-assets'
  and (
    -- Permite limpiar una subida si el insert de metadatos falla.
    (select private.can_admin_document_path(name))
    or exists (
      select 1
      from public.section_documents document
      where document.storage_object_path = name
        and document.storage_bucket = bucket_id
        and (select private.is_admin_for(document.organization_id))
    )
  )
);

commit;
