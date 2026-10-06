import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Real PostgreSQL execution, with only the external Supabase Auth/Storage
// surfaces stubbed. Application functions, triggers, permissions and RLS are
// loaded from the repository migrations.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = id(1), section = id(2), admin = id(3), alice = id(4), bob = id(5), boss = id(6), outsider = id(7)
const first = id(11), second = id(12), third = id(13), free = id(14)

test('secuencias e intentos en PostgreSQL', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"amr":[{"method":"password"}]}'::jsonb $$;
    grant usage on schema auth to authenticated, anon;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  `)
  const migrations = [
    '20260804000000_video_hub_schema.sql', '20260804010000_require_code_sessions.sql',
    '20260804020000_atomic_admin_snapshot.sql', '20260806000000_username_password_auth.sql',
    '20260806010000_video_watch_progress.sql', '20260807000000_video_progress_duration_backfill.sql',
    '20260817000000_video_quiz.sql', '20260817010000_watch_progress_full_completion.sql',
    '20260818000000_quiz_attempts_and_profile_fields.sql', '20260819000000_quiz_camera_capture.sql',
    '20260909193654_section_documents.sql', '20261002000000_mixed_section_files.sql',
    '20261004000000_document_audience.sql', '20261004010000_video_learning_paths.sql',
    '20261006120229_guest_quiz_photo_preference.sql',
  ]
  for (const name of migrations) {
    const sql = (await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'))
      .replace('create extension if not exists pgcrypto;', '') // gen_random_uuid is built into PG.
    try { await db.exec(sql) } catch (error) { throw new Error(`Migración ${name}: ${error.message}`, { cause: error }) }
  }
  const query = async (sql, args = []) => (await db.query(sql, args)).rows
  const asUser = async (user) => {
    await db.exec('set role authenticated')
    await query("select set_config('request.jwt.claim.sub', $1, false)", [user])
  }
  const rejects = async (sql, args, pattern) => {
    await db.exec('savepoint expected_failure')
    await assert.rejects(query(sql, args), pattern)
    await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure')
  }
  await query('insert into public.organizations(id,name,slug) values ($1,$2,$3),($4,$5,$6)', [org, 'Demo', 'demo', id(8), 'Other', 'other'])
  for (const [user, role, organization] of [[admin, 'admin', org], [alice, 'operator', org], [bob, 'operator', org], [boss, 'boss', org], [outsider, 'admin', id(8)]]) {
    await query('insert into auth.users(id) values ($1)', [user])
    await query('insert into public.profiles(user_id,organization_id,role) values ($1,$2,$3)', [user, organization, role])
  }
  await query('insert into public.sections(id,organization_id,name,slug) values ($1,$2,$3,$4)', [section, org, 'Section', 'section'])
  for (const role of ['operator', 'boss']) await query('insert into public.section_roles(section_id,organization_id,role,visible) values ($1,$2,$3,true) on conflict(section_id,role) do update set visible=true', [section, org, role])
  for (const [video, title] of [[first, 'Video 1'], [second, 'Video 2'], [third, 'Video 3'], [free, 'Libre']]) {
    await query('insert into public.videos(id,organization_id,title,duration_seconds) values ($1,$2,$3,60)', [video, org, title])
    await query("insert into public.video_sources(video_id,provider,source_ref,source_url) values ($1,'direct','https://example.test/video.mp4','https://example.test/video.mp4')", [video])
    for (const role of ['operator', 'boss']) await query('insert into public.video_assignments(video_id,organization_id,role,section_id) values ($1,$2,$3,$4)', [video, org, role, section])
  }
  await asUser(admin)
  const questions = [{ prompt: 'Pregunta', options: [{ label: 'Correcta', isCorrect: true }, { label: 'Incorrecta', isCorrect: false }] }]
  for (const video of [first, second, free]) await query('select public.admin_save_video_quiz($1,70,$2,3)', [video, JSON.stringify(questions)])
  await query("update public.video_assignments set prerequisite_video_id=$1 where video_id=$2 and role='operator'", [first, second])
  await query("update public.video_assignments set prerequisite_video_id=$1 where video_id=$2 and role='operator'", [second, third])
  await query('select private.validate_learning_paths($1)', [org])
  await db.exec('reset role')
  const definitions = new Map()
  for (const video of [first, second, free]) {
    const [q] = await query('select q.id, (select id from private.quiz_question_options where question_id=q.id and is_correct) as correct, (select id from private.quiz_question_options where question_id=q.id and not is_correct limit 1) as wrong from private.quiz_questions q where video_id=$1', [video])
    definitions.set(video, q)
  }
  const answer = (video, correct = true) => JSON.stringify([{ questionId: definitions.get(video).id, optionId: definitions.get(video)[correct ? 'correct' : 'wrong'] }])
  const submit = async (video, correct = true) => (await query('select public.submit_video_quiz_attempt($1,$2,null) as result', [video, answer(video, correct)]))[0].result
  const watch = async (video, user = alice, ended = true) => query('insert into public.video_watch_progress(video_id,user_id,max_progress_seconds,reported_ended) values ($1,$2,60,$3) on conflict(video_id,user_id) do update set reported_ended=excluded.reported_ended', [video, user, ended])
  const playable = async (video) => (await query('select private.can_play_video($1) as ok', [video]))[0].ok
  const subtest = async (name, fn) => t.test(name, async () => {
    await db.exec('begin')
    try { await fn() } finally { await db.exec('rollback; reset role') }
  })

  await subtest('la foto del cuestionario se puede configurar para un usuario', async () => {
    await query('insert into public.app_settings(organization_id,require_quiz_photo) values ($1,true)', [org])
    await query('update public.profiles set require_quiz_photo_override=false where user_id=$1', [alice])
    await asUser(alice)
    await watch(first)
    assert.equal((await submit(first)).passed, true)
    await asUser(bob)
    await watch(first, bob)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /foto/)
    await db.exec('reset role')
    await query('update public.app_settings set require_quiz_photo=false where organization_id=$1', [org])
    await query('update public.profiles set require_quiz_photo_override=true where user_id=$1', [bob])
    await asUser(bob)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /foto/)
  })

  await subtest('la tarjeta sigue visible pero la fuente y el progreso están bloqueados', async () => {
    await asUser(alice)
    assert.equal(await playable(first), true)
    assert.equal(await playable(second), false)
    assert.equal(await playable(free), true)
    assert.equal((await query('select id from public.videos where id=$1', [second])).length, 1)
    assert.equal((await query('select video_id from public.video_sources where video_id=$1', [second])).length, 0)
    await rejects('insert into public.video_watch_progress(video_id,user_id,max_progress_seconds,reported_ended) values ($1,$2,60,true)', [second, alice], /row-level security/)
  })
  await subtest('requiere final confirmado y aprobación; desbloqueo por usuario y rol', async () => {
    await asUser(alice)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /completar el video/)
    await watch(first, alice, false)
    assert.equal((await query('select completed from public.video_watch_progress where video_id=$1', [first]))[0].completed, false)
    await watch(first)
    assert.equal(await playable(second), false)
    assert.equal((await submit(first)).passed, true)
    assert.equal(await playable(second), true)
    assert.equal(await playable(third), false)
    await watch(second)
    await submit(second)
    assert.equal(await playable(third), true)
    await asUser(bob)
    assert.equal(await playable(second), false)
    await asUser(boss)
    assert.equal(await playable(second), true)
  })
  await subtest('límite, permiso exclusivo del admin y un solo intento adicional', async () => {
    await asUser(alice)
    await watch(first)
    for (let n = 1; n <= 3; n++) assert.equal((await submit(first, false)).attemptsCount, n)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /Agotaste/)
    await rejects('select public.admin_grant_quiz_attempt($1,$2)', [first, alice], /No autorizado/)
    await asUser(outsider)
    await rejects('select public.admin_grant_quiz_attempt($1,$2)', [first, alice], /No autorizado/)
    await asUser(admin)
    assert.equal((await query('select public.admin_grant_quiz_attempt($1,$2) as result', [first, alice]))[0].result.remainingAttempts, 1)
    await rejects('select public.admin_grant_quiz_attempt($1,$2)', [first, alice], /Solo se puede habilitar/)
    await asUser(alice)
    assert.equal((await submit(first, false)).remainingAttempts, 0)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /Agotaste/)
    assert.equal((await query('select count(*)::int as total from public.video_quiz_attempts where video_id=$1', [first]))[0].total, 4)
    await asUser(admin)
    assert.equal((await query("select count(*)::int as total from public.audit_events where action='quiz_attempt_granted'"))[0].total, 1)
  })
  await subtest('un intento habilitado no afecta a otro usuario ni a otro cuestionario', async () => {
    await db.exec('reset role')
    for (const [video, user] of [[first, alice], [first, bob], [free, alice]]) {
      await query('insert into public.video_quiz_results(video_id,user_id,organization_id,attempts_count) values ($1,$2,$3,3)', [video, user, org])
    }
    await asUser(admin)
    await query('select public.admin_grant_quiz_attempt($1,$2)', [first, alice])
    const rows = await query('select video_id,user_id,extra_attempts from public.video_quiz_results')
    assert.equal(rows.filter((row) => row.extra_attempts > 0).length, 1)
    assert.equal(rows.find((row) => row.extra_attempts === 1).user_id, alice)
  })
  await subtest('rechaza ciclos, ausencia de cuestionario y eliminación del requisito', async () => {
    await asUser(admin)
    await query("update public.video_assignments set prerequisite_video_id=$1 where video_id=$2 and role='operator'", [second, first])
    await rejects('select private.validate_learning_paths($1)', [org], /ciclo/)
    await query("update public.video_assignments set prerequisite_video_id=null where video_id=$1 and role='operator'", [first])
    await rejects('select public.admin_delete_video_quiz($1)', [first], /requisito de otro video/)
    await query('update public.videos set active=false where id=$1', [first])
    await rejects('select private.validate_learning_paths($1)', [org], /debe estar publicado/)
    await asUser(alice)
    assert.equal(await playable(second), false)
  })
  await subtest('guardar un cuestionario requerido conserva intentos y cupos', async () => {
    await asUser(alice)
    await watch(first)
    await submit(first, false)
    await asUser(admin)
    await query('select public.admin_save_video_quiz($1,80,$2,2)', [first, JSON.stringify(questions)])
    const [result] = await query('select attempts_count,extra_attempts from public.video_quiz_results where video_id=$1', [first])
    assert.equal(result.attempts_count, 1)
    assert.equal(result.extra_attempts, 0)
    assert.equal((await query('select public.admin_get_video_quiz($1) as quiz', [first]))[0].quiz.maxAttempts, 2)
  })
  await subtest('historial antiguo por encima del nuevo límite recibe exactamente un intento', async () => {
    await db.exec('reset role')
    await query('insert into public.video_quiz_results(video_id,user_id,organization_id,attempts_count) values ($1,$2,$3,10)', [first, alice, org])
    await asUser(admin)
    const result = (await query('select public.admin_grant_quiz_attempt($1,$2) as result', [first, alice]))[0].result
    assert.equal(result.extraAttempts, 8)
    assert.equal(result.remainingAttempts, 1)
  })
  await subtest('el guardado completo persiste requisitos y revierte un ciclo junto con la revisión', async () => {
    await asUser(admin)
    const [snapshotRow] = await query(`select jsonb_build_object(
      'organization', 'Demo',
      'sections', (select jsonb_agg(to_jsonb(s)) from public.sections s where organization_id=$1),
      'section_roles', (select jsonb_agg(to_jsonb(s)) from public.section_roles s where organization_id=$1),
      'videos', (select jsonb_agg(to_jsonb(v)) from public.videos v where organization_id=$1),
      'video_sources', (select jsonb_agg(to_jsonb(s)) from public.video_sources s),
      'video_assignments', (select jsonb_agg(to_jsonb(a)) from public.video_assignments a where organization_id=$1)
    ) as snapshot`, [org])
    const snapshot = snapshotRow.snapshot
    const revision = Number((await query('select content_revision from public.organizations where id=$1', [org]))[0].content_revision)
    const assignment = snapshot.video_assignments.find((row) => row.video_id === second && row.role === 'operator')
    assignment.prerequisite_video_id = free
    const next = Number((await query('select public.save_admin_snapshot($1,$2) as revision', [JSON.stringify(snapshot), revision]))[0].revision)
    assert.equal(next, revision + 1)
    assert.equal((await query("select prerequisite_video_id from public.video_assignments where video_id=$1 and role='operator'", [second]))[0].prerequisite_video_id, free)
    snapshot.video_assignments.find((row) => row.video_id === free && row.role === 'operator').prerequisite_video_id = second
    await rejects('select public.save_admin_snapshot($1,$2)', [JSON.stringify(snapshot), next], /ciclo/)
    assert.equal(Number((await query('select content_revision from public.organizations where id=$1', [org]))[0].content_revision), next)
    assert.equal((await query("select prerequisite_video_id from public.video_assignments where video_id=$1 and role='operator'", [free]))[0].prerequisite_video_id, null)
  })
  await subtest('respuestas inválidas no consumen intentos y un aprobado no puede seguir enviando', async () => {
    await asUser(alice)
    await watch(first)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, JSON.stringify([{ questionId: definitions.get(first).id, optionId: definitions.get(second).correct }])], /todas las preguntas/)
    assert.equal((await query('select attempts_count from public.video_quiz_results where video_id=$1', [first])).length, 0)
    await submit(first)
    await rejects('select public.submit_video_quiz_attempt($1,$2,null)', [first, answer(first)], /Ya aprobaste/)
    await asUser(admin)
    await rejects('select public.admin_grant_quiz_attempt($1,$2)', [first, alice], /Solo se puede habilitar/)
    await query("update public.video_assignments set is_locked=true where video_id=$1 and role='operator'", [second])
    await asUser(alice)
    assert.equal(await playable(second), false)
  })
  await subtest('reintentar el mismo envío de red no consume otro intento', async () => {
    await asUser(alice)
    await watch(first)
    const args = [first, answer(first, false), id(90)]
    const original = (await query('select public.submit_video_quiz_attempt($1,$2,null,$3) as result', args))[0].result
    const repeated = (await query('select public.submit_video_quiz_attempt($1,$2,null,$3) as result', args))[0].result
    assert.deepEqual(repeated, original)
    assert.equal((await query('select attempts_count from public.video_quiz_results where video_id=$1', [first]))[0].attempts_count, 1)
  })
})
