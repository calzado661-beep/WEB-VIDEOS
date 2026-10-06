begin;

alter table public.section_documents
  add column audience text not null default 'both'
  check (audience in ('operator', 'boss', 'both'));

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
      and (p_audience = 'both' or p_audience = private.current_role()::text)
    ), false
  )
$$;

revoke execute on function private.can_view_section_document(uuid, uuid, text) from public, anon;
grant execute on function private.can_view_section_document(uuid, uuid, text) to authenticated;

drop policy if exists section_documents_read_allowed on public.section_documents;
create policy section_documents_read_allowed
on public.section_documents for select to authenticated
using (
  active
  and (select private.can_view_section_document(section_id, organization_id, audience))
);

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
      and private.can_view_section_document(
        document.section_id, document.organization_id, document.audience
      )
  ), false)
$$;

commit;
