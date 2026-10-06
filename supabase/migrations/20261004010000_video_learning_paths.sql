begin;

-- Independent by default. Each audience can follow a different sequence.
alter table public.video_assignments
  add column prerequisite_video_id uuid,
  add constraint video_assignment_prerequisite_fk
    foreign key (prerequisite_video_id, organization_id)
    references public.videos(id, organization_id),
  add constraint video_assignment_no_self_prerequisite
    check (prerequisite_video_id is distinct from video_id);

create index video_assignments_prerequisite_idx
  on public.video_assignments(prerequisite_video_id, role)
  where prerequisite_video_id is not null;

alter table public.video_quizzes
  add column max_attempts integer not null default 3 check (max_attempts between 1 and 20);
alter table public.video_quiz_results
  add column extra_attempts integer not null default 0 check (extra_attempts >= 0);
alter table public.video_quiz_attempts
  add column request_id uuid not null default gen_random_uuid(),
  add constraint video_quiz_attempts_request_unique unique (video_id, user_id, request_id);

create or replace function private.learning_prerequisites_met(p_video_id uuid)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role public.app_role := private.current_role();
  v_org uuid := private.current_organization_id();
  v_previous uuid;
  v_current uuid := p_video_id;
  v_seen uuid[] := array[p_video_id];
begin
  loop
    select prerequisite_video_id into v_previous
    from public.video_assignments
    where video_id = v_current and role = v_role and organization_id = v_org;
    if v_previous is null then return true; end if;
    if v_previous = any(v_seen) then return false; end if;
    v_seen := array_append(v_seen, v_previous);
    if not exists (
      select 1 from public.videos v
      join public.video_assignments a on a.video_id = v.id and a.role = v_role
      join public.sections s on s.id = a.section_id
      join public.section_roles sr on sr.section_id = s.id and sr.role = v_role
      join public.video_quizzes q on q.video_id = v.id and q.question_count > 0
      join public.video_watch_progress w on w.video_id = v.id and w.user_id = auth.uid() and w.completed
      join public.video_quiz_results r on r.video_id = v.id and r.user_id = auth.uid() and r.passed
      where v.id = v_previous and v.organization_id = v_org and v.active
        and a.visible and s.active and sr.visible
    ) then return false; end if;
    v_current := v_previous;
  end loop;
end
$$;
revoke all on function private.learning_prerequisites_met(uuid) from public, anon;
grant execute on function private.learning_prerequisites_met(uuid) to authenticated;

-- Validate the complete desired graph after an atomic administrative save.
create or replace function private.validate_learning_paths(p_org uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_assignment record;
  v_current uuid;
  v_seen uuid[];
begin
  if not private.is_admin_for(p_org) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  for v_assignment in
    select a.*, v.title from public.video_assignments a
    join public.videos v on v.id = a.video_id
    where a.organization_id = p_org and v.active and a.visible
      and a.prerequisite_video_id is not null
  loop
    v_current := v_assignment.prerequisite_video_id;
    v_seen := array[v_assignment.video_id];
    while v_current is not null loop
      if v_current = any(v_seen) then
        raise exception 'La secuencia de "%" forma un ciclo.', v_assignment.title using errcode = 'VL001';
      end if;
      v_seen := array_append(v_seen, v_current);
      if not exists (
        select 1 from public.videos v
        join public.video_assignments a on a.video_id = v.id and a.role = v_assignment.role
        join public.video_quizzes q on q.video_id = v.id and q.question_count > 0
        join public.video_sources source on source.video_id = v.id
        where v.id = v_current and v.organization_id = p_org and v.active and a.visible
          and source.provider in ('youtube', 'vimeo', 'direct', 'supabase_storage')
      ) then
        raise exception 'El video previo de "%" debe estar publicado para el mismo rol, tener cuestionario y permitir registrar su reproducción (YouTube, Vimeo o archivo de video).', v_assignment.title using errcode = 'VL001';
      end if;
      select prerequisite_video_id into v_current from public.video_assignments
      where video_id = v_current and role = v_assignment.role;
    end loop;
  end loop;
end
$$;
revoke all on function private.validate_learning_paths(uuid) from public, anon;
grant execute on function private.validate_learning_paths(uuid) to authenticated;

-- Do not silently break a sequence when a quiz is removed. The quiz editor
-- below updates metadata in place instead of deleting and recreating it.
create or replace function private.protect_required_quiz()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.video_assignments a
    join public.videos v on v.id = a.video_id
    where a.prerequisite_video_id = old.video_id and a.visible and v.active
  ) then
    raise exception 'Este cuestionario es requisito de otro video. Cambia primero la secuencia de ese video.' using errcode = 'VL001';
  end if;
  return old;
