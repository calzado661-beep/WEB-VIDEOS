begin;

insert into public.organizations (id, name, slug, logo_url, active)
values (
  '10000000-0000-4000-8000-000000000001',
  'Almacén de Remates',
  'almacen-de-remates',
  '/brand/almacen-remates-web.png',
  true
)
on conflict (id) do update
set name = excluded.name,
    slug = excluded.slug,
    logo_url = excluded.logo_url,
    active = excluded.active;

insert into public.app_settings (
  organization_id,
  product_name,
  welcome_title,
  welcome_message,
  support_message,
  allow_light_mode
)
values (
  '10000000-0000-4000-8000-000000000001',
  'Video Hub',
  'Todo lo que necesitas aprender, en un solo lugar.',
  'Accede a videos, procesos y recursos seleccionados especialmente para tu función.',
  'Contacta a tu administrador',
  true
)
on conflict (organization_id) do update
set product_name = excluded.product_name,
    welcome_title = excluded.welcome_title,
    welcome_message = excluded.welcome_message,
    support_message = excluded.support_message,
    allow_light_mode = excluded.allow_light_mode;

insert into public.sections (
  id,
  organization_id,
  name,
  slug,
  icon,
  sort_order,
  active
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Operaciones',
    'operaciones',
    'layers',
    0,
    true
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'Seguridad',
    'seguridad',
    'shield',
    1,
    true
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'Liderazgo',
    'liderazgo',
    'briefcase',
    2,
    true
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'Actualizaciones',
    'actualizaciones',
    'sparkles',
    3,
    true
  )
on conflict (id) do update
set name = excluded.name,
    slug = excluded.slug,
    icon = excluded.icon,
    sort_order = excluded.sort_order,
    active = excluded.active;

insert into public.section_roles (section_id, organization_id, role, visible)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'operator', true),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'boss', false),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'operator', true),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'boss', true),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'operator', false),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'boss', true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'operator', true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'boss', true),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'salesperson', true),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'management', false),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'salesperson', true),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'management', true),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'salesperson', false),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'management', true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'salesperson', true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'management', true)
on conflict (section_id, role) do update
set visible = excluded.visible;

insert into public.videos (
  id,
  organization_id,
  title,
  description,
  duration_label,
  featured,
  active,
  created_at
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'Bienvenida al equipo',
    'Una introducción breve a la cultura, los valores y la manera en que trabajamos juntos.',
    '2:12',
    true,
    true,
    '2026-08-01T10:00:00.000Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'Protocolo de trabajo seguro',
    'Pasos esenciales que debes completar antes de iniciar una operación en campo.',
    '4:18',
    false,
    true,
    '2026-07-28T10:00:00.000Z'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'Liderazgo con propósito',
    'Herramientas prácticas para comunicar prioridades, acompañar al equipo y tomar decisiones.',
    '8:40',
    true,
    true,
    '2026-07-25T10:00:00.000Z'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'Novedades de la semana',
    'Resumen de cambios, recordatorios y próximos hitos importantes para toda la organización.',
    '3:05',
    false,
    true,
    '2026-08-03T10:00:00.000Z'
  )
on conflict (id) do update
set title = excluded.title,
    description = excluded.description,
    duration_label = excluded.duration_label,
    featured = excluded.featured,
    active = excluded.active;

insert into public.video_sources (
  video_id,
  provider,
  source_ref,
  source_url,
  thumbnail_url
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    'youtube',
    'ysz5S6PUM-U',
    'https://www.youtube.com/watch?v=ysz5S6PUM-U',
    'https://i.ytimg.com/vi/ysz5S6PUM-U/hqdefault.jpg'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'direct',
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    null
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    'vimeo',
    '863362136',
    'https://vimeo.com/863362136',
    null
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    'direct',
    'https://www.w3schools.com/html/mov_bbb.mp4',
    'https://www.w3schools.com/html/mov_bbb.mp4',
    null
  )
on conflict (video_id) do update
set provider = excluded.provider,
    source_ref = excluded.source_ref,
    source_url = excluded.source_url,
    thumbnail_url = excluded.thumbnail_url,
    storage_bucket = null,
    storage_object_path = null,
    metadata = '{}'::jsonb;

insert into public.video_assignments (
  video_id,
  organization_id,
  role,
  section_id,
  visible,
  is_locked,
  sort_order
)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'operator', '20000000-0000-4000-8000-000000000001', true, false, 0),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'boss', '20000000-0000-4000-8000-000000000003', true, false, 0),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'operator', '20000000-0000-4000-8000-000000000002', true, false, 0),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'boss', '20000000-0000-4000-8000-000000000003', true, false, 1),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'operator', '20000000-0000-4000-8000-000000000004', true, false, 0),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'boss', '20000000-0000-4000-8000-000000000004', true, false, 0),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'salesperson', '20000000-0000-4000-8000-000000000001', true, false, 0),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'management', '20000000-0000-4000-8000-000000000003', true, false, 0),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'salesperson', '20000000-0000-4000-8000-000000000002', true, false, 0),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'management', '20000000-0000-4000-8000-000000000002', true, false, 0),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'management', '20000000-0000-4000-8000-000000000003', true, false, 0),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'salesperson', '20000000-0000-4000-8000-000000000004', true, false, 0),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'management', '20000000-0000-4000-8000-000000000004', true, false, 0),
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'admin', '20000000-0000-4000-8000-000000000001', true, false, 0),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'admin', '20000000-0000-4000-8000-000000000002', true, false, 0),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'admin', '20000000-0000-4000-8000-000000000003', true, false, 0),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'admin', '20000000-0000-4000-8000-000000000004', true, false, 0)
on conflict (video_id, role) do update
set section_id = excluded.section_id,
    visible = excluded.visible,
    is_locked = excluded.is_locked,
    sort_order = excluded.sort_order;

commit;
