begin;

-- Preserve the existing audience column and legacy single-role values. Multiple
-- roles are stored as a comma-separated list; "both" still means all section roles.
alter table public.section_documents drop constraint section_documents_audience_check;
alter table public.section_documents add constraint section_documents_audience_check
  check (
    audience = 'both'
    or (
      audience <> ''
      and string_to_array(audience, ',') <@ array['admin', 'operator', 'boss', 'salesperson', 'management']::text[]
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
