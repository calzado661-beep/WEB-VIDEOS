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

En **Secciones**, se activa la visibilidad para uno o varios de los cuatro roles de contenido. En **Videos**, cada rol tiene su propia sección, bloqueo manual y video previo obligatorio. En **Documentos**, se puede elegir un rol o todos los roles habilitados en la sección. La vista previa, los indicadores de progreso y el reporte Excel contemplan los cuatro roles de contenido.

## Actualización de la base de datos

Aplicar después de las migraciones anteriores y en este orden:

1. `supabase/migrations/20261019202553_operational_role_values.sql`
2. `supabase/migrations/20261019202600_operational_role_permissions.sql`

La primera migración agrega valores al enum y debe finalizar su transacción antes de ejecutar la segunda. La segunda amplía las restricciones, crea las filas de permisos de los nuevos roles para las secciones existentes y actualiza el guardado atómico.

Para ejecutarlas desde el SQL Editor sin Supabase CLI, ejecutar `npm run prepare:roles-sql`, abrir `outputs/activate-operational-roles.sql` y pegar todo el contenido en el SQL Editor del proyecto del portal. El archivo conserva las dos transacciones. Este procedimiento manual no registra entradas en el historial de migraciones de la CLI.

Ejecutar `npm run check:supabase-schema` antes de desplegar. La comprobación falla si falta alguno de los valores del enum, aunque las tablas ya existan. La lectura de usuarios funciona con el esquema anterior para que una migración pendiente no impida administrar las cuentas existentes.

Las cuentas actuales y sus permisos se conservan. Vendedores y Gerencia empiezan sin acceso al contenido; el administrador debe asignarles secciones y videos y seleccionar los usuarios que tendrán esos roles. No se promueve ninguna cuenta a Administradores a partir del texto de su cargo o área.

Desplegar el frontend y las funciones Netlify junto con esta actualización. Tras la migración, recargar las sesiones administrativas que estaban abiertas: el guardado rechaza las vistas antiguas de solo dos roles para impedir que borren las nuevas asignaciones.

## Validación local

`npm run test:roles` verifica la lectura de usuarios con el esquema anterior y el nuevo, la creación y edición de los cinco roles, el rechazo de roles ajenos al catálogo, la protección de la cuenta propia y la autorización administrativa.

`npm run test:learning` ejecuta las migraciones en PostgreSQL mediante PGlite y comprueba aislamiento entre roles y organizaciones, documentos, progreso, cuestionarios, requisitos y guardado atómico.
