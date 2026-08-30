# FileShare — Almacenamiento y compartición de ficheros

**Autor:** Miguel González Oreiro ([mgoreiro@gmail.com](mailto:mgoreiro@gmail.com) · [github.com/mgoreiro](https://github.com/mgoreiro))

Sistema sencillo, contenido en un único contenedor Docker, para:

- Subir ficheros desde un **panel de administración protegido por usuario/contraseña**.
- Generar automáticamente un **enlace directo de descarga** (público, sin login) para cada fichero.
- Listar, copiar el enlace y eliminar ficheros desde el panel.

Está construido sin ninguna dependencia nativa (bcryptjs en vez de bcrypt, sin
sqlite compilado, etc.), por lo que la imagen Docker es **100% compatible con
Linux ARM (arm64 / armv7)** sin necesidad de compilación cruzada — funciona
igual en Raspberry Pi, servidores ARM, Apple Silicon, etc.

## Estructura del proyecto

```
fileshare/
├── server.js              # Backend Express (auth, subida, descarga, API admin)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── public/
│   ├── login.html          # Página de login del panel
│   └── admin/
│       └── dashboard.html  # Panel de administración (subida + listado + borrado)
└── data/                   # Persistencia (se monta como volumen)
    ├── db.json              # Metadatos de ficheros + credenciales admin (hash)
    └── uploads/              # Ficheros subidos
```

## Puesta en marcha rápida (docker-compose)

1. Copia el fichero de variables de entorno y edítalo:

   ```bash
   cp .env.example .env
   ```

   Como mínimo, cambia:
   - `ADMIN_USER` / `ADMIN_PASSWORD` → credenciales del panel.
   - `SESSION_SECRET` → cadena aleatoria larga.
   - `BASE_URL` → la URL/IP pública desde la que se accederá (se usa para
     construir los enlaces de descarga, p. ej. `http://192.168.1.50:3000`
     o `https://ficheros.midominio.com`).

2. Levanta el servicio. La imagen ya está publicada en Docker Hub
   (multi-arquitectura: amd64/arm64/armv7), así que lo más rápido es
   descargarla en vez de compilarla:

   ```bash
   docker compose pull
   docker compose up -d
   ```

   Si prefieres compilarla tú mismo a partir del código de esta carpeta
   (por ejemplo, si lo has modificado), usa en su lugar:

   ```bash
   docker compose up -d --build
   ```

3. Abre `http://<tu-ip-o-dominio>:3000` → te llevará al login del panel.

Los datos (base de datos JSON y ficheros subidos) se guardan en `./data`,
montado como volumen, por lo que sobreviven a reinicios/actualizaciones del
contenedor.

## Cómo actualizar a una nueva versión

**Si usas la imagen publicada en Docker Hub** (la opción por defecto), actualizar
es tan sencillo como:

```bash
docker compose pull
docker compose up -d
```

(o con `-f docker-compose.https.yml` si usas la variante HTTPS). Esto descarga
la última versión de `mgoreiro/fileshare:latest` y recrea el contenedor con
ella. **Los datos (`./data`) no se tocan** en ningún momento.

**Si en cambio compilas desde el código fuente** (porque lo has modificado, o
prefieres no depender de Docker Hub), cuando cambies el código (`server.js`,
ficheros de `public/`, `package.json`, etc.) los pasos son:

1. Sustituye los ficheros del proyecto por los nuevos (todo excepto la
   carpeta `data/`, que es la que contiene tus ficheros y la configuración
   del admin — consérvala tal cual).

   Si te han dado un `.zip` nuevo del proyecto, descomprímelo en otra carpeta
   y copia todo salvo `data/` encima de tu instalación actual, o bien
   descomprímelo directamente sobre la carpeta existente (la mayoría de
   descompresores no tocan `data/` si ya existe con contenido, pero
   revísalo si tienes dudas).

2. Reconstruye la imagen y reinicia el contenedor:

   ```bash
   docker compose down
   docker compose up -d --build
   ```

   (si usas la variante HTTPS: `docker compose -f docker-compose.https.yml down`
   y luego `up -d --build` con ese mismo fichero).

   Usa siempre `--build` explícitamente cuando quieras compilar desde tu
   propio código: al tener definidos tanto `image` como `build` en el mismo
   servicio, es la forma fiable de asegurarte de que Compose reconstruye la
   imagen en vez de reutilizar una copia ya descargada de Docker Hub con el
   mismo nombre.

3. Comprueba que arrancó bien y que no hay errores:

   ```bash
   docker compose logs -f fileshare
   ```

4. Si tu `.env` ya existía de una instalación anterior, revisa si la nueva
   versión añade variables nuevas (compáralo con `.env.example`) y añade a tu
   `.env` las que falten — las variables nuevas suelen tener un valor por
   defecto razonable si no las defines, pero conviene revisarlo.

No hace falta borrar `./data` ni el volumen para actualizar: el usuario/
contraseña admin, los ficheros ya subidos y sus enlaces se mantienen
exactamente igual tras la actualización.

## HTTPS con Let's Encrypt (recomendado si expones el servicio a Internet)

Se incluye una variante lista para usar (`docker-compose.https.yml`) que añade
[Caddy](https://caddyserver.com/) como reverse proxy delante de la aplicación.
Caddy **obtiene y renueva automáticamente** un certificado válido de Let's
Encrypt — no hay que ejecutar `certbot` ni renovar nada a mano.

### Requisitos previos

1. Un **dominio (o subdominio)** cuyo registro DNS tipo A (o AAAA) apunte a la
   IP pública de este servidor. Let's Encrypt no emite certificados para
   direcciones IP sueltas, necesita un nombre de dominio real.
2. Los **puertos 80 y 443 abiertos y accesibles desde Internet** hacia este
   servidor (el 80 se usa para el reto HTTP-01 de verificación, el 443 para
   servir el tráfico HTTPS). Si tu router hace NAT, redirige ambos puertos
   hacia esta máquina.

### Pasos

1. Copia `.env.example` a `.env` y rellena, además de las credenciales
   habituales, la variable `DOMAIN` con tu dominio real:

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   DOMAIN=ficheros.midominio.com
   ADMIN_USER=admin
   ADMIN_PASSWORD=una_contraseña_fuerte
   SESSION_SECRET=una_cadena_aleatoria_larga
   ```

   (No hace falta tocar `BASE_URL` ni `COOKIE_SECURE`: `docker-compose.https.yml`
   ya los fuerza automáticamente a `https://$DOMAIN` y `true`.)

2. Levanta el stack con el fichero de compose de HTTPS:

   ```bash
   docker compose -f docker-compose.https.yml up -d --build
   ```

3. En un plazo de unos segundos a un par de minutos, Caddy solicitará el
   certificado la primera vez que llegue tráfico. Puedes comprobar el
   progreso con:

   ```bash
   docker compose -f docker-compose.https.yml logs -f caddy
   ```

4. Abre `https://ficheros.midominio.com` — el candado debería aparecer ya
   como válido, y las peticiones a `http://` se redirigen automáticamente a
   `https://`.

### Notas

- Con esta variante, el contenedor `fileshare` **ya no expone el puerto 3000
  al host**; todo el tráfico pasa obligatoriamente por Caddy.
- Los certificados se guardan en el volumen Docker `caddy_data`, así que
  sobreviven a reinicios/actualizaciones y no se vuelven a pedir cada vez.
- Si más adelante cambias de dominio, edita `DOMAIN` en `.env` y reinicia:
  `docker compose -f docker-compose.https.yml up -d`.
- El `docker-compose.yml` original (HTTP simple, sin Caddy) sigue disponible
  tal cual para uso en red local o detrás de tu propio reverse proxy/VPN.

## Construcción de la imagen para ARM (Raspberry Pi, etc.)

Si vas a desplegar directamente en un dispositivo ARM, `docker compose up
--build` ejecutado **en ese mismo dispositivo** ya genera una imagen nativa
para su arquitectura — no se necesita nada especial.

Si en cambio quieres construir la imagen en un equipo x86 (por ejemplo tu
portátil) y luego llevarla a un dispositivo ARM, usa `buildx` para generar una
imagen multi-arquitectura:

```bash
docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t tu-usuario/fileshare:latest \
  --push .
```

(el `--push` requiere haber hecho `docker login` en un registro como Docker
Hub o GHCR; si solo quieres cargarla localmente en un dispositivo ARM
concreto, usa `--platform linux/arm64 --load` en su lugar, o transfiere el
`docker save`/`docker load` de la imagen).

## Publicar en Docker Hub

Para que cualquiera pueda usar tu imagen con un simple `docker pull`, sin
tener que clonar el repositorio ni compilarla, sigue estos pasos.

### 1. Crear la cuenta y el repositorio

1. Crea una cuenta gratuita en [hub.docker.com](https://hub.docker.com) si no
   tienes una.
2. Crea un repositorio nuevo, por ejemplo `fileshare` (puede ser público o
   privado). El nombre completo de tu imagen será
   `mgoreiro/fileshare`.

### 2. Iniciar sesión desde la terminal

```bash
docker login
```

### 3. Preparar `buildx` para compilación multi-arquitectura

Necesario tanto si compilas en el propio Orange Pi como si lo haces desde tu
PC. Se hace una sola vez:

```bash
docker buildx create --name fileshare-builder --use
docker buildx inspect --bootstrap
```

Además, para poder compilar para **cualquier arquitectura distinta a la del
equipo donde ejecutas el comando**, necesitas emulación QEMU instalada (una
sola vez). Esto aplica igual si compilas desde tu PC x86 hacia ARM, **como si
compilas desde el propio Orange Pi** y quieres generar también las imágenes
`amd64`/`armv7` (arquitecturas distintas a la nativa del Pi):

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```

### 4. Compilar y publicar la imagen multi-arquitectura

Desde la carpeta del proyecto (donde está el `Dockerfile`):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t mgoreiro/fileshare:latest \
  -t mgoreiro/fileshare:1.0.0 \
  --push .
```

- Publica siempre `latest` junto con una etiqueta de versión concreta (aquí
  `1.0.0`) — así quien despliegue puede fijar una versión exacta si quiere
  evitar que un cambio futuro le afecte sin avisar.
- `--platform` incluye `amd64` (PCs/servidores normales), `arm64` (Raspberry
  Pi 4/5, Orange Pi, la mayoría de SBCs de 64 bits) y `arm/v7` (placas ARM de
  32 bits más antiguas). Puedes quitar las que no necesites para acelerar la
  compilación.

### 5. Verificar que la imagen es realmente multi-arquitectura

```bash
docker buildx imagetools inspect mgoreiro/fileshare:latest
```

Debe listar varias entradas en `Platform:` (linux/amd64, linux/arm64,
linux/arm/v7...), confirmando que cada arquitectura tiene su propia capa
compilada nativamente (no es emulación en tiempo de ejecución).

### 6. Usar la imagen publicada en vez de compilar localmente

Una vez publicada, cualquiera (incluido tú mismo en otro equipo) puede usarla
sin clonar el repositorio, editando el `docker-compose.yml`: sustituye la
línea `build: .` por:

```yaml
image: mgoreiro/fileshare:latest
```

y ejecutar directamente:

```bash
docker compose pull
docker compose up -d
```

(sin `--build`, ya que ahora se descarga la imagen en vez de compilarla).

### Publicar nuevas versiones

Cada vez que cambies el código y quieras publicar una actualización, repite
el paso 4 con una etiqueta de versión nueva (por ejemplo `1.1.0`), sin dejar
de publicar también `latest` apuntando a esa misma versión, para que quien
use `docker compose pull` con `image: mgoreiro/fileshare:latest` reciba
siempre la última.

### Solución de problemas con `buildx` en hardware ARM con pocos recursos

Si `docker buildx inspect --bootstrap` (o el primer `buildx build`) falla con
un error como `context deadline exceeded`, el daemon de Docker no ha
conseguido arrancar a tiempo el contenedor de BuildKit — habitual en placas
ARM con poca RAM (Orange Pi Zero, Raspberry Pi con 1-2 GB, etc.), sobre todo
la primera vez que hay que descargar la imagen de BuildKit.

1. Comprueba recursos libres: `free -h` y `df -h`.
2. Mira si el contenedor llegó a crearse: `docker ps -a | grep buildx`, y si
   existe, revisa sus logs: `docker logs buildx_buildkit_<nombre-del-builder>0`.
3. Borra el builder fallido y vuelve a intentarlo desde cero:
   ```bash
   docker buildx rm fileshare-builder
   docker buildx create --name fileshare-builder --use
   docker buildx inspect --bootstrap
   ```
4. Si el problema persiste, prueba primero a compilar **solo para la
   arquitectura nativa** de tu placa (mucho más rápido, sin emulación QEMU
   de por medio), para descartar que sea un problema de recursos:
   ```bash
   docker buildx build --platform linux/arm64 -t mgoreiro/fileshare:latest --push .
   ```
   Si esto funciona bien, el problema estaba relacionado con la emulación
   multi-arquitectura (QEMU), no con Docker en general — revisa que hayas
   ejecutado el paso de `tonistiigi/binfmt` de más arriba.
5. Como alternativa, puedes compilar cada arquitectura por separado (más
   lento en total, pero cada compilación individual consume menos recursos de
   golpe) y combinarlas después con `docker buildx imagetools create`, o
   simplemente compilar la imagen `amd64` en un PC más potente y la `arm64`
   directamente en el Orange Pi.

## Carpeta vigilada (subida automática por sistema de ficheros)

Cualquier fichero que dejes en `data/watch/` (en el host, dentro del mismo
volumen `./data` que ya se monta en `docker-compose.yml`) se da de alta
**automáticamente**, con su propio enlace directo, igual que si se hubiera
subido desde el panel. En el listado del panel aparece con una etiqueta
"📁 carpeta" para distinguirlo de las subidas manuales.

Funcionamiento:

- Se ignoran los ficheros ocultos (`.algo`) y las extensiones típicas de una
  copia todavía en curso (`.tmp`, `.part`, `.partial`, `.crdownload`,
  `.download`).
- Antes de procesar un fichero, se espera a que su tamaño deje de cambiar. Para
  ficheros de menos de 100 MB basta una comprobación rápida (~2-3 segundos, la
  copia ya habrá terminado casi con toda seguridad); para ficheros de 100 MB o
  más se aplica una verificación reforzada, con varias comprobaciones
  espaciadas en el tiempo y una última relectura tras mover el fichero — así
  se evita registrar un tamaño incorrecto si la transferencia tiene alguna
  pausa larga a mitad de camino (redes lentas, Wi-Fi inestable, recursos SMB
  compartidos...).
- Como red de seguridad adicional, el servicio compara periódicamente el
  tamaño registrado de cada fichero con su tamaño real en disco y corrige
  automáticamente cualquier discrepancia — tanto **al arrancar** como, a
  partir de ahí, **cada hora** (configurable con `SIZE_CHECK_INTERVAL_MINUTES`,
  o desactivable con `SIZE_CHECK_INTERVAL_MINUTES=0` para dejar solo la
  comprobación de arranque). Verás un aviso en los logs si corrige algo.
- Una vez procesado, el fichero se **mueve** de `data/watch/` a
  `data/uploads/`, así que la carpeta vigilada queda vacía y no se reprocesa
  nada en sucesivos reinicios.
- Si el contenedor está parado y dejas un fichero mientras tanto, se procesa
  en cuanto vuelve a arrancar.

Para desactivar esta función, pon en `.env`:

```dotenv
WATCH_ENABLED=false
```

> **Aviso de seguridad:** cualquiera con acceso al sistema de ficheros del
> host donde está montado `./data/watch` (SSH, Samba, un USB compartido,
> etc.) podrá publicar ficheros **sin pasar por el login del panel**. Trata el
> acceso a esa carpeta con la misma confianza que las credenciales del panel.

## Bot de Telegram: notificaciones y comandos

Si defines `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`, el bot hace dos cosas:

1. **Notifica** cada descarga (fichero, tamaño, IP de origen y fecha).
2. **Responde a comandos** para gestionar el servicio desde el propio chat de
   Telegram, sin necesidad de entrar al panel web.

No añade ninguna dependencia nueva: usa el `fetch` que ya trae Node de serie,
y consulta las novedades mediante sondeo (*long polling*), así que no hace
falta exponer ningún endpoint nuevo ni configurar un webhook.

### 1. Crear el bot y obtener el token

1. En Telegram, habla con **@BotFather**.
2. Envía `/newbot` y sigue las instrucciones (nombre y usuario del bot).
3. BotFather te dará un token con este aspecto:
   `123456789:AAHk3jFj93jfWEIfj93ifjWEIf93jf`. Ese es tu `TELEGRAM_BOT_TOKEN`.

### 2. Obtener tu chat_id

1. Busca tu bot recién creado en Telegram (por el usuario que le pusiste) y
   envíale cualquier mensaje, por ejemplo "hola" (los bots no pueden
   escribirte primero: tienes que iniciar tú la conversación).
2. Visita esta URL en el navegador, sustituyendo `<TOKEN>` por tu token:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. Busca en la respuesta JSON el campo `"chat":{"id":...}` — ese número
   (puede ser negativo si es un grupo) es tu `TELEGRAM_CHAT_ID`.

### 3. Configurar y desplegar

En tu `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AAHk3jFj93jfWEIfj93ifjWEIf93jf
TELEGRAM_CHAT_ID=987654321
```

```bash
docker compose up -d --build
```

(o con `-f docker-compose.https.yml` si usas la variante HTTPS).

### Comandos del bot

Una vez configurado, escribe `/help` (o `/start`) al bot para ver este mismo
listado en cualquier momento:

| Comando | Qué hace |
|---|---|
| `/status` | Estado del servicio: tiempo activo, nº de ficheros, espacio ocupado, descargas totales y memoria usada. |
| `/list` | Lista todos los ficheros subidos, con su tamaño y nº de descargas. |
| `/delete` | Muestra un menú con botones (uno por fichero) para elegir cuál eliminar. |
| `/subir` | El bot te pide que le envíes un fichero; en cuanto se lo mandes (como documento/archivo, no como foto), lo sube y te devuelve el enlace directo — como si lo hubieras subido desde el panel. |
| `/listardescargas` | Muestra un menú con los ficheros; al elegir uno, responde con el historial de descargas de ese fichero (fecha + IP de cada una). |

**Autorización:** solo el/los `chat_id` indicados pueden usar estos comandos.
Por defecto es el mismo `TELEGRAM_CHAT_ID` que recibe las notificaciones; si
quieres que varias personas puedan usar los comandos (por ejemplo, tú y un
familiar), añade `TELEGRAM_ALLOWED_CHAT_IDS` con varios `chat_id` separados
por comas:

```dotenv
TELEGRAM_ALLOWED_CHAT_IDS=987654321,123123123
```

Cualquier mensaje o comando de un chat no incluido en esa lista se ignora
por completo.

### Notas

- Si dejas `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` vacías, toda la función
  (notificaciones y comandos) queda desactivada y no se realiza ninguna
  llamada de red — es el comportamiento por defecto.
- Si solo defines una de las dos variables, verás un aviso en los logs y la
  función no se activa hasta que definas ambas.
- Un fallo de red hacia Telegram (sin internet en ese momento, token
  incorrecto, etc.) **nunca afecta a las descargas ni al resto del
  servicio** — se reintenta el sondeo automáticamente y todo lo demás sigue
  funcionando con normalidad. El error queda registrado en los logs
  (`docker compose logs fileshare`).
- Para evitar recibir un mensaje/registro por cada trozo de un fichero
  grande cuando un gestor de descargas lo reanuda por partes, solo se
  cuenta/notifica en la petición inicial de cada descarga.
- La IP que se reporta es la del cliente real (respeta `X-Forwarded-For`
  detrás de Caddy), no la IP interna del contenedor.
- Al arrancar, el bot descarta cualquier mensaje/comando pendiente de antes
  de que el contenedor se iniciara, para no ejecutar de golpe comandos
  antiguos (por ejemplo, un `/delete` que hubieras enviado por error mientras
  el servicio estaba parado).

## Historial de descargas por fichero

Tanto en el panel web como por Telegram (`/listardescargas`) puedes consultar,
para cada fichero, cuándo se ha descargado y desde qué IP. En el panel, pulsa
el botón **"Descargas"** de la fila del fichero para ver ese historial en una
ventana emergente. Se guardan hasta las últimas 200 descargas por fichero;
más allá de eso, las más antiguas se descartan automáticamente para que la
base de datos no crezca sin control.

## Variables de entorno

| Variable          | Descripción                                                                 | Por defecto              |
|-------------------|------------------------------------------------------------------------------|---------------------------|
| `PORT`            | Puerto interno del contenedor                                               | `3000`                    |
| `ADMIN_USER`      | Usuario del panel de administración (solo se aplica si no existe uno ya)    | —                          |
| `ADMIN_PASSWORD`  | Contraseña del panel (se guarda como hash bcrypt, nunca en texto plano)     | —                          |
| `SESSION_SECRET`  | Secreto para firmar las cookies de sesión                                   | aleatorio si no se define |
| `BASE_URL`        | URL pública usada para construir los enlaces `/d/:id`                       | `http://localhost:3000`   |
| `MAX_FILE_SIZE_MB`| Tamaño máximo de fichero admitido, en MB (0 = sin límite)                   | `500`                     |
| `WATCH_ENABLED`   | Activa/desactiva la carpeta vigilada `data/watch/` (ver sección anterior)   | `true`                    |
| `SIZE_CHECK_INTERVAL_MINUTES` | Cada cuántos minutos se corrigen tamaños desincronizados en segundo plano (0 = desactivar, solo comprobación de arranque) | `60` |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram (notificaciones + comandos, ver sección)      | — (desactivado)           |
| `TELEGRAM_CHAT_ID`   | Chat de Telegram que recibe notificaciones y puede usar los comandos      | — (desactivado)           |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Lista opcional de chat_id (separados por comas) autorizados a usar los comandos, además del anterior | `TELEGRAM_CHAT_ID` |
| `RESET_ADMIN`     | Si es `true`, fuerza a regenerar el usuario/contraseña admin al arrancar    | `false`                   |

> **Nota:** el usuario/contraseña admin solo se crea la **primera vez** que
> arranca el contenedor (cuando `data/db.json` todavía no existe). Si quieres
> cambiarlos más adelante, pon `RESET_ADMIN=true` en `.env`, reinicia el
> contenedor una vez, y vuelve a ponerlo en `false`.

## Cómo funciona el enlace directo

Al subir un fichero desde el panel, se genera un identificador único (UUID) y
un enlace del tipo:

```
https://tu-dominio-o-ip:puerto/d/<id>
```

Ese enlace es público (no requiere login) y sirve el fichero directamente
para su descarga, conservando el nombre original. El panel lleva la cuenta de
cuántas veces se ha descargado cada fichero.

## Seguridad — recomendaciones antes de exponerlo a Internet

Este proyecto cubre lo pedido (subida + enlace directo + panel con login),
pero si vas a exponerlo fuera de tu red local, ten en cuenta:

- **Ponlo detrás de HTTPS**: usa `docker-compose.https.yml` (ver sección
  "HTTPS con Let's Encrypt" más arriba), que añade Caddy con certificado
  automático. Sin esto, las cookies de sesión y los ficheros viajan en texto
  plano por HTTP.
- Las sesiones se guardan en memoria (`express-session` con `MemoryStore`),
  lo cual es correcto para un único contenedor con un solo proceso, pero se
  reinician si el contenedor se reinicia (los usuarios tendrán que volver a
  identificarse) y no escalan a múltiples réplicas. Si en el futuro necesitas
  varias instancias, cambia a un store compartido (p. ej. Redis).
- Considera añadir un límite de intentos de login (rate limiting) si el panel
  va a estar accesible desde Internet.
- Los enlaces de descarga son "por posesión del enlace" (como un enlace no
  listado): cualquiera que lo tenga puede descargar el fichero. Si necesitas
  caducidad, límite de descargas o protección adicional por enlace, lo puedo
  añadir.

## Desarrollo local sin Docker

```bash
npm install
cp .env.example .env
node server.js
```

## Licencia

MIT — ver el fichero [LICENSE](LICENSE).

## Autor

**Miguel González Oreiro**
📧 [mgoreiro@gmail.com](mailto:mgoreiro@gmail.com)
🔗 [github.com/mgoreiro](https://github.com/mgoreiro)
🐳 [hub.docker.com/r/mgoreiro/fileshare](https://hub.docker.com/r/mgoreiro/fileshare)
