# Aurea Video Hub

Portal privado de videos creado con React + Vite. Incluye cinco roles de contenido: Administradores, Operarios, Jefes, Vendedores y Gerencia. El administrador de la página es un acceso de gestión independiente.

## Ejecutar en Git Bash

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

Para comprobar la conexión configurada con Supabase:

```bash
npm run check:supabase
```

La aplicación lee y guarda videos, secciones, configuración y permisos únicamente en Supabase. No existe almacenamiento local propio para contenido ni para el tema; solo Supabase Auth administra la sesión del usuario y sus contraseñas.

## Funciones incluidas

Cada sección puede tener carpetas con nombre y permisos propios para videos y documentos. Se crean desde **Secciones → Archivos → Nueva carpeta**; allí puedes editar sus permisos, renombrarlas y abrirlas. Los selectores **Ubicación** permiten mover contenido. Eliminar una carpeta devuelve su contenido a la sección principal; no borra los archivos. Un rol necesita acceso a la sección, la carpeta y el contenido para verlo. Consulta [Carpetas y subsecciones](docs/SECTION_FOLDERS.md).

Para activar esta función en Supabase, ejecuta `npm run prepare:folders-sql` y aplica `outputs/activate-section-folders.sql` en el SQL Editor, después de las migraciones operativas anteriores. Incluye las correcciones previas de roles y subida de documentos. Mientras falte la actualización, la aplicación conserva el acceso al contenido existente y deshabilita la creación de carpetas.

Los selectores «Visible para» muestran únicamente los cinco roles de contenido. «Administradores» se puede marcar y desmarcar y no concede gestión de la página. El acceso de gestión conserva el identificador interno `admin`; el nuevo rol de contenido utiliza `administrator` y empieza sin asignaciones. No se cambian automáticamente las cuentas existentes. Para actualizar una base existente, ejecuta `npm run prepare:content-administrator-sql` y aplica `outputs/activate-content-administrator.sql` en el SQL Editor del proyecto configurado, después de las migraciones operativas anteriores. Ese archivo incluye la selección múltiple de documentos y conserva las cuentas y los permisos actuales.

La subida admite seleccionar varios archivos con Ctrl/Shift o arrastrarlos a la zona de carga, con título independiente y límite de 25 MB por archivo. Se suben hasta tres documentos simultáneamente y el contador muestra los archivos procesados. Los archivos confirmados aparecen al terminar cada subida; si alguno falla, queda en la lista con su error para reintentarlo sin duplicar los que ya se guardaron.

Si una subida muestra `new row violates row-level security policy` en una sección que también contiene videos, ejecuta `outputs/repair-document-uploads.sql` en el SQL Editor de Supabase. Reemplaza la regla antigua que exigía una sección exclusiva de documentos; conserva RLS, los usuarios y los roles. La subida sigue limitada al administrador de la página, su organización y las secciones activas.

- Login con usuario y contraseña individuales por persona (Supabase Auth valida la contraseña).
- Panel de administración para crear, editar y deshabilitar cuentas de contenido o gestión. La cuenta del administrador conectado está protegida contra cambios desde este panel.
- Opciones y filtros para los cinco roles en usuarios, contenido, vista previa, progreso y cuestionarios.
- Acceso de gestión independiente del rol Administradores. Los cinco roles de contenido necesitan permisos de sección y asignaciones de videos o documentos.
- Asignación de cada video a un rol y una sección específicos.
- Reproducción integrada de YouTube, Google Drive, Vimeo, Loom y archivos directos MP4/WebM/Ogg.
- Título, descripción, duración y opción de contenido destacado.
- Panel para crear, renombrar, ordenar, ocultar y eliminar secciones.
- Panel para crear, editar, buscar y eliminar videos.
- Configuración general de identidad, bienvenida, ayuda y modo claro.
- Guardado automático transaccional y versionado en Supabase, con lectura al iniciar y al volver a enfocar la página.
- Vista previa de permisos por rol.
- Contenido por rol y reporte Excel de los usuarios filtrados con el rol en sus cuatro hojas.
- Tema negro/dorado y modo claro.
- Diseño responsive para escritorio, tablet y móvil.

## Compilar y desplegar en Netlify

```bash
npm run build
```

El archivo `netlify.toml` ya configura:

- Comando de build: `npm run build`
- Carpeta publicada: `dist`
- Functions: `netlify/functions`
- Redirección SPA hacia `index.html`

En Netlify configura estas variables y vuelve a desplegar:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu-clave-publicable
SUPABASE_SECRET_KEY=tu-clave-secreta
ACCESS_CODE_PEPPER=valor-aleatorio-largo-y-privado
```

`SUPABASE_SECRET_KEY` y `ACCESS_CODE_PEPPER` deben marcarse como secretos y nunca llevar el prefijo `VITE_`. Las dos variables `VITE_*` se incluyen en el cliente por diseño; los secretos solo están disponibles para Netlify Functions. Genera el pepper con al menos 32 bytes aleatorios y mantenlo igual en tu entorno local y en Netlify.

## ¿Es necesario Supabase?

Sí. Esta versión usa Supabase como fuente de verdad para:

- Autenticar usuario y contraseña, y crear la sesión.
- Guardar secciones, videos y asignaciones.
- Aplicar permisos RLS en la base de datos.
- Impedir que los roles de contenido descarguen registros no autorizados.
- Guardar videos privados o generar enlaces temporales cuando corresponda.

Las migraciones versionadas están en [`supabase/migrations`](supabase/migrations), los datos iniciales en [`supabase/seed.sql`](supabase/seed.sql) y la guía de conexión segura en [`docs/SUPABASE.md`](docs/SUPABASE.md).

Antes del primer login ejecuta `npm run provision:admin-user` con `ADMIN_USERNAME` y `ADMIN_PASSWORD` en variables temporales para crear la primera cuenta administradora; las demás cuentas se pueden crear desde el panel de administración.

La actualización a los cinco roles y el orden de sus migraciones se explican en [Roles y permisos](docs/ROLES.md).