end
$$;
revoke all on function private.protect_required_quiz() from public, anon, authenticated;
create trigger video_quizzes_protect_required
before delete on public.video_quizzes
for each row execute function private.protect_required_quiz();

create or replace function public.admin_grant_quiz_attempt(p_video_id uuid, p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_max integer;
  v_result public.video_quiz_results%rowtype;
begin
  select organization_id, max_attempts into v_org, v_max
  from public.video_quizzes where video_id = p_video_id for share;
  if v_org is null or not private.is_admin_for(v_org) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.video_assignments a on a.role = p.role and a.video_id = p_video_id and a.visible
    where p.user_id = p_user_id and p.organization_id = v_org and p.active
  ) then raise exception 'El usuario no tiene asignado este cuestionario.' using errcode = '22023'; end if;

  -- Same lock as submission: two tabs/admins can grant only one usable retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_video_id::text || ':' || p_user_id::text, 1));
  select * into v_result from public.video_quiz_results
  where video_id = p_video_id and user_id = p_user_id for update;
  if not found or v_result.passed or v_result.attempts_count < v_max + v_result.extra_attempts then
    raise exception 'Solo se puede habilitar otro intento cuando se agotan los disponibles y el cuestionario sigue sin aprobar.' using errcode = '22023';
  end if;
  -- Existing unlimited histories can exceed the new base limit. Grant exactly
  -- one remaining attempt, even for those users, without erasing history.
  update public.video_quiz_results
  set extra_attempts = greatest(extra_attempts, attempts_count - v_max) + 1, updated_at = now()
  where video_id = p_video_id and user_id = p_user_id returning * into v_result;
  insert into public.audit_events(organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_org, auth.uid(), 'quiz_attempt_granted', 'video_quiz', p_video_id::text,
    jsonb_build_object('userId', p_user_id, 'extraAttempts', v_result.extra_attempts, 'attemptsCount', v_result.attempts_count));
  return jsonb_build_object('extraAttempts', v_result.extra_attempts, 'attemptsCount', v_result.attempts_count, 'remainingAttempts', 1);
end
$$;
revoke all on function public.admin_grant_quiz_attempt(uuid, uuid) from public, anon;
grant execute on function public.admin_grant_quiz_attempt(uuid, uuid) to authenticated;

-- Function definitions appended below preserve the existing snapshot conflict
-- handling, grading, camera evidence and immutable attempt history.

create or replace function private.can_play_video(p_video_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.videos v
      where v.id = p_video_id
        and (
          private.is_admin_for(v.organization_id)
          or (
            v.organization_id = private.current_organization_id()
            and v.active
            and exists (
              select 1
              from public.video_assignments va
              join public.sections s
                on s.id = va.section_id
               and s.organization_id = va.organization_id
              join public.section_roles sr
                on sr.section_id = va.section_id
               and sr.organization_id = va.organization_id
               and sr.role = va.role
              where va.video_id = v.id
                and va.organization_id = v.organization_id
                and va.role = private.current_role()
                and va.visible
                and not va.is_locked
                and private.learning_prerequisites_met(v.id)
                and s.active
                and sr.visible
            )
          )
        )
    ),
    false
  )
