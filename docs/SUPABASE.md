# Conexión segura con Supabase

## Arquitectura recomendada

```text
organizations ── app_settings
      │
      ├── profiles ── auth.users
      ├── sections ── section_roles
      └── videos ── video_assignments
              └── video_sources
```

Las políticas RLS deben ser la autoridad. React puede ocultar elementos para mejorar la interfaz, pero nunca debe decidir por sí solo qué datos puede descargar una sesión.

La fuente del video está separada de sus metadatos. Un usuario puede recibir la tarjeta de un video bloqueado desde `videos` y `video_assignments`, pero RLS impide que lea `video_sources` hasta que `is_locked` sea falso para su rol.

## Migraciones

El esquema completo está en:

```text
supabase/migrations/20260804000000_video_hub_schema.sql
supabase/migrations/20260804010000_require_code_sessions.sql
supabase/migrations/20260804020000_atomic_admin_snapshot.sql
supabase/migrations/20260806000000_username_password_auth.sql
```

Incluye:

- Organizaciones y configuración visual.
- Perfiles `admin`, `operator` y `boss`.
- Secciones visibles independientemente por rol.
- Metadatos, fuentes y asignaciones de videos.
- Bloqueo independiente por rol sin filtrar el enlace.
- Auditoría preparada para eventos administrativos.
- Índices de códigos en esquema privado, sin texto plano.
- Bucket privado `video-assets` y políticas de Storage.
- Restricciones, índices, triggers de actualización y RLS.
- Guardado administrativo atómico y versionado: secciones, videos, fuentes, permisos y configuración se confirman juntos o se revierten juntos; una pestaña antigua no puede sobrescribir otra más reciente.
- Eliminación recuperable: la RPC archiva secciones y videos omitidos en vez de destruir sus relaciones históricas.

Para aplicarlo con el flujo recomendado:

```bash
npx supabase login
npx supabase link --project-ref mlrjcxxwzjqzdebqpfpx
npx supabase db push --dry-run
npx supabase db push
```

Después, carga `supabase/seed.sql` si quieres iniciar con las secciones y videos de ejemplo. Verifica el resultado con:

```bash
npm run check:supabase-schema
```

Si el comando muestra `PENDIENTE`, aplica en orden las migraciones indicadas y ejecútalo nuevamente; las tablas pueden estar disponibles mientras las RPC de hardening aún no lo están.

La clave publicable y la secret key de API no sustituyen el acceso administrativo de migraciones. `db push` necesita una sesión de Supabase y puede solicitar la contraseña de PostgreSQL.

## Acceso con usuario y contraseña

Cada persona tiene su propia cuenta (`public.profiles.username`) respaldada por una cuenta real de Supabase Auth con contraseña propia:

1. React envía `{ username, password }` a la Netlify Function `login-with-password`.
2. La función busca el perfil por `username` con el cliente `service_role` (que ignora RLS) y obtiene el correo interno asociado a esa cuenta.
3. La función llama a `signInWithPassword` de Supabase Auth con ese correo y la contraseña recibida; Supabase Auth valida el hash de la contraseña directamente, sin trucos de magic link.
4. La función verifica que el contexto de la sesión (`get_my_access_context`) coincide con el perfil esperado antes de devolver los tokens.
5. React instala la sesión recibida y carga los datos permitidos.
6. Todas las lecturas y escrituras posteriores quedan limitadas por `profiles` y las políticas RLS.

No guardes contraseñas, la clave secreta ni la clave `service_role` en variables `VITE_*`: cualquier variable con ese prefijo termina en el JavaScript público.

En el frontend solo deben existir:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu-clave-publicable
```

Los secretos de servidor deben configurarse en Netlify, sin prefijo `VITE_`:

```text
SUPABASE_SECRET_KEY
ACCESS_CODE_PEPPER
```

`ACCESS_CODE_PEPPER` se sigue usando para las huellas HMAC del limitador de intentos por usuario/IP (`private.access_attempts`), aunque las contraseñas ya no dependen de él. Debe ser un valor aleatorio de al menos 32 bytes y distinto de las claves de Supabase.

> **Deprecado**: la tabla `private.role_access_codes` y las RPC `service_lookup_access_code`, `service_upsert_access_code` y `service_rotate_access_codes` pertenecen al esquema anterior de "un código por rol". Ya no se usan en el login ni en el panel de administración, pero se mantienen en el esquema sin eliminarlas para no forzar una migración destructiva.

La migración `20260804010000_require_code_sessions.sql` restringía `current_role()`/`current_organization_id()`/`get_my_access_context()` a sesiones creadas por OTP (magic link), que era como funcionaba el login por código. La migración `20260806000000_username_password_auth.sql` reemplaza ese candado por uno equivalente para sesiones de contraseña (`amr` method `password`), que es lo que emite `signInWithPassword` en `login-with-password`.

## Aprovisionar la cuenta administradora

Después de aplicar las migraciones (incluida `20260806000000_username_password_auth.sql`) y `supabase/seed.sql`, crea o actualiza la cuenta admin con:

```bash
ADMIN_USERNAME='admin' \
ADMIN_PASSWORD='una-contraseña-larga-y-propia' \
npm run provision:admin-user
```

En PowerShell, establece esas variables con `$env:NOMBRE='valor'` y luego ejecuta el mismo comando npm. El script lee la URL y las claves desde el entorno o `.env`, crea o actualiza la cuenta Auth del administrador con esa contraseña real, y sincroniza su fila en `public.profiles` (`role: 'admin'`, `username`).

El correo interno se genera con un valor no entregable (`video-hub-admin@accounts.invalid` por defecto; personalízalo con `ADMIN_AUTH_EMAIL`). No guardes la contraseña en Git ni la configures como variable `VITE_*`; elimínala del entorno después del aprovisionamiento.

Después de aprovisionar la primera cuenta administradora, las cuentas con los cinco roles (**Administradores**, **Operarios**, **Jefes**, **Vendedores** y **Gerencia**) se crean, editan y deshabilitan desde el panel **Usuarios**. Consulta [Roles y permisos](ROLES.md) para las migraciones y la configuración de acceso.

## Reglas mínimas

- Las contraseñas nuevas exigen al menos 8 caracteres; usa 16 o más para administrador.
- Error genérico ante usuario o contraseña incorrectos, sin revelar cuál falló.
- Límite separado por usuario e IP; añade CAPTCHA si el portal estará expuesto a tráfico público no confiable.
- Peticiones de login JSON y mismo sitio; el endpoint rechaza envíos `cross-site` del navegador.
- Registro público desactivado; solo un administrador puede crear cuentas nuevas.
- Deshabilitar un usuario (`profiles.active = false`) le retira el acceso a los datos de inmediato vía RLS, aunque su JWT siga vigente unos minutos.
- Cuenta individual y MFA para administradores si el sistema tendrá información sensible.

## Videos realmente privados

RLS protege el registro del video, pero no convierte en privado un enlace público de YouTube, Vimeo o Google Drive. Si el material no debe compartirse, usa un bucket privado de Supabase Storage y URLs firmadas de corta duración, o un proveedor de streaming privado.

El administrador debe pegar una URL permitida. La aplicación normaliza el ID de YouTube, Drive, Vimeo o Loom y crea el reproductor; nunca debe aceptar HTML de iframe proporcionado por el usuario.

## Documentación oficial

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Generar magic links en servidor](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
- [Variables de entorno de Netlify Functions](https://docs.netlify.com/build/functions/environment-variables/)
- [Desplegar Vite en Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
