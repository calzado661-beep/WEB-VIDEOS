# Secuencias de videos e intentos de cuestionario

Aplica las migraciones pendientes en orden, incluida `20261004010000_video_learning_paths.sql`, antes de publicar esta versión del cliente. La migración añade requisitos por rol, límites de intentos y las validaciones de acceso en Supabase. Los videos existentes quedan independientes y los cuestionarios tienen 3 intentos iniciales; los resultados y aprobaciones anteriores se conservan.

## Configurar una secuencia

1. Guarda el video 1 con su cuestionario.
2. Edita el video 2. Dentro de **Permisos y ubicación**, selecciona el video 1 en **Video previo obligatorio** para el rol correspondiente.
3. Para el video 3, selecciona el video 2 como requisito. Puedes crear tantas cadenas como necesites y configurar una distinta por rol.
4. Para un video suelto, conserva **Sin requisito · video independiente**.

El usuario ve la tarjeta bloqueada y el nombre del requisito. Se desbloquea cuando ese usuario completa el video previo y aprueba su cuestionario. El botón **Continuar con este video** permite pasar al siguiente después de guardar el resultado. El bloqueo manual mantiene su prioridad. Ocultar una sección para un rol también impide usar su contenido como requisito disponible.

Se validan todos los antecesores. Se rechazan ciclos y videos previos sin cuestionario o sin asignación para el mismo rol. Para eliminar un video o cuestionario usado como requisito, primero cambia los videos que dependen de él. El guardado de la secuencia y la revisión del contenido ocurre en una sola transacción.

La comprobación de reproducción requiere YouTube, Vimeo o un archivo de video reproducido directamente (incluidos archivos de Drive ya importados a Storage). Los iframes de Drive y Loom no proporcionan las señales necesarias; dejar la pestaña abierta no cuenta como completar el video. El editor excluye esos reproductores de los requisitos disponibles.

## Intentos y autorización adicional

En el editor del cuestionario, **Intentos iniciales por usuario** permite establecer entre 1 y 20 (3 por defecto). Cambiar ese límite afecta a todos los usuarios del cuestionario; para una excepción individual, utiliza **Intentos por usuario → Habilitar 1 intento**.

Ese botón se habilita solo cuando el usuario activo agotó los intentos y todavía no aprobó. El permiso se guarda para ese usuario y ese cuestionario. No borra intentos ni notas anteriores y queda registrado en la auditoría con el administrador que lo concedió. Los historiales antiguos que ya superaban el límite también reciben exactamente un intento disponible.

El servidor exige haber completado el video para responder, valida las respuestas, comprueba el límite y serializa envíos/permisos del mismo usuario y video. Repetir una petición de red con el mismo identificador devuelve su resultado original sin consumir otro intento. Un cuestionario aprobado no admite nuevos envíos.

## Comprobaciones

`npm run test:learning` ejecuta pruebas de las reglas del cliente y pruebas en PostgreSQL en memoria con PGlite. Estas cargan las migraciones reales y prueban RLS, guardado atómico, secuencias, límites, autorizaciones, conservación de historial y reintentos de red. No modifican el proyecto Supabase conectado.

`npm run check:supabase-schema` comprueba que el proyecto conectado contiene las columnas nuevas. No sustituye la aplicación de la migración.
