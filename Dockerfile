# Imagen base con soporte multi-arquitectura oficial (incluye linux/arm64 y linux/arm/v7)
FROM node:20-alpine

LABEL org.opencontainers.image.title="FileShare" \
      org.opencontainers.image.description="Sistema de almacenamiento y compartición de ficheros con panel de administración, carpeta vigilada y notificaciones de Telegram" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Miguel González Oreiro <mgoreiro@gmail.com>" \
      org.opencontainers.image.url="https://github.com/mgoreiro" \
      org.opencontainers.image.vendor="Miguel González Oreiro"

WORKDIR /app

# Instalamos dependencias primero para aprovechar la caché de capas de Docker
COPY package.json ./
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# Directorio de datos persistente (se recomienda montarlo como volumen).
# "watch" es la carpeta vigilada para subidas automáticas por sistema de ficheros.
RUN mkdir -p /app/data/uploads /app/data/watch

ENV NODE_ENV=production
EXPOSE 3000

# wget viene incluido de serie en BusyBox (Alpine), no hace falta instalar nada extra
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "server.js"]
