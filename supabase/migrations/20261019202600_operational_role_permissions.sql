begin;

-- Preserve the current accounts, areas and permissions. New audiences start
-- hidden until the administrator assigns sections and videos explicitly.
alter table public.section_roles drop constraint section_roles_role_check;
alter table public.section_roles add constraint section_roles_role_check
  check (role <> 'admin'::public.app_role);
alter table public.video_assignments drop constraint video_assignments_role_check;
alter table public.video_assignments add constraint video_assignments_role_check
  check (role <> 'admin'::public.app_role);

alter table public.section_documents drop constraint section_documents_audience_check;
alter table public.section_documents add constraint section_documents_audience_check
  check (audience in ('operator', 'boss', 'salesperson', 'management', 'both'));

create or replace function private.create_default_section_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.section_roles (section_id, organization_id, role, visible)
  select new.id, new.organization_id, role, false
  from unnest(enum_range(null::public.app_role)) as roles(role)
  where role <> 'admin'::public.app_role
  on conflict (section_id, role) do nothing;
  return new;
end
$$;

-- A trigger helper is not a callable public endpoint.
revoke all on function private.create_default_section_roles() from public, anon, authenticated;

insert into public.section_roles (section_id, organization_id, role, visible)
select section.id, section.organization_id, role, false
from public.sections section
cross join unnest(enum_range(null::public.app_role)) as roles(role)
where role <> 'admin'::public.app_role
on conflict (section_id, role) do nothing;

-- Force already-open admin sessions to reload the expanded role snapshot.
update public.organizations set content_revision = content_revision + 1;

