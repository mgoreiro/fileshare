# FileShare

Sistema ligero de almacenamiento y compartición de ficheros, autoalojado, con
panel de administración protegido por usuario/contraseña. Pensado para correr
en un solo contenedor, sin dependencias nativas — **100% compatible con
ARM** (Raspberry Pi, Orange Pi, y cualquier SBC de 32 o 64 bits) además de
amd64.

## Características

- 📤 Subida de ficheros con enlace directo de descarga (`/d/:id`)
- 🔒 Panel de administración con login (usuario/contraseña con hash bcrypt)
- 📁 Carpeta vigilada: cualquier fichero que dejes en `data/watch/` se publica
  automáticamente, sin pasar por el panel — con verificación reforzada de
  integridad para ficheros grandes y autocorrección periódica de tamaños
- 🤖 Bot de Telegram: notificaciones en cada descarga (fichero + IP de
  origen) y comandos (`/status`, `/list`, `/delete`, `/subir`,
  `/listardescargas`) para gestionar el servicio sin entrar al panel
- 📊 Historial de descargas por fichero (fecha + IP), consultable desde el
  panel web y desde Telegram
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

## Variables de entorno principales

| Variable | Descripción | Por defecto |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | Credenciales del panel (solo se aplican la primera vez) | — |
| `SESSION_SECRET` | Secreto para firmar las cookies de sesión | aleatorio |
| `BASE_URL` | URL pública usada para construir los enlaces de descarga | `http://localhost:3000` |
| `MAX_FILE_SIZE_MB` | Tamaño máximo por fichero, en MB (0 = sin límite) | `500` |
| `WATCH_ENABLED` | Activa la carpeta vigilada `data/watch/` | `true` |
| `SIZE_CHECK_INTERVAL_MINUTES` | Frecuencia de la corrección automática de tamaños (0 = solo al arrancar) | `60` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notificaciones y comandos de Telegram (opcional) | — |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Chats adicionales autorizados a usar los comandos del bot | `TELEGRAM_CHAT_ID` |

Documentación completa, incluyendo la variante con HTTPS/Let's Encrypt vía
Caddy y todos los comandos del bot de Telegram, en el repositorio del
proyecto.

## Arquitecturas soportadas

`linux/amd64`, `linux/arm64`, `linux/arm/v7`

## Licencia

MIT

## Autor

**Miguel González Oreiro**
📧 [mgoreiro@gmail.com](mailto:mgoreiro@gmail.com)
🔗 [github.com/mgoreiro](https://github.com/mgoreiro)