$$;

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
    or jsonb_array_length(p_snapshot -> 'section_roles') > 1000
    or jsonb_array_length(p_snapshot -> 'videos') > 5000
    or jsonb_array_length(p_snapshot -> 'video_sources') > 5000
    or jsonb_array_length(p_snapshot -> 'video_assignments') > 10000 then
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
        and desired_role.role in ('operator', 'boss')
    ) <> 2
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

drop function public.admin_save_video_quiz(uuid, integer, jsonb);

create or replace function public.admin_save_video_quiz(
  p_video_id uuid,
  p_passing_score_percent integer,
  p_questions jsonb,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_question jsonb;
  v_option jsonb;
  v_question_id uuid;
  v_question_index integer := 0;
  v_option_index integer;
  v_correct_count integer;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  if p_passing_score_percent is null or p_passing_score_percent < 1 or p_passing_score_percent > 100 then
    raise exception 'El puntaje mínimo para aprobar debe estar entre 1 y 100.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_organization_id::text, 0));
  if p_max_attempts is null or p_max_attempts not between 1 and 20 then
    raise exception 'El límite de intentos debe estar entre 1 y 20.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) < 1 then
    raise exception 'El cuestionario necesita al menos una pregunta.' using errcode = '22023';
  end if;

  insert into public.video_quizzes (video_id, organization_id, passing_score_percent, question_count, max_attempts)
  values (p_video_id, v_organization_id, p_passing_score_percent, jsonb_array_length(p_questions), p_max_attempts)
  on conflict (video_id) do update set passing_score_percent = excluded.passing_score_percent,
    question_count = excluded.question_count, max_attempts = excluded.max_attempts, updated_at = now();
  delete from private.quiz_questions where video_id = p_video_id;

  for v_question in select * from jsonb_array_elements(p_questions)
  loop
    if coalesce(length(trim(v_question ->> 'prompt')), 0) not between 1 and 500 then
      raise exception 'Cada pregunta necesita un enunciado de hasta 500 caracteres.' using errcode = '22023';
    end if;

    if jsonb_typeof(v_question -> 'options') <> 'array' or jsonb_array_length(v_question -> 'options') < 2 then
      raise exception 'Cada pregunta necesita al menos 2 opciones.' using errcode = '22023';
    end if;

    select count(*) into v_correct_count
    from jsonb_array_elements(v_question -> 'options') opt
    where (opt ->> 'isCorrect')::boolean is true;

    if v_correct_count <> 1 then
      raise exception 'Cada pregunta necesita exactamente una respuesta correcta.' using errcode = '22023';
    end if;

    v_question_id := gen_random_uuid();
    insert into private.quiz_questions (id, video_id, organization_id, prompt, sort_order)
    values (v_question_id, p_video_id, v_organization_id, trim(v_question ->> 'prompt'), v_question_index);

    v_option_index := 0;
    for v_option in select * from jsonb_array_elements(v_question -> 'options')
    loop
      if coalesce(length(trim(v_option ->> 'label')), 0) not between 1 and 240 then
        raise exception 'Cada opción necesita un texto de hasta 240 caracteres.' using errcode = '22023';
      end if;

      insert into private.quiz_question_options (
        id, question_id, organization_id, label, is_correct, sort_order
      )
      values (
        gen_random_uuid(),
        v_question_id,
        v_organization_id,
        trim(v_option ->> 'label'),
        coalesce((v_option ->> 'isCorrect')::boolean, false),
        v_option_index
      );
      v_option_index := v_option_index + 1;
    end loop;

    v_question_index := v_question_index + 1;
  end loop;

  return jsonb_build_object('ok', true, 'questionCount', v_question_index);
end
$$;

create or replace function public.admin_get_video_quiz(p_video_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_result jsonb;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'videoId', vq.video_id,
    'passingScorePercent', vq.passing_score_percent,
    'maxAttempts', vq.max_attempts,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (
          select jsonb_agg(
            jsonb_build_object('id', o.id, 'label', o.label, 'isCorrect', o.is_correct)
            order by o.sort_order
          )
          from private.quiz_question_options o
          where o.question_id = q.id
        )
      ) order by q.sort_order)
      from private.quiz_questions q
      where q.video_id = vq.video_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.video_quizzes vq
  where vq.video_id = p_video_id;

  return v_result;
