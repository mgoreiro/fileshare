# FileShare

Sistema ligero de almacenamiento y compartición de ficheros, autoalojado, con
panel de administración protegido por usuario/contraseña. Pensado para correr
en un solo contenedor, sin dependencias nativas compiladas — **100%
compatible con ARM** (Raspberry Pi, Orange Pi, Apple Silicon y cualquier SBC
de 32 o 64 bits) además de amd64.

- 🔗 Código fuente: [github.com/mgoreiro/fileshare](https://github.com/mgoreiro/fileshare)
- 🐳 Imagen: [`mgoreiro/fileshare`](https://hub.docker.com/r/mgoreiro/fileshare)

## Características

- 📤 Subida de ficheros desde un panel web, con enlace directo de descarga (`/d/:id`), público y sin login
- 🔒 Panel de administración con login (usuario/contraseña, hash bcrypt)
- 📁 Carpeta vigilada: cualquier fichero que dejes en `data/watch/` se publica automáticamente, sin pasar por el panel — con verificación reforzada de integridad para ficheros grandes y autocorrección periódica de tamaños
- 🤖 Bot de Telegram: notificaciones en cada descarga (fichero + IP de origen) y comandos (`/status`, `/list`, `/delete`, `/subir`, `/listardescargas`) para gestionar el servicio sin entrar al panel
- 📊 Historial de descargas por fichero (fecha + IP), consultable desde el panel web y desde Telegram
- 🔐 HTTPS automático con Let's Encrypt (variante con Caddy incluida)
- ❤️ Endpoint `/health` con `HEALTHCHECK` de Docker integrado
- 🐳 Sin dependencias nativas compiladas — misma imagen para amd64/arm64/armv7

## Uso rápido

```bash
docker run -d \
  --name fileshare \
  -p 3000:3000 \
  -v ./data:/app/data \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=cambia_esto \
  -e SESSION_SECRET=una_cadena_aleatoria_larga \
  -e BASE_URL=http://localhost:3000 \
  mgoreiro/fileshare:latest
```

Abre `http://localhost:3000` → te lleva al login del panel de administración.
El usuario/contraseña admin solo se crea la **primera vez** que arranca el
contenedor (mientras `data/db.json` no exista).

## Con docker-compose (recomendado)

```yaml
services:
  fileshare:
    image: mgoreiro/fileshare:latest
    container_name: fileshare
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASSWORD=cambia_esto
      - SESSION_SECRET=una_cadena_aleatoria_larga
      - BASE_URL=http://localhost:3000
    restart: unless-stopped
```

```bash
docker compose pull
docker compose up -d
```

Los datos (base de datos JSON y ficheros subidos) se guardan en `./data`,
montado como volumen, por lo que sobreviven a reinicios y actualizaciones del
contenedor.

### Actualizar a una nueva versión

```bash
docker compose pull
docker compose up -d
```

Esto descarga la última versión de `mgoreiro/fileshare:latest` y recrea el
contenedor. **Los datos (`./data`) no se tocan** en ningún momento.

## HTTPS automático con Let's Encrypt

Para exponer el servicio a Internet con certificado válido y renovación
automática, usa [Caddy](https://caddyserver.com/) como reverse proxy delante
del contenedor:

```yaml
services:
  fileshare:
    image: mgoreiro/fileshare:latest
    container_name: fileshare
    expose:
      - "3000"
    volumes:
      - ./data:/app/data
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASSWORD=cambia_esto
      - SESSION_SECRET=una_cadena_aleatoria_larga
      - BASE_URL=https://ficheros.midominio.com
      - COOKIE_SECURE=true
    restart: unless-stopped
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    container_name: fileshare-caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    environment:
      - DOMAIN=ficheros.midominio.com
    depends_on: [fileshare]
    restart: unless-stopped
    networks: [internal]

networks:
  internal:

volumes:
  caddy_data:
```

Requiere un dominio con registro DNS A/AAAA apuntando a este servidor, y los
puertos 80/443 abiertos hacia él. El `Caddyfile` de ejemplo y el fichero
`docker-compose.https.yml` completo están en el
[repositorio](https://github.com/mgoreiro/fileshare).

## Carpeta vigilada (subida automática por sistema de ficheros)

Cualquier fichero que dejes en `data/watch/` (dentro del volumen `./data`
montado) se da de alta automáticamente, con su propio enlace directo, igual
que si se hubiera subido desde el panel. Se ignoran ficheros ocultos y
extensiones de copia en curso (`.tmp`, `.part`, `.partial`, `.crdownload`,
`.download`), y se espera a que el tamaño del fichero deje de cambiar antes
de procesarlo (con verificación reforzada para ficheros ≥100 MB). Desactívalo
con `WATCH_ENABLED=false`.

> **Aviso:** cualquiera con acceso al sistema de ficheros del host donde está
> montado `data/watch` podrá publicar ficheros sin pasar por el login del
> panel. Trata el acceso a esa carpeta con la misma confianza que las
> credenciales del panel.

## Bot de Telegram: notificaciones y comandos

Definiendo `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` el bot notifica cada
descarga (fichero, tamaño, IP y fecha) y responde a comandos por chat, sin
necesidad de exponer ningún endpoint ni configurar webhook (usa *long
polling*):

| Comando | Qué hace |
|---|---|
| `/status` | Estado del servicio: tiempo activo, nº de ficheros, espacio ocupado, descargas totales y memoria usada. |
| `/list` | Lista todos los ficheros subidos, con su tamaño y nº de descargas. |
| `/delete` | Menú con botones para elegir qué fichero eliminar. |
| `/subir` | El bot pide un fichero; en cuanto se lo envías, lo sube y devuelve el enlace directo. |
| `/listardescargas` | Menú de ficheros; al elegir uno, muestra su historial de descargas (fecha + IP). |

Solo el/los `chat_id` en `TELEGRAM_ALLOWED_CHAT_IDS` (por defecto,
`TELEGRAM_CHAT_ID`) pueden usar los comandos. Si dejas ambas variables
vacías, la función queda desactivada por completo y no se hace ninguna
llamada de red.

## Historial de descargas por fichero

Tanto en el panel web como por Telegram (`/listardescargas`) puedes consultar
cuándo se ha descargado cada fichero y desde qué IP. Se guardan hasta las
últimas 200 descargas por fichero.

## Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `PORT` | Puerto interno del contenedor | `3000` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Credenciales del panel (solo se aplican la primera vez, o con `RESET_ADMIN=true`) | — |
| `SESSION_SECRET` | Secreto para firmar las cookies de sesión | aleatorio |
| `BASE_URL` | URL pública usada para construir los enlaces de descarga | `http://localhost:3000` |
| `MAX_FILE_SIZE_MB` | Tamaño máximo por fichero, en MB (0 = sin límite) | `500` |
| `WATCH_ENABLED` | Activa la carpeta vigilada `data/watch/` | `true` |
| `SIZE_CHECK_INTERVAL_MINUTES` | Frecuencia de la corrección automática de tamaños (0 = solo al arrancar) | `60` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notificaciones y comandos de Telegram (opcional) | — |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Chats adicionales autorizados a usar los comandos del bot | `TELEGRAM_CHAT_ID` |
| `COOKIE_SECURE` | Marca la cookie de sesión como solo-HTTPS (ponlo en `true` detrás de HTTPS) | `false` |
| `RESET_ADMIN` | Si es `true`, fuerza a regenerar el usuario/contraseña admin al arrancar | `false` |

## Seguridad — antes de exponerlo a Internet

- **Ponlo detrás de HTTPS** (ver variante con Caddy más arriba); sin esto,
  las cookies de sesión y los ficheros viajan en texto plano por HTTP.
- Las sesiones se guardan en memoria (`MemoryStore`), correcto para un único
  contenedor con un solo proceso, pero se reinician si el contenedor se
  reinicia y no escalan a múltiples réplicas.
- Los enlaces de descarga son "por posesión del enlace": cualquiera que lo
  tenga puede descargar el fichero.

## Arquitecturas soportadas

`linux/amd64`, `linux/arm64`, `linux/arm/v7`

## Tags

- `latest` — última versión estable
- `X.Y.Z` — versión concreta (ver [releases](https://github.com/mgoreiro/fileshare/releases))

## Licencia

MIT

## Autor

**Miguel González Oreiro**
📧 [mgoreiro@gmail.com](mailto:mgoreiro@gmail.com)
🔗 [github.com/mgoreiro](https://github.com/mgoreiro)
