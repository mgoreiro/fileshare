require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');
const mime = require('mime-types');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Tamaño máximo por fichero, en MB. Usa 0 (o déjalo vacío) para no aplicar ningún límite.
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Poner COOKIE_SECURE=true cuando el servicio se sirve detrás de HTTPS (p. ej. con el
// reverse proxy Caddy + Let's Encrypt incluido en docker-compose.https.yml). Con HTTPS
// delante, "trust proxy" + la cabecera X-Forwarded-Proto hacen que esto funcione correctamente.
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
// Carpeta vigilada: cualquier fichero que se deje aquí (en el host, dentro del volumen
// ./data) se da de alta automáticamente como si se hubiera subido desde el panel.
const WATCH_ENABLED = String(process.env.WATCH_ENABLED || 'true').toLowerCase() === 'true';
const WATCH_DIR = path.join(DATA_DIR, 'watch');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (WATCH_ENABLED && !fs.existsSync(WATCH_DIR)) fs.mkdirSync(WATCH_DIR, { recursive: true });

// ---------- "Base de datos" en JSON ----------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { admin: null, files: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('Error leyendo db.json, se crea una nueva:', e.message);
    return { admin: null, files: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// Autocorrección: si el tamaño registrado de algún fichero no coincide con el
// tamaño real que tiene en disco (por ejemplo, por una carrera al detectarlo
// como "completo" en la carpeta vigilada mientras todavía se seguía escribiendo),
// lo corregimos aquí. Se ejecuta al arrancar y, además, periódicamente (ver
// SIZE_CHECK_INTERVAL_MINUTES más abajo), por si algún fichero queda
// desincronizado más adelante sin que haga falta reiniciar el contenedor.
function resyncFileSizes() {
  let correctedCount = 0;
  for (const file of db.files) {
    const filePath = path.join(UPLOADS_DIR, file.storedName);
    try {
      if (fs.existsSync(filePath)) {
        const actualSize = fs.statSync(filePath).size;
        if (actualSize !== file.size) {
          console.warn(
            `[INFO] Corrigiendo tamaño registrado de "${file.originalName}": ` +
            `${file.size} -> ${actualSize} bytes (no coincidía con el fichero real en disco).`
          );
          file.size = actualSize;
          correctedCount++;
        }
      }
    } catch (err) {
      console.warn(`[AVISO] No se pudo verificar el tamaño de "${file.originalName}":`, err.message);
    }
  }
  if (correctedCount > 0) {
    saveDB(db);
    console.log(`[INFO] Se han corregido ${correctedCount} tamaño(s) de fichero desincronizado(s).`);
  }
  return correctedCount;
}

resyncFileSizes();

// Comprobación periódica en segundo plano, además de la de arranque. Pon
// SIZE_CHECK_INTERVAL_MINUTES=0 en .env para desactivarla y dejar solo la de arranque.
const SIZE_CHECK_INTERVAL_MINUTES = parseFloat(process.env.SIZE_CHECK_INTERVAL_MINUTES || '60');
if (SIZE_CHECK_INTERVAL_MINUTES > 0) {
  setInterval(() => {
    try {
      resyncFileSizes();
    } catch (err) {
      console.error('[AVISO] Error durante la comprobación periódica de tamaños:', err.message);
    }
  }, SIZE_CHECK_INTERVAL_MINUTES * 60 * 1000);
  console.log(`[INFO] Comprobación periódica de tamaños activada cada ${SIZE_CHECK_INTERVAL_MINUTES} minuto(s).`);
}

// Crear/actualizar usuario admin a partir de variables de entorno si no existe todavía,
// o si se fuerza explícitamente con RESET_ADMIN=true
(function ensureAdmin() {
  const envUser = process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD;
  const forceReset = String(process.env.RESET_ADMIN || '').toLowerCase() === 'true';

  if (!db.admin || forceReset) {
    if (!envUser || !envPass) {
      console.warn(
        '[AVISO] No existe usuario admin y no se han definido ADMIN_USER / ADMIN_PASSWORD. ' +
        'Define esas variables de entorno y reinicia el contenedor.'
      );
      return;
    }
    const hash = bcrypt.hashSync(envPass, 10);
    db.admin = { username: envUser, passwordHash: hash };
    saveDB(db);
    console.log(`[INFO] Usuario admin configurado: ${envUser}`);
  }
})();

// ---------- Carpeta vigilada (subida automática por sistema de ficheros) ----------
// Cualquier fichero que se deje en WATCH_DIR (por defecto data/watch, dentro del mismo
// volumen ./data que ya se monta en docker-compose) se da de alta automáticamente con
// su propio enlace directo, igual que si se hubiera subido desde el panel.
if (WATCH_ENABLED) {
  // Ignoramos ficheros ocultos (empiezan por ".") y extensiones típicas de una copia
  // todavía en curso, para no ingerir ficheros a medio transferir.
  const IGNORED_PATTERNS = [/(^|[/\\])\../, /\.(tmp|part|partial|crdownload|download)$/i];

  const watcher = chokidar.watch(WATCH_DIR, {
    ignored: IGNORED_PATTERNS,
    ignoreInitial: false, // procesa también lo que ya hubiera en la carpeta al arrancar
    depth: 0, // solo ficheros sueltos directamente en la carpeta, no subcarpetas
    awaitWriteFinish: {
      // Espera a que el tamaño del fichero deje de cambiar durante 2s antes de darlo
      // por completo. Así evitamos ingerir un fichero que todavía se está copiando
      // (p. ej. vía scp/rsync/arrastrar y soltar en el explorador de ficheros del host).
      stabilityThreshold: 2000,
      pollInterval: 200,
    },
  });

  // Umbral a partir del cual aplicamos la verificación reforzada (más lenta pero más
  // segura). Por debajo, una copia se completa casi al instante y una pausa de varios
  // segundos a mitad de camino es extremadamente improbable, así que no merece la pena
  // penalizar la rapidez de ingesta de ficheros pequeños/normales.
  const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

  // Comprueba de forma independiente (más allá del propio chequeo interno de
  // chokidar) que el tamaño del fichero se mantiene estable durante varias
  // comprobaciones espaciadas en el tiempo. Esto es necesario porque, en
  // transferencias muy grandes con pausas de red (SMB, Wi-Fi inestable...), el
  // fichero puede quedarse "quieto" el tiempo suficiente para que chokidar lo dé
  // por completo y luego seguir creciendo — dando lugar a un tamaño registrado
  // incorrecto. Devuelve el tamaño final confirmado, o null si el fichero
  // desapareció mientras tanto (p. ej. lo borraron).
  async function waitForFileReallyStable(filePath, { checks, intervalMs }) {
    let lastSize = -1;
    let stableCount = 0;
    while (stableCount < checks) {
      if (!fs.existsSync(filePath)) return null;
      const size = fs.statSync(filePath).size;
      if (size === lastSize) {
        stableCount++;
      } else {
        stableCount = 0;
        lastSize = size;
      }
      if (stableCount < checks) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return lastSize;
  }

  watcher.on('add', async (filePath) => {
    try {
      // Un primer vistazo rápido al tamaño nos dice si merece la pena aplicar la
      // verificación reforzada (ficheros grandes) o basta con la rápida (chokidar
      // ya ha esperado su propio stabilityThreshold antes de disparar este evento).
      if (!fs.existsSync(filePath)) return;
      const earlySize = fs.statSync(filePath).size;
      const isLargeFile = earlySize >= LARGE_FILE_THRESHOLD_BYTES;

      if (isLargeFile) {
        // Verificación reforzada: confirma que el tamaño no cambia durante varias
        // comprobaciones espaciadas antes de tocar nada.
        const confirmedSize = await waitForFileReallyStable(filePath, { checks: 2, intervalMs: 3000 });
        if (confirmedSize === null) return; // desapareció mientras confirmábamos
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) return;

      const originalName = path.basename(filePath);
      const id = uuidv4();
      const destPath = path.join(UPLOADS_DIR, id);

      try {
        fs.renameSync(filePath, destPath);
      } catch (err) {
        // Si la carpeta vigilada estuviera en un volumen/dispositivo distinto al de
        // uploads/, rename() fallaría con EXDEV; en ese caso copiamos y borramos.
        if (err.code === 'EXDEV') {
          fs.copyFileSync(filePath, destPath);
          fs.unlinkSync(filePath);
        } else {
          throw err;
        }
      }

      // Comprobación final: en sistemas POSIX, mover (rename) un fichero no
      // invalida los descriptores ya abiertos — si el proceso que lo escribía
      // seguía teniendo el fichero abierto, podría seguir escribiendo en la nueva
      // ubicación tras el movimiento. Para ficheros grandes esperamos un momento
      // más y comprobamos; para ficheros pequeños basta una comprobación rápida.
      await new Promise((resolve) => setTimeout(resolve, isLargeFile ? 3000 : 300));
      const finalStats = fs.statSync(destPath);
      if (finalStats.size !== stats.size) {
        console.warn(
          `[watch] El tamaño de "${originalName}" siguió cambiando tras moverlo ` +
          `(${stats.size} -> ${finalStats.size} bytes); se usa el tamaño final.`
        );
      }

      const entry = {
        id,
        storedName: id,
        originalName,
        size: finalStats.size,
        mimeType: mime.lookup(originalName) || 'application/octet-stream',
        uploadedAt: new Date().toISOString(),
        downloads: 0,
        downloadHistory: [],
        source: 'watch',
      };
      db.files.push(entry);
      saveDB(db);
      console.log(`[watch] Fichero detectado y añadido automáticamente: "${originalName}" (${id})`);
    } catch (err) {
      console.error(`[watch] Error al procesar "${filePath}":`, err.message);
    }
  });

  watcher.on('error', (err) => {
    console.error('[watch] Error del observador de la carpeta vigilada:', err.message);
  });

  console.log(`[watch] Vigilando ${WATCH_DIR} para subidas automáticas`);
}

// ---------- App Express ----------
const app = express();
app.set('trust proxy', 1);

// Cuando el cliente corta la conexión a mitad de una subida larga (habitual con
// ficheros de varios GB: WiFi inestable, portátil suspendido, pestaña en segundo
// plano...), Node emite un evento 'error' en el request/response. Si no hay ningún
// listener para ese evento, Node lo relanza como excepción y puede tumbar TODO el
// proceso, no solo esa subida. Lo capturamos aquí explícitamente en cuanto entra
// cada petición, antes de que multer o cualquier otro middleware pueda toparse
// con ese error sin nadie escuchándolo.
app.use((req, res, next) => {
  req.on('error', (err) => {
    console.warn(`[conexión interrumpida] ${req.method} ${req.originalUrl}: ${err.message}`);
  });
  res.on('error', (err) => {
    console.warn(`[error de respuesta] ${req.method} ${req.originalUrl}: ${err.message}`);
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    name: 'fileshare.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
      sameSite: 'lax',
      secure: COOKIE_SECURE, // true cuando se sirve detrás de HTTPS (ver docker-compose.https.yml)
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/admin/api/')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  return res.redirect('/login');
}

// ---------- Multer (subida de ficheros) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    // Guardamos con el id como nombre físico para evitar colisiones/inyección de rutas
    cb(null, id);
  },
});

const upload = multer({
  storage,
  // MAX_FILE_SIZE_MB=0 (o negativo) => sin límite de tamaño
  limits: MAX_FILE_SIZE_MB > 0 ? { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 } : {},
});

// ---------- Notificaciones de Telegram en cada descarga ----------
// Usa el "fetch" global de Node (disponible desde Node 18+, ya incluido en la
// imagen node:20-alpine), así que no hace falta ninguna dependencia adicional.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

if (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_ENABLED) {
    console.warn(
      '[telegram] Se ha definido TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID pero falta el otro; ' +
      'las notificaciones de descarga quedan desactivadas hasta que definas ambos.'
    );
  } else {
    console.log('[telegram] Notificaciones de descarga activadas.');
  }
}

// Las direcciones IPv4 llegan a veces con el prefijo IPv6 "::ffff:" (p. ej. detrás
// de Caddy); lo quitamos para que la IP se lea de forma clara en la notificación.
function normalizeIp(ip) {
  if (!ip) return 'desconocida';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function formatBytesForTelegram(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'desconocido';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Envía la notificación en segundo plano (no bloquea la descarga) y nunca lanza
// un error hacia arriba: un fallo de red al notificar no debe afectar nunca a
// la descarga real del fichero.
async function notifyTelegramDownload({ originalName, size, ip }) {
  if (!TELEGRAM_ENABLED) return;

  const text =
    `📥 Descarga de fichero\n` +
    `Fichero: ${originalName}\n` +
    `Tamaño: ${formatBytesForTelegram(size)}\n` +
    `IP origen: ${ip}\n` +
    `Fecha: ${new Date().toLocaleString('es-ES')}`;

  try {
    await telegramApiCall('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text }, 8000);
  } catch (err) {
    console.warn('[telegram] Error al enviar notificación de descarga:', err.message);
  }
}

// ---------- Bot de Telegram: comandos (/status, /list, /delete, /subir, /listardescargas) ----------
// Solo el/los chat_id indicados pueden usar los comandos, para que nadie más pueda
// listar, borrar o subir ficheros a través del bot aunque adivine el usuario del bot.
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isTelegramChatAuthorized(chatId) {
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

// Llamada genérica a la Bot API de Telegram. Lanza un error si la respuesta no es
// "ok" o si la petición supera el timeout indicado (protección extra frente a
// cuelgues de red, además del propio timeout de sondeo largo de /getUpdates).
async function telegramApiCall(method, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      throw new Error(`Telegram API ${method} falló: ${data ? JSON.stringify(data) : res.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function telegramSendMessage(chatId, text, extra = {}) {
  return telegramApiCall('sendMessage', { chat_id: chatId, text, ...extra });
}

function truncateForButton(name, max = 40) {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

function listFilesForTelegram() {
  return db.files.slice().sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

async function handleHelpCommand(chatId) {
  const text =
    '🤖 Comandos disponibles:\n\n' +
    '/status — Comprobar el estado de la aplicación\n' +
    '/list — Listar los ficheros cargados\n' +
    '/delete — Borrar un fichero (elige de un menú)\n' +
    '/subir — Subir un fichero nuevo\n' +
    '/listardescargas — Ver el historial de descargas de un fichero';
  await telegramSendMessage(chatId, text);
}

async function handleStatusCommand(chatId) {
  const totalFiles = db.files.length;
  const totalSize = db.files.reduce((acc, f) => acc + (f.size || 0), 0);
  const totalDownloads = db.files.reduce((acc, f) => acc + (f.downloads || 0), 0);
  const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  const text =
    `✅ FileShare en marcha\n` +
    `Tiempo activo: ${formatUptime(process.uptime())}\n` +
    `Ficheros almacenados: ${totalFiles}\n` +
    `Espacio ocupado: ${formatBytesForTelegram(totalSize)}\n` +
    `Descargas totales: ${totalDownloads}\n` +
    `Memoria del proceso: ${memMB} MB`;
  await telegramSendMessage(chatId, text);
}

async function handleListCommand(chatId) {
  const files = listFilesForTelegram();
  if (files.length === 0) {
    await telegramSendMessage(chatId, 'No hay ficheros subidos todavía.');
    return;
  }
  const MAX_LIST = 40;
  const lines = files
    .slice(0, MAX_LIST)
    .map((f, i) => `${i + 1}. ${f.originalName} — ${formatBytesForTelegram(f.size)} — ${f.downloads || 0} descargas`);
  let text = `📄 Ficheros (${files.length}):\n\n${lines.join('\n')}`;
  if (files.length > MAX_LIST) text += `\n\n… y ${files.length - MAX_LIST} más.`;
  await telegramSendMessage(chatId, text);
}

async function handleDeleteCommand(chatId) {
  const files = listFilesForTelegram();
  if (files.length === 0) {
    await telegramSendMessage(chatId, 'No hay ficheros para borrar.');
    return;
  }
  const MAX_BUTTONS = 30;
  const keyboard = files
    .slice(0, MAX_BUTTONS)
    .map((f) => [{ text: `🗑 ${truncateForButton(f.originalName)}`, callback_data: `del:${f.id}` }]);
  await telegramSendMessage(chatId, 'Elige el fichero a eliminar:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleListarDescargasCommand(chatId) {
  const files = listFilesForTelegram();
  if (files.length === 0) {
    await telegramSendMessage(chatId, 'No hay ficheros subidos todavía.');
    return;
  }
  const MAX_BUTTONS = 30;
  const keyboard = files
    .slice(0, MAX_BUTTONS)
    .map((f) => [{ text: `📊 ${truncateForButton(f.originalName)} (${f.downloads || 0})`, callback_data: `dl:${f.id}` }]);
  await telegramSendMessage(chatId, 'Elige un fichero para ver sus descargas:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleShowDownloadsForFile(chatId, fileId) {
  const file = db.files.find((f) => f.id === fileId);
  if (!file) {
    await telegramSendMessage(chatId, 'Ese fichero ya no existe.');
    return;
  }
  const history = file.downloadHistory || [];
  if (history.length === 0) {
    await telegramSendMessage(chatId, `"${file.originalName}" todavía no se ha descargado.`);
    return;
  }
  const MAX_ENTRIES = 30;
  const lines = history
    .slice(-MAX_ENTRIES)
    .reverse()
    .map((h) => `${new Date(h.timestamp).toLocaleString('es-ES')} — ${h.ip}`);
  let text = `📊 Descargas de "${file.originalName}" (${history.length} en total):\n\n${lines.join('\n')}`;
  if (history.length > MAX_ENTRIES) text += `\n\n… mostrando las ${MAX_ENTRIES} más recientes.`;
  await telegramSendMessage(chatId, text);
}

// Estado en memoria: qué chats están a la espera de recibir un fichero tras /subir.
// No hace falta persistirlo (si se reinicia el proceso, simplemente habría que
// volver a ejecutar /subir).
const pendingUploadChats = new Set();

async function handleSubirCommand(chatId) {
  pendingUploadChats.add(String(chatId));
  await telegramSendMessage(chatId, '📤 Envíame el fichero que quieras subir (como documento/archivo, no como foto comprimida).');
}

async function handleDocumentMessage(message) {
  const chatId = message.chat.id;
  if (!pendingUploadChats.has(String(chatId))) {
    await telegramSendMessage(chatId, 'Si quieres subir un fichero, usa antes el comando /subir.');
    return;
  }
  pendingUploadChats.delete(String(chatId));

  const doc = message.document;
  if (!doc) return;

  try {
    const fileInfo = await telegramApiCall('getFile', { file_id: doc.file_id });
    const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const id = uuidv4();
    const destPath = path.join(UPLOADS_DIR, id);

    const res = await fetch(downloadUrl);
    if (!res.ok || !res.body) throw new Error(`Descarga desde Telegram falló (HTTP ${res.status})`);

    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));

    const stats = fs.statSync(destPath);
    const originalName = doc.file_name || `telegram-${id}`;
    const entry = {
      id,
      storedName: id,
      originalName,
      size: stats.size,
      mimeType: doc.mime_type || mime.lookup(originalName) || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      downloads: 0,
      downloadHistory: [],
      source: 'telegram',
    };
    db.files.push(entry);
    saveDB(db);

    const link = `${BASE_URL}/d/${id}`;
    await telegramSendMessage(
      chatId,
      `✅ Fichero subido: "${originalName}" (${formatBytesForTelegram(stats.size)})\n${link}`
    );
    console.log(`[telegram] Fichero subido vía bot: "${originalName}" (${id})`);
  } catch (err) {
    console.error('[telegram] Error al subir fichero recibido:', err.message);
    await telegramSendMessage(chatId, `❌ No se pudo subir el fichero: ${err.message}`).catch(() => {});
  }
}

async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!isTelegramChatAuthorized(chatId)) {
    await telegramApiCall('answerCallbackQuery', { callback_query_id: query.id, text: 'No autorizado.' }).catch(() => {});
    return;
  }

  try {
    if (data.startsWith('del:')) {
      const fileId = data.slice(4);
      const idx = db.files.findIndex((f) => f.id === fileId);
      if (idx === -1) {
        await telegramApiCall('answerCallbackQuery', { callback_query_id: query.id, text: 'Ese fichero ya no existe.' });
        return;
      }
      const [file] = db.files.splice(idx, 1);
      const filePath = path.join(UPLOADS_DIR, file.storedName);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('[telegram] No se pudo borrar el fichero físico:', e.message);
        }
      }
      saveDB(db);
      await telegramApiCall('answerCallbackQuery', { callback_query_id: query.id, text: 'Eliminado.' });
      await telegramApiCall('editMessageText', {
        chat_id: chatId,
        message_id: query.message.message_id,
        text: `🗑 "${file.originalName}" eliminado.`,
      });
    } else if (data.startsWith('dl:')) {
      const fileId = data.slice(3);
      await telegramApiCall('answerCallbackQuery', { callback_query_id: query.id });
      await handleShowDownloadsForFile(chatId, fileId);
    } else {
      await telegramApiCall('answerCallbackQuery', { callback_query_id: query.id });
    }
  } catch (err) {
    console.error('[telegram] Error procesando callback:', err.message);
  }
}

async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  if (!isTelegramChatAuthorized(chatId)) return; // ignoramos por completo chats no autorizados

  if (message.document) {
    await handleDocumentMessage(message);
    return;
  }

  const text = (message.text || '').trim();
  if (!text.startsWith('/')) return;

  // Quita un posible "@NombreDelBot" que Telegram añade al comando en chats de grupo
  const command = text.split(' ')[0].split('@')[0];

  switch (command) {
    case '/status':
      return handleStatusCommand(chatId);
    case '/list':
      return handleListCommand(chatId);
    case '/delete':
      return handleDeleteCommand(chatId);
    case '/subir':
      return handleSubirCommand(chatId);
    case '/listardescargas':
      return handleListarDescargasCommand(chatId);
    case '/start':
    case '/help':
      return handleHelpCommand(chatId);
    default:
      return telegramSendMessage(chatId, 'Comando no reconocido. Envía /help para ver los comandos disponibles.');
  }
}

async function registerTelegramCommands() {
  try {
    await telegramApiCall('setMyCommands', {
      commands: [
        { command: 'status', description: 'Comprobar el estado de la aplicación' },
        { command: 'list', description: 'Listar los ficheros cargados' },
        { command: 'delete', description: 'Borrar un fichero' },
        { command: 'subir', description: 'Subir un fichero nuevo' },
        { command: 'listardescargas', description: 'Ver descargas de un fichero' },
      ],
    });
  } catch (err) {
    console.warn('[telegram] No se pudieron registrar los comandos del bot:', err.message);
  }
}

let telegramPollingOffset = 0;

async function telegramPollLoop() {
  // Vaciamos primero cualquier actualización pendiente de antes de arrancar (p. ej.
  // comandos enviados mientras el contenedor estaba parado), para no reprocesarlos
  // de golpe al iniciar — como borrar un fichero por sorpresa por un /delete antiguo.
  try {
    const initial = await telegramApiCall('getUpdates', { timeout: 0 }, 10000);
    if (initial.length > 0) {
      telegramPollingOffset = initial[initial.length - 1].update_id + 1;
    }
  } catch (err) {
    console.warn('[telegram] No se pudo vaciar la cola inicial de actualizaciones:', err.message);
  }

  for (;;) {
    try {
      const updates = await telegramApiCall(
        'getUpdates',
        { offset: telegramPollingOffset, timeout: 25 },
        35000
      );
      for (const update of updates) {
        telegramPollingOffset = update.update_id + 1;
        try {
          if (update.message) await handleTelegramMessage(update.message);
          else if (update.callback_query) await handleCallbackQuery(update.callback_query);
        } catch (err) {
          console.error('[telegram] Error procesando una actualización:', err.message);
        }
      }
    } catch (err) {
      console.warn('[telegram] Error en el sondeo de actualizaciones, reintentando en 5s:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (TELEGRAM_ENABLED) {
  registerTelegramCommands();
  telegramPollLoop();
  console.log('[telegram] Bot de comandos iniciado (sondeo activo).');
}

// ---------- Páginas públicas ----------
// Endpoint ligero para comprobaciones de salud (Docker HEALTHCHECK, balanceadores,
// monitorización externa...). No requiere autenticación y no expone datos sensibles.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.redirect(req.session && req.session.userId ? '/admin' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!db.admin) {
    return res.status(500).json({ error: 'No hay usuario admin configurado en el servidor.' });
  }
  if (username !== db.admin.username) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  const ok = bcrypt.compareSync(password || '', db.admin.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  req.session.userId = db.admin.username;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ---------- Descarga directa (pública, no requiere login) ----------
app.get('/d/:id', (req, res) => {
  const file = db.files.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).send('Fichero no encontrado.');

  const filePath = path.join(UPLOADS_DIR, file.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Fichero no encontrado en disco.');

  // Algunos gestores de descargas piden el fichero por trozos (cabecera Range) para
  // poder reanudar; solo contamos/registramos/notificamos en la petición inicial (sin
  // Range, o Range que empieza en el byte 0), para que el contador de descargas y el
  // historial no se disparen con cada trozo reanudado y ambos siempre coincidan.
  const rangeHeader = req.headers.range;
  const isResumedRangeRequest = rangeHeader && !/^bytes=0-/.test(rangeHeader);
  if (!isResumedRangeRequest) {
    const ip = normalizeIp(req.ip);

    file.downloads = (file.downloads || 0) + 1;

    if (!Array.isArray(file.downloadHistory)) file.downloadHistory = [];
    file.downloadHistory.push({ timestamp: new Date().toISOString(), ip });
    // Limitamos el historial guardado por fichero para que db.json no crezca sin control.
    const MAX_HISTORY_PER_FILE = 200;
    if (file.downloadHistory.length > MAX_HISTORY_PER_FILE) {
      file.downloadHistory = file.downloadHistory.slice(-MAX_HISTORY_PER_FILE);
    }

    notifyTelegramDownload({ originalName: file.originalName, size: file.size, ip });
    saveDB(db);
  }

  res.download(filePath, file.originalName);
});

// ---------- Panel de administración (protegido) ----------
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});

app.get('/admin/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.userId });
});

app.get('/admin/api/files', requireAuth, (req, res) => {
  const files = db.files
    .slice()
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map((f) => ({
      id: f.id,
      originalName: f.originalName,
      size: f.size,
      mimeType: f.mimeType,
      uploadedAt: f.uploadedAt,
      downloads: f.downloads || 0,
      link: `${BASE_URL}/d/${f.id}`,
      source: f.source || 'upload',
    }));
  res.json({ files, baseUrl: BASE_URL });
});

app.get('/admin/api/files/:id/downloads', requireAuth, (req, res) => {
  const file = db.files.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Fichero no encontrado.' });
  const history = (file.downloadHistory || []).slice().reverse(); // más recientes primero
  res.json({ originalName: file.originalName, downloads: file.downloads || 0, history });
});

app.post('/admin/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se ha recibido ningún fichero.' });

  const entry = {
    id: path.basename(req.file.filename),
    storedName: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
    uploadedAt: new Date().toISOString(),
    downloads: 0,
    downloadHistory: [],
  };
  db.files.push(entry);
  saveDB(db);

  res.json({
    ok: true,
    file: { ...entry, link: `${BASE_URL}/d/${entry.id}` },
  });
});

app.delete('/admin/api/files/:id', requireAuth, (req, res) => {
  const idx = db.files.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Fichero no encontrado.' });

  const [file] = db.files.splice(idx, 1);
  const filePath = path.join(UPLOADS_DIR, file.storedName);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error('No se pudo borrar el fichero físico:', e.message);
    }
  }
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Manejo de errores de multer (p.ej. fichero demasiado grande) ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `El fichero supera el límite de ${MAX_FILE_SIZE_MB} MB.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err && (err.code === 'ENOSPC')) {
    console.error('[ERROR] Sin espacio en disco al escribir el fichero:', err.message);
    return res.status(507).json({ error: 'No queda espacio en disco en el servidor.' });
  }
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const server = app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT} (BASE_URL=${BASE_URL})`);
});

// Desde Node 18, el servidor HTTP corta por defecto cualquier petición que tarde
// más de 5 minutos en completarse (server.requestTimeout = 300000 ms). Con ficheros
// grandes en redes lentas o en hardware ARM con I/O más lento, ese tiempo se supera
// con facilidad y Node aborta la conexión a mitad de subida. Lo desactivamos.
server.requestTimeout = 0; // sin límite de tiempo para completar una petición (p.ej. subidas grandes)
server.headersTimeout = 0; // sin límite de tiempo para recibir las cabeceras
server.keepAliveTimeout = 65000;

// Salvaguarda: un error no controlado durante una subida (p.ej. un problema de E/S
// a mitad de escritura) no debe tumbar todo el proceso y afectar al resto de
// usuarios. Se registra y el proceso sigue vivo; esa petición concreta fallará,
// pero el servicio no se cae por completo.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] El proceso ha capturado un error no controlado:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Promesa rechazada sin gestionar:', reason);
});
