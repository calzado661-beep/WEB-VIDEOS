# Carpetas dentro de secciones

La navegación tiene dos niveles: **Sección → Carpeta → Videos y documentos**. El contenido puede permanecer directamente en la sección o ubicarse en una carpeta.

## Gestión

1. Abre Secciones y pulsa el botón de archivos de una sección.
2. Pulsa Nueva carpeta, escribe su nombre y marca los roles de contenido.
3. Guarda la carpeta. El guardado automático confirma su existencia antes de habilitar la subida de archivos.
4. Abre la carpeta para agregar videos o subir varios documentos. Para mover un documento existente, pulsa su Ubicación, selecciona una subcarpeta de la sección y confirma con Mover aquí. La misma ventana permite devolverlo a la sección principal o elegir otra de sus subcarpetas. Los videos tienen su selector de Ubicación en la lista de archivos.
5. Los botones de editar permiten renombrar la carpeta y cambiar sus roles. El nombre debe ser único dentro de la sección.

Al eliminar una carpeta, sus videos y documentos vuelven a la sección principal. Se conservan los archivos, títulos, audiencias de documentos, bloqueos y requisitos de videos. La confirmación avisa que el contenido pasará a usar los permisos de su sección principal. Una sección con carpetas no se puede eliminar hasta retirar sus carpetas.

Los usuarios ven las carpetas autorizadas dentro de su sección, con navegación para entrar y volver. La búsqueda solo incluye el contenido autorizado. No se permite anidar una carpeta dentro de otra.

En Subir documentos, primero se elige la sección principal. Si tiene carpetas, aparece el selector Subcarpeta; si no tiene, el campo completo se oculta. La opción Guardar directamente en la sección permite subir sin carpeta. Cambiar de sección limpia la subcarpeta anterior. Al abrir la subida desde una carpeta, esa carpeta es el destino fijo.

## Permisos

El acceso es la intersección de los permisos de sección, carpeta y contenido. Tener acceso a la carpeta no concede acceso a su sección principal. Desmarcar el rol en la sección oculta todas sus carpetas, incluso si conservan ese rol marcado para una futura habilitación.

Videos, documentos, cuestionarios, fuentes de reproducción y objetos privados de Storage respetan este acceso en la base de datos. El administrador de la página mantiene la gestión del contenido. El rol normal Administradores sigue siendo un rol de lectura, sin gestión.

## Activación

Ejecuta `npm run prepare:folders-sql` y pega todo `outputs/activate-section-folders.sql` en el SQL Editor del proyecto Supabase del portal. Requiere las migraciones operativas anteriores ya instaladas; incluye las actualizaciones de roles, documentos y carpetas. Recarga las sesiones abiertas al terminar. No se cambian usuarios ni se mueven archivos existentes durante la activación.

La migración añade `sections.parent_id` y conserva el guardado atómico con revisión y bloqueo. Los clientes anteriores no pueden sobrescribir una jerarquía existente. Las validaciones rechazan ciclos, padres de otra organización y carpetas dentro de carpetas. El SQL se puede repetir sin borrar la jerarquía.

`npm run check:supabase-schema` verifica la columna nueva. `npm run test:folders` comprueba permisos y conservación del contenido; `npm run test:learning` ejecuta RLS y el guardado real en PostgreSQL. También se prueba el flujo de crear, editar, abrir, eliminar y mover contenido en un DOM montado durante la verificación de interfaz.