end
$$;

create or replace function public.get_playable_video_quiz(p_video_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (select private.can_play_video(p_video_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  if not exists (select 1 from public.video_watch_progress where video_id = p_video_id and user_id = auth.uid() and completed) then
    raise exception 'Primero debes completar el video.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'videoId', vq.video_id,
    'passingScorePercent', vq.passing_score_percent,
    'maxAttempts', vq.max_attempts,
    'attemptsCount', coalesce(r.attempts_count, 0),
    'extraAttempts', coalesce(r.extra_attempts, 0),
    'remainingAttempts', greatest(0, vq.max_attempts + coalesce(r.extra_attempts, 0) - coalesce(r.attempts_count, 0)),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'options', (
          select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.sort_order)
          from private.quiz_question_options o
          where o.question_id = q.id
        )
      ) order by q.sort_order)
      from private.quiz_questions q
      where q.video_id = vq.video_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.video_quizzes vq
  left join public.video_quiz_results r on r.video_id = vq.video_id and r.user_id = auth.uid()
  where vq.video_id = p_video_id;

  return v_result;
end
$$;

create or replace function public.admin_delete_video_quiz(p_video_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  select v.organization_id into v_organization_id
  from public.videos v
  where v.id = p_video_id;

  if v_organization_id is null or not (select private.is_admin_for(v_organization_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_organization_id::text, 0));
  delete from public.video_quizzes where video_id = p_video_id;
end
$$;

drop function public.submit_video_quiz_attempt(uuid, jsonb, text);
create or replace function public.submit_video_quiz_attempt(
  p_video_id uuid,
  p_answers jsonb,
  p_photo_path text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_user_id uuid := auth.uid();
  v_passing_score integer;
  v_max_attempts integer;
  v_extra_attempts integer := 0;
  v_require_photo boolean := false;
  v_total_questions integer;
  v_correct_questions integer;
  v_unanswered_count integer;
  v_answers_detail jsonb;
  v_score_percent integer;
  v_passed boolean;
  v_previous_attempts integer := 0;
  v_previous_best integer := 0;
  v_previous_passed boolean := false;
  v_previous_first_passed_at timestamptz;
  v_next_first_passed_at timestamptz;
  v_next_attempt_number integer;
  v_existing public.video_quiz_attempts%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sesión requerida' using errcode = '28000';
  end if;

  if not (select private.can_play_video(p_video_id)) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select v.organization_id into v_organization_id from public.videos v where v.id = p_video_id;

  select vq.passing_score_percent, vq.max_attempts into v_passing_score, v_max_attempts
  from public.video_quizzes vq
  where vq.video_id = p_video_id for share;

  if v_passing_score is null then
    raise exception 'Este video no tiene cuestionario.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.video_watch_progress where video_id = p_video_id and user_id = v_user_id and completed) then
    raise exception 'Primero debes completar el video.' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_video_id::text || ':' || v_user_id::text, 1));
  select coalesce(extra_attempts, 0), attempts_count, passed
  into v_extra_attempts, v_previous_attempts, v_previous_passed
  from public.video_quiz_results where video_id = p_video_id and user_id = v_user_id for update;
  v_extra_attempts := coalesce(v_extra_attempts, 0);
  -- A retried HTTP request returns the original grade without consuming a
  -- second attempt, including when the original success response was lost.
  select * into v_existing from public.video_quiz_attempts
  where video_id = p_video_id and user_id = v_user_id and request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'scorePercent', v_existing.score_percent,
      'correctCount', (select count(*) from jsonb_array_elements(v_existing.answers) a where (a->>'isCorrect')::boolean),
      'totalQuestions', jsonb_array_length(v_existing.answers),
      'passed', v_existing.passed, 'passingScorePercent', v_passing_score,
      'attemptsCount', v_previous_attempts, 'maxAttempts', v_max_attempts,
      'extraAttempts', v_extra_attempts,
      'remainingAttempts', greatest(0, v_max_attempts + v_extra_attempts - v_previous_attempts),
      'bestScorePercent', (select best_score_percent from public.video_quiz_results where video_id = p_video_id and user_id = v_user_id)
    );
  end if;
  if coalesce(v_previous_passed, false) then
    raise exception 'Ya aprobaste este cuestionario.' using errcode = '22023';
  end if;
  if coalesce(v_previous_attempts, 0) >= v_max_attempts + v_extra_attempts then
    raise exception 'Agotaste tus intentos. El administrador debe habilitar otro intento en este cuestionario.' using errcode = '22023';
  end if;

  select coalesce(s.require_quiz_photo, false) into v_require_photo
  from public.app_settings s
  where s.organization_id = v_organization_id;

  if v_require_photo then
    if p_photo_path is null or btrim(p_photo_path) = '' then
      raise exception 'Debes tomarte una foto antes de responder el cuestionario.' using errcode = '22023';
    end if;

    if not exists (
      select 1
      from storage.objects so
      where so.bucket_id = 'quiz-photos'
        and so.name = p_photo_path
        and so.name like (v_organization_id::text || '/' || v_user_id::text || '/' || p_video_id::text || '/%')
        and so.created_at >= now() - interval '15 minutes'
    ) then
      raise exception 'La foto del cuestionario no es válida o expiró. Vuelve a tomarla.' using errcode = '22023';
    end if;
  end if;

  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'Respuestas inválidas.' using errcode = '22023';
  end if;

  select
    count(*),
    count(*) filter (where so.is_correct is true),
    count(*) filter (where so.id is null),
    jsonb_agg(
      jsonb_build_object(
        'questionId', q.id,
        'prompt', q.prompt,
        'selectedOptionId', ans.option_id,
        'selectedLabel', so.label,
        'isCorrect', coalesce(so.is_correct, false),
        'correctLabel', co.label
      ) order by q.sort_order
    )
  into v_total_questions, v_correct_questions, v_unanswered_count, v_answers_detail
  from private.quiz_questions q
  left join lateral (
    select nullif(a ->> 'optionId', '')::uuid as option_id
    from jsonb_array_elements(p_answers) a
    where nullif(a ->> 'questionId', '')::uuid = q.id
    limit 1
  ) ans on true
  left join private.quiz_question_options so
    on so.id = ans.option_id and so.question_id = q.id
  left join private.quiz_question_options co
    on co.question_id = q.id and co.is_correct = true
  where q.video_id = p_video_id;

  if v_total_questions = 0 or jsonb_array_length(p_answers) <> v_total_questions or coalesce(v_unanswered_count, 1) > 0 then
    raise exception 'Debes responder todas las preguntas.' using errcode = '22023';
  end if;

  v_score_percent := case when v_total_questions > 0
    then floor((v_correct_questions::numeric / v_total_questions) * 100)
    else 0 end;
  v_passed := v_score_percent >= v_passing_score;

  select attempts_count, best_score_percent, passed, first_passed_at
  into v_previous_attempts, v_previous_best, v_previous_passed, v_previous_first_passed_at
  from public.video_quiz_results
  where video_id = p_video_id and user_id = v_user_id;

  v_next_attempt_number := coalesce(v_previous_attempts, 0) + 1;
  v_next_first_passed_at := case
    when coalesce(v_previous_passed, false) then v_previous_first_passed_at
    when v_passed then now()
    else null
  end;

  insert into public.video_quiz_attempts (
    video_id, user_id, organization_id, attempt_number, score_percent, passed, answers, photo_path, request_id
  )
  values (
    p_video_id, v_user_id, v_organization_id, v_next_attempt_number,
    v_score_percent, v_passed, coalesce(v_answers_detail, '[]'::jsonb), p_photo_path, coalesce(p_request_id, gen_random_uuid())
  );

  insert into public.video_quiz_results (
    video_id, user_id, organization_id, attempts_count, best_score_percent,
    passed, last_answers, last_attempt_at, first_passed_at, updated_at
  )
  values (
    p_video_id, v_user_id, v_organization_id,
    v_next_attempt_number,
    greatest(coalesce(v_previous_best, 0), v_score_percent),
    coalesce(v_previous_passed, false) or v_passed,
    coalesce(v_answers_detail, '[]'::jsonb),
    now(),
    v_next_first_passed_at,
    now()
  )
  on conflict (video_id, user_id) do update
  set attempts_count = excluded.attempts_count,
      best_score_percent = excluded.best_score_percent,
      passed = excluded.passed,
      last_answers = excluded.last_answers,
      last_attempt_at = excluded.last_attempt_at,
      first_passed_at = excluded.first_passed_at,
      updated_at = now();

  return jsonb_build_object(
    'scorePercent', v_score_percent,
    'correctCount', v_correct_questions,
    'totalQuestions', v_total_questions,
    'passed', v_passed,
    'passingScorePercent', v_passing_score,
    'attemptsCount', v_next_attempt_number,
    'maxAttempts', v_max_attempts,
    'extraAttempts', v_extra_attempts,
    'remainingAttempts', greatest(0, v_max_attempts + v_extra_attempts - v_next_attempt_number),
    'bestScorePercent', greatest(coalesce(v_previous_best, 0), v_score_percent)
  );
