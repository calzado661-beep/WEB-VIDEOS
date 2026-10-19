# Roles y permisos

El catálogo contiene exactamente cinco roles:

| Rol | Identificador | Acceso |
| --- | --- | --- |
| Administradores | `admin` | Gestión de usuarios, contenido, permisos y configuración de su organización. |
| Operarios | `operator` | Contenido autorizado para este rol. |
| Jefes | `boss` | Contenido autorizado para este rol. |
| Vendedores | `salesperson` | Contenido autorizado para este rol. |
| Gerencia | `management` | Contenido autorizado para este rol. |

Se conservan los identificadores `operator` y `boss` para mantener las cuentas y asignaciones existentes. Gerencia no otorga permisos de administración. Las áreas (Hogar, Tecnología, Almacén 1, etc.) y el cargo siguen siendo datos del perfil; no conceden permisos ni cambian automáticamente el rol.

En **Usuarios**, el administrador puede crear cuentas y cambiar su rol. La cuenta con la que ha iniciado sesión no se puede editar ni deshabilitar desde ese panel. Asignar **Administradores** concede acceso de gestión; el formulario lo indica explícitamente.

Todas las opciones de rol se generan desde `src/data.js`: usuarios, secciones, videos, documentos, vista previa, progreso y cuestionarios muestran los cinco roles.

En **Secciones**, Administradores aparece siempre habilitado. Los otros cuatro roles se activan de forma independiente. Una sección sin destinatarios adicionales queda reservada a administración.

En **Videos**, Administradores tiene una sección de referencia para organizar el contenido, pero conserva acceso total a la biblioteca. Su acceso no admite bloqueo ni video previo obligatorio. Los otros cuatro roles tienen sección, bloqueo y requisitos propios. Si solo está habilitado Administradores, el video se muestra en el grupo **Solo Administradores**.

En **Documentos**, se puede elegir cualquiera de los cinco roles o **Todos los roles de la sección**. **Solo Administradores** reserva el documento a administración y las políticas de Storage también lo protegen. Los otros destinatarios necesitan tener visible la sección.

**Usuarios** incluye búsqueda, estado y filtro por los cinco roles. **Vista por rol** permite simularlos todos sin registrar avance. **Progreso** incluye Administradores, cuenta los videos asignados aunque estén bloqueados y aplica los filtros también a la gráfica. El Excel exporta los usuarios filtrados, conserva sus intentos anteriores y muestra el rol en sus cuatro hojas. La gestión de intentos también permite filtrar por cualquiera de los cinco roles.

## Actualización de la base de datos

Aplicar después de las migraciones anteriores y en este orden:

1. `supabase/migrations/20261019202553_operational_role_values.sql`
2. `supabase/migrations/20261019202600_operational_role_permissions.sql`
3. `supabase/migrations/20261019222833_operational_roles_consistency.sql`

La primera agrega los valores al enum y debe finalizar su transacción antes de usarlos. La segunda amplía el esquema anterior a los cuatro roles de contenido. La tercera completa la representación de los cinco roles, conserva el acceso automático de Administradores, añade la audiencia administrativa para documentos y actualiza el guardado y la gestión de intentos.

Para actualizar desde el SQL Editor sin Supabase CLI, ejecutar `npm run prepare:roles-sql`, abrir `outputs/activate-operational-roles.sql` y pegar todo el contenido en el SQL Editor del proyecto del portal. El archivo agrega los valores del enum en una transacción y aplica directamente la definición final en otra; esta reemplaza la definición intermedia, por lo que el archivo se puede repetir incluso después de haber activado los cinco roles. Este procedimiento manual no registra entradas en el historial de migraciones de la CLI.

Ejecutar `npm run check:supabase-schema` antes de desplegar. La comprobación verifica los valores del enum y la versión 3 de `get_role_configuration`, para detectar una actualización parcial aunque las tablas ya existan. La lectura de usuarios funciona con el esquema anterior. Crear o cambiar a un rol todavía no instalado devuelve `ROLE_SCHEMA_PENDING` antes de crear una cuenta Auth o modificar su contraseña.

Las cuentas actuales, los permisos de los otros roles, bloqueos, requisitos y resultados se conservan. La sección de referencia administrativa se obtiene de las asignaciones existentes. Vendedores y Gerencia empiezan sin acceso al contenido; el administrador debe asignarles secciones y videos y seleccionar los usuarios que tendrán esos roles. No se promueve ninguna cuenta a Administradores a partir del texto de su cargo o área. El `seed.sql` de demostración contempla los cinco roles; no se aplica automáticamente sobre datos existentes.

Desplegar el frontend y las funciones Netlify junto con esta actualización. Tras la migración, recargar las sesiones administrativas que estaban abiertas: el guardado exige las cinco filas de rol por sección y rechaza vistas anteriores de dos o cuatro roles para impedir que borren nuevas asignaciones.

## Validación local

`npm run test:roles` verifica compatibilidad con el esquema anterior, creación y edición de los cinco roles, autorización administrativa, selectores de las pantallas, serialización, permisos compartidos y reportes filtrados.

`npm run test:learning` ejecuta las migraciones en PostgreSQL mediante PGlite y comprueba aislamiento entre roles y organizaciones, documentos y videos exclusivos de administración, Storage, progreso, cuestionarios, requisitos, actualización repetible y guardado atómico. `npm run test:drive-import` verifica que importar desde Drive conserve los cinco roles, los requisitos y la configuración de foto.
