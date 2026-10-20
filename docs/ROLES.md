# Roles y permisos

Hay cinco roles de contenido y un acceso independiente para gestionar la página:

| Rol | Identificador | Acceso |
| --- | --- | --- |
| Administrador de la página | `admin` | Gestiona usuarios, contenido, permisos y configuración de su organización. |
| Administradores | `administrator` | Solo el contenido asignado; no permite gestionar la página. |
| Operarios | `operator` | Solo el contenido asignado. |
| Jefes | `boss` | Solo el contenido asignado. |
| Vendedores | `salesperson` | Solo el contenido asignado. |
| Gerencia | `management` | Solo el contenido asignado; no permite gestionar la página. |

El rol Administradores es un título de usuario, igual que los otros roles de contenido. Se puede marcar y desmarcar en Secciones, asignar a videos y seleccionar para documentos. Necesita una sección visible, respeta bloqueos y requisitos de aprendizaje y no puede crear usuarios ni guardar configuraciones administrativas.

El administrador de la página no aparece como una casilla de visibilidad. Conserva acceso de gestión automático para administrar el contenido. Las cuentas que ya tenían el identificador `admin` mantienen sus permisos; no se convierten automáticamente al nuevo rol de contenido. El cargo o área del perfil no concede permisos.

En Usuarios, el selector distingue **Administradores** de **Administrador de la página** y explica sus permisos. La cuenta del administrador conectado no se puede modificar ni deshabilitar desde este panel. Los reportes y filtros de usuarios contemplan ambos accesos y los demás roles.

Los permisos de contenido se definen por separado para cada rol. Una sección desmarcada oculta también sus documentos y videos para ese rol. Los documentos permiten varios destinatarios y cada video tiene sus propias asignaciones, bloqueos y requisitos. Sin destinatarios, el contenido queda reservado al panel de gestión.

## Actualización de la base de datos

Tras las migraciones operativas anteriores, aplicar en orden:

1. `20261020140818_document_multiple_audiences.sql`
2. `20261020161159_content_administrator_role_value.sql`
3. `20261020161224_content_administrator_permissions.sql`
4. `20261020162833_repair_document_upload_policy.sql`

La adición al enum debe confirmarse en una transacción independiente antes de usar el nuevo valor. La última migración agrega filas ocultas para el rol nuevo sin cambiar las asignaciones existentes. No transforma usuarios ni les concede gestión. Las políticas RLS existentes siguen reservando la gestión al identificador `admin`.

Para el SQL Editor, ejecutar `npm run prepare:content-administrator-sql` y pegar el contenido de `outputs/activate-content-administrator.sql`. El archivo mantiene el orden y las transacciones necesarias e incluye la actualización de selección múltiple. No registra entradas en el historial de migraciones de la CLI. Requiere las migraciones operativas de octubre de 2026 ya instaladas; para una base nueva, aplicar todas las migraciones en orden.

Ejecutar `npm run check:supabase-schema` antes de desplegar. Comprueba los valores esperados y la versión 4 de `get_role_configuration` para detectar una activación parcial. Crear o cambiar a un rol aún no instalado devuelve `ROLE_SCHEMA_PENDING` antes de crear cuentas Auth o modificar contraseñas.

Desplegar el frontend y las funciones Netlify con la actualización. Después de aplicarla, recargar las sesiones de gestión abiertas: el guardado exige las seis filas de rol por sección y rechaza los clientes anteriores para evitar que borren nuevas asignaciones.

## Validación

`npm run test:roles` comprueba selectores, creación de cuentas, serialización, compatibilidad con esquemas anteriores, permisos y reportes. `npm run test:learning` ejecuta las migraciones en PostgreSQL mediante PGlite y verifica RLS, aislamiento entre roles y organizaciones, Storage, cuestionarios, progreso y guardado atómico. Incluye una comprobación específica de que `administrator` no obtiene permisos de gestión.

`npm run test:documents` verifica la carga de varios archivos y el reintento de fallos sin duplicar documentos confirmados. `npm run test:drive-import` comprueba que importar desde Drive conserva las asignaciones de los roles.