end
$$;

revoke all on function public.admin_save_video_quiz(uuid, integer, jsonb, integer) from public, anon;
grant execute on function public.admin_save_video_quiz(uuid, integer, jsonb, integer) to authenticated;
revoke all on function public.submit_video_quiz_attempt(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.submit_video_quiz_attempt(uuid, jsonb, text, uuid) to authenticated;

-- Completion requires the player to confirm full coverage; an estimated
-- duration or an open tab alone must never unlock the next lesson.
create or replace function private.set_video_watch_progress_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_duration_seconds integer;
  v_previous_max integer := 0;
  v_previous_completed boolean := false;
  v_previous_first_watched_at timestamptz;
  v_previous_ended boolean := false;
begin
  select v.organization_id, v.duration_seconds
  into v_organization_id, v_duration_seconds
  from public.videos v
  where v.id = new.video_id;

  if v_organization_id is null then
    raise exception 'Unknown video' using errcode = '23503';
  end if;

  if tg_op = 'UPDATE' then
    v_previous_max := old.max_progress_seconds;
    v_previous_completed := old.completed;
    v_previous_first_watched_at := old.first_watched_at;
    v_previous_ended := old.reported_ended;
  end if;

  if v_duration_seconds is null
    and new.reported_duration_seconds is not null
    and new.reported_duration_seconds > 0 then
    update public.videos
    set duration_seconds = new.reported_duration_seconds
    where id = new.video_id
      and duration_seconds is null;
    v_duration_seconds := new.reported_duration_seconds;
  end if;

  new.organization_id := v_organization_id;
  new.max_progress_seconds := greatest(new.max_progress_seconds, v_previous_max);
  new.reported_ended := v_previous_ended or new.reported_ended;
  new.completed := v_previous_completed or new.reported_ended;
  new.first_watched_at := coalesce(v_previous_first_watched_at, now());
  new.last_watched_at := now();
  new.updated_at := now();

  return new;
end
$$;

commit;
