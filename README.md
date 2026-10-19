# Aurea Video Hub

Portal privado de videos creado con React + Vite. Incluye cinco roles: Administradores, Operarios, Jefes, Vendedores y Gerencia.

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

- Login con usuario y contraseña individuales por persona (Supabase Auth valida la contraseña).
- Panel de administración para crear, editar y deshabilitar cuentas con cualquiera de los cinco roles. La cuenta del administrador conectado está protegida contra cambios desde este panel.
- Secciones y permisos de contenido independientes para Operarios, Jefes, Vendedores y Gerencia.
- Asignación de cada video a un rol y una sección específicos.
- Reproducción integrada de YouTube, Google Drive, Vimeo, Loom y archivos directos MP4/WebM/Ogg.
- Título, descripción, duración y opción de contenido destacado.
- Panel para crear, renombrar, ordenar, ocultar y eliminar secciones.
- Panel para crear, editar, buscar y eliminar videos.
- Configuración general de identidad, bienvenida, ayuda y modo claro.
- Guardado automático transaccional y versionado en Supabase, con lectura al iniciar y al volver a enfocar la página.
- Vista previa de permisos por rol.
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