-- Require all four audience rows per section, including hidden ones. An old
-- two-role client must never silently erase assignments to the new audiences.
create or replace function public.save_admin_snapshot(
  p_snapshot jsonb,
  p_expected_revision bigint
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_organization_id uuid := private.current_organization_id();
  v_organization_name text := nullif(btrim(p_snapshot ->> 'organization'), '');
  v_logo_url text := nullif(btrim(p_snapshot ->> 'logo_url'), '');
  v_current_revision bigint;
  v_lock_key bigint;
begin
  perform set_config('idle_in_transaction_session_timeout', '8000', true);
  perform set_config('statement_timeout', '15000', true);

  if v_organization_id is null
    or not private.is_admin_for(v_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  v_lock_key := pg_catalog.hashtextextended(v_organization_id::text, 0);

  begin
    perform set_config('lock_timeout', '3000', true);
    perform pg_catalog.pg_advisory_xact_lock(v_lock_key);
  exception
    when lock_not_available then
      raise exception 'SAVE_BUSY'
        using errcode = '55P03',
              detail = 'Another save for this organization is already in progress. Try again.';
  end;

  select o.content_revision
  into v_current_revision
  from public.organizations o
  where o.id = v_organization_id
  for update;

  if v_current_revision is null
    or p_expected_revision is null
    or p_expected_revision <> v_current_revision then
    raise exception 'STALE_SNAPSHOT'
      using errcode = 'VH001',
            detail = 'The organization changed after this snapshot was loaded.';
  end if;

  if p_snapshot is null
    or coalesce(jsonb_typeof(p_snapshot -> 'sections'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'section_roles'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'videos'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'video_sources'), '') <> 'array'
    or coalesce(jsonb_typeof(p_snapshot -> 'video_assignments'), '') <> 'array' then
    raise exception 'Invalid admin snapshot' using errcode = '22023';
  end if;

  if jsonb_array_length(p_snapshot -> 'sections') > 500
    or jsonb_array_length(p_snapshot -> 'section_roles') > 500 * (cardinality(enum_range(null::public.app_role)) - 1)
    or jsonb_array_length(p_snapshot -> 'videos') > 5000
    or jsonb_array_length(p_snapshot -> 'video_sources') > 5000
    or jsonb_array_length(p_snapshot -> 'video_assignments') > 5000 * (cardinality(enum_range(null::public.app_role)) - 1) then
    raise exception 'Admin snapshot exceeds safe limits' using errcode = '54000';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
    where (
      select count(distinct desired_role.role)
      from jsonb_to_recordset(p_snapshot -> 'section_roles') as desired_role(
        section_id uuid,
        role public.app_role
      )
      where desired_role.section_id = desired_section.id
        and desired_role.role <> 'admin'::public.app_role
    ) <> cardinality(enum_range(null::public.app_role)) - 1
  ) or exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'section_roles') as desired_role(
      section_id uuid,
      role public.app_role
    )
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
      where desired_section.id = desired_role.section_id
    )
  ) then
    raise exception 'Section roles do not match the snapshot sections'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
    where (
      select count(*)
      from jsonb_to_recordset(p_snapshot -> 'video_sources') as desired_source(video_id uuid)
      where desired_source.video_id = desired_video.id
    ) <> 1
  ) or exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'video_sources') as desired_source(video_id uuid)
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = desired_source.video_id
    )
  ) then
    raise exception 'Video sources do not match the snapshot videos'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_snapshot -> 'video_assignments') as desired_assignment(
      video_id uuid,
      section_id uuid
    )
    where not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = desired_assignment.video_id
    )
    or not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired_section(id uuid)
      where desired_section.id = desired_assignment.section_id
    )
  ) then
    raise exception 'Video assignments reference rows outside the snapshot'
      using errcode = '22023';
  end if;

  if v_organization_name is not null then
    update public.organizations o
    set name = v_organization_name,
        logo_url = v_logo_url
    where o.id = v_organization_id
      and (o.name, o.logo_url) is distinct from (v_organization_name, v_logo_url);
  end if;

  if jsonb_typeof(p_snapshot -> 'settings') = 'object' then
    insert into public.app_settings (
      organization_id,
      product_name,
      welcome_title,
      welcome_message,
      support_message,
      allow_light_mode,
      require_quiz_photo
    )
    values (
      v_organization_id,
      coalesce(nullif(btrim(p_snapshot #>> '{settings,product_name}'), ''), 'Video Hub'),
      coalesce(nullif(btrim(p_snapshot #>> '{settings,welcome_title}'), ''), 'Video Hub'),
      coalesce(btrim(p_snapshot #>> '{settings,welcome_message}'), ''),
      coalesce(btrim(p_snapshot #>> '{settings,support_message}'), ''),
      coalesce((p_snapshot #>> '{settings,allow_light_mode}')::boolean, true),
      coalesce((p_snapshot #>> '{settings,require_quiz_photo}')::boolean, false)
    )
    on conflict (organization_id) do update
    set product_name = excluded.product_name,
        welcome_title = excluded.welcome_title,
        welcome_message = excluded.welcome_message,
        support_message = excluded.support_message,
        allow_light_mode = excluded.allow_light_mode,
        require_quiz_photo = excluded.require_quiz_photo
    where (
      app_settings.product_name,
      app_settings.welcome_title,
      app_settings.welcome_message,
      app_settings.support_message,
      app_settings.allow_light_mode,
      app_settings.require_quiz_photo
    ) is distinct from (
      excluded.product_name,
      excluded.welcome_title,
      excluded.welcome_message,
      excluded.support_message,
      excluded.allow_light_mode,
      excluded.require_quiz_photo
    );
  end if;

  insert into public.sections (
    id, organization_id, name, slug, icon, sort_order, active
  )
  select
    row_data.id,
    v_organization_id,
    row_data.name,
    row_data.slug,
    coalesce(nullif(btrim(row_data.icon), ''), 'layers'),
    coalesce(row_data.sort_order, 0),
    coalesce(row_data.active, true)
  from jsonb_to_recordset(p_snapshot -> 'sections') as row_data(
    id uuid,
    name text,
    slug text,
    icon text,
    sort_order integer,
    active boolean
  )
  on conflict (id) do update
  set name = excluded.name,
      slug = excluded.slug,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      active = excluded.active
  where (
    sections.name,
    sections.slug,
    sections.icon,
    sections.sort_order,
    sections.active
  ) is distinct from (
    excluded.name,
    excluded.slug,
    excluded.icon,
    excluded.sort_order,
    excluded.active
  );

  insert into public.section_roles (
    section_id, organization_id, role, visible
  )
  select
    row_data.section_id,
    v_organization_id,
    row_data.role,
    coalesce(row_data.visible, false)
  from jsonb_to_recordset(p_snapshot -> 'section_roles') as row_data(
    section_id uuid,
    role public.app_role,
    visible boolean
  )
  on conflict (section_id, role) do update
  set visible = excluded.visible
  where section_roles.visible is distinct from excluded.visible;

  insert into public.videos (
    id,
    organization_id,
    title,
    description,
    duration_label,
    duration_seconds,
    featured,
    active,
    created_at
  )
  select
    row_data.id,
    v_organization_id,
    row_data.title,
    coalesce(row_data.description, ''),
    row_data.duration_label,
    row_data.duration_seconds,
    coalesce(row_data.featured, false),
    coalesce(row_data.active, true),
    coalesce(row_data.created_at, now())
  from jsonb_to_recordset(p_snapshot -> 'videos') as row_data(
    id uuid,
    title text,
    description text,
    duration_label text,
    duration_seconds integer,
    featured boolean,
    active boolean,
    created_at timestamptz
  )
  on conflict (id) do update
  set title = excluded.title,
      description = excluded.description,
      duration_label = excluded.duration_label,
      duration_seconds = excluded.duration_seconds,
      featured = excluded.featured,
      active = excluded.active
  where (
    videos.title,
    videos.description,
    videos.duration_label,
    videos.duration_seconds,
    videos.featured,
    videos.active
  ) is distinct from (
    excluded.title,
    excluded.description,
    excluded.duration_label,
    excluded.duration_seconds,
    excluded.featured,
    excluded.active
  );

  insert into public.video_sources (
    video_id,
    provider,
    source_ref,
    source_url,
    thumbnail_url,
    storage_bucket,
    storage_object_path,
    metadata
  )
  select
    row_data.video_id,
    row_data.provider,
    row_data.source_ref,
    row_data.source_url,
    row_data.thumbnail_url,
    row_data.storage_bucket,
    row_data.storage_object_path,
    coalesce(row_data.metadata, '{}'::jsonb)
  from jsonb_to_recordset(p_snapshot -> 'video_sources') as row_data(
    video_id uuid,
    provider public.video_provider,
    source_ref text,
    source_url text,
    thumbnail_url text,
    storage_bucket text,
    storage_object_path text,
    metadata jsonb
  )
  on conflict (video_id) do update
  set provider = excluded.provider,
      source_ref = excluded.source_ref,
      source_url = excluded.source_url,
      thumbnail_url = excluded.thumbnail_url,
      storage_bucket = excluded.storage_bucket,
      storage_object_path = excluded.storage_object_path,
      metadata = excluded.metadata
  where (
    video_sources.provider,
    video_sources.source_ref,
    video_sources.source_url,
    video_sources.thumbnail_url,
    video_sources.storage_bucket,
    video_sources.storage_object_path,
    video_sources.metadata
  ) is distinct from (
    excluded.provider,
    excluded.source_ref,
    excluded.source_url,
    excluded.thumbnail_url,
    excluded.storage_bucket,
    excluded.storage_object_path,
    excluded.metadata
  );

  insert into public.video_assignments (
    video_id,
    organization_id,
    role,
    section_id,
    visible,
    is_locked,
    prerequisite_video_id,
    sort_order
  )
  select
    row_data.video_id,
    v_organization_id,
    row_data.role,
    row_data.section_id,
    coalesce(row_data.visible, true),
    coalesce(row_data.is_locked, false),
    row_data.prerequisite_video_id,
    coalesce(row_data.sort_order, 0)
  from jsonb_to_recordset(p_snapshot -> 'video_assignments') as row_data(
    video_id uuid,
    role public.app_role,
    section_id uuid,
    visible boolean,
    is_locked boolean,
    prerequisite_video_id uuid,
    sort_order integer
  )
  on conflict (video_id, role) do update
  set section_id = excluded.section_id,
      visible = excluded.visible,
      is_locked = excluded.is_locked,
      prerequisite_video_id = excluded.prerequisite_video_id,
      sort_order = excluded.sort_order
  where (
    video_assignments.section_id,
    video_assignments.visible,
    video_assignments.is_locked,
    video_assignments.prerequisite_video_id,
    video_assignments.sort_order
  ) is distinct from (
    excluded.section_id,
    excluded.visible,
    excluded.is_locked,
    excluded.prerequisite_video_id,
    excluded.sort_order
  );

  delete from public.video_assignments assignment
  using public.videos video
  where assignment.organization_id = v_organization_id
    and video.id = assignment.video_id
    and video.organization_id = v_organization_id
    and video.active
    and exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired_video(id uuid)
      where desired_video.id = video.id
    )
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'video_assignments') as desired(
        video_id uuid,
        role public.app_role
      )
      where desired.video_id = assignment.video_id
        and desired.role = assignment.role
    );

  update public.videos video
  set active = false
  where video.organization_id = v_organization_id
    and video.active
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'videos') as desired(id uuid)
      where desired.id = video.id
    );

  update public.sections section
  set active = false
  where section.organization_id = v_organization_id
    and section.active
    and not exists (
      select 1
      from jsonb_to_recordset(p_snapshot -> 'sections') as desired(id uuid)
      where desired.id = section.id
    );

  perform private.validate_learning_paths(v_organization_id);

  update public.organizations o
  set content_revision = o.content_revision + 1
  where o.id = v_organization_id
  returning o.content_revision into v_current_revision;

  return v_current_revision;
end
$$;

commit;
