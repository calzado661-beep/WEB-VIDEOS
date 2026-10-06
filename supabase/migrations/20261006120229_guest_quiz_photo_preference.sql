begin;

alter table public.profiles
  add column require_quiz_photo_override boolean;

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

  select coalesce(p.require_quiz_photo_override, s.require_quiz_photo, false) into v_require_photo
  from public.profiles p
  join public.app_settings s on s.organization_id = p.organization_id
  where p.user_id = v_user_id and p.organization_id = v_organization_id;

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

revoke all on function public.submit_video_quiz_attempt(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.submit_video_quiz_attempt(uuid, jsonb, text, uuid) to authenticated;

commit;
