#!/usr/bin/env python3
"""
caddy-tui — utilidad de terminal (TUI) para gestionar el Caddy de FileShare.

Sin dependencias: solo Python 3 (stdlib, curses) y Docker. Ejecútalo desde
cualquier sitio; trabaja siempre sobre la carpeta donde está este fichero:

    ./caddy-tui.py

Permite: ver el estado, añadir servicios con un asistente, monitorizar el
tráfico en vivo, editar el Caddyfile (con validación previa y copia de
seguridad), validar, formatear, arrancar, parar, reiniciar, recargar la
configuración en caliente, ver logs y restaurar copias anteriores.

Variables de entorno opcionales:
    CADDY_CONTAINER  nombre del contenedor        (def. fileshare-caddy)
    CADDY_SERVICE    servicio en docker compose   (def. caddy)
    CADDY_COMPOSE    fichero compose              (def. docker-compose.https.yml)
    CADDY_IMAGE      imagen para validar offline  (def. caddy:2-alpine)
    EDITOR           editor a usar                (def. nano / vi)
"""
import curses
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from collections import Counter, deque
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
CONTAINER = os.environ.get("CADDY_CONTAINER", "fileshare-caddy")
SERVICE = os.environ.get("CADDY_SERVICE", "caddy")
COMPOSE = os.environ.get("CADDY_COMPOSE", "docker-compose.https.yml")
IMAGE = os.environ.get("CADDY_IMAGE", "caddy:2-alpine")
CADDYFILE = os.path.join(BASE, "Caddyfile")
ENVFILE = os.path.join(BASE, ".env")
BACKUPS = os.path.join(BASE, ".caddy-backups")
CONF_IN_CONTAINER = "/etc/caddy/Caddyfile"

MENU = [
    ("a", "Añadir servicio (asistente)"),
    ("t", "Monitor de tráfico"),
    ("e", "Editar Caddyfile"),
    ("v", "Validar configuración"),
    ("l", "Recargar (sin cortes)"),
    ("s", "Arrancar / aplicar"),
    ("x", "Parar"),
    ("r", "Reiniciar"),
    ("g", "Ver logs"),
    ("f", "Formatear Caddyfile"),
    ("c", "Ver Caddyfile"),
    ("k", "Crear backup (Caddyfile+.env)"),
    ("b", "Restaurar backup"),
    ("n", "Editar .env (DOMAIN...)"),
    ("q", "Salir"),
]


# ----------------------------------------------------------------- helpers ---
def run(cmd, stdin=None, timeout=120):
    """Ejecuta un comando y devuelve (código, salida combinada)."""
    try:
        p = subprocess.run(
            cmd, cwd=BASE, input=stdin, capture_output=True, text=True, timeout=timeout
        )
        return p.returncode, (p.stdout + p.stderr).rstrip()
    except FileNotFoundError:
        return 127, f"No se encuentra el comando: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"Tiempo agotado ejecutando: {' '.join(cmd)}"


def compose(*args):
    return ["docker", "compose", "-f", COMPOSE, *args]


def read_env(key):
    try:
        with open(ENVFILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return ""


def container_state():
    """Devuelve (estado, desde) — estado: running/exited/... o 'no existe'."""
    rc, out = run(
        ["docker", "inspect", "-f", "{{.State.Status}}|{{.State.StartedAt}}", CONTAINER],
        timeout=10,
    )
    if rc != 0:
        if "docker" in out.lower() and "daemon" in out.lower():
            return "docker no disponible", ""
        return "no existe", ""
    state, _, started = out.partition("|")
    return state, started


def uptime(started):
    try:
        t = datetime.strptime(started[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        secs = int((datetime.now(timezone.utc) - t).total_seconds())
    except ValueError:
        return ""
    d, r = divmod(secs, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    return (f"{d}d " if d else "") + f"{h}h {m}m"


def validate_text(text):
    """Valida el texto de un Caddyfile sin tocar el contenedor en marcha."""
    domain = read_env("DOMAIN") or "example.com"
    state, _ = container_state()
    if state == "running":
        cmd = ["docker", "exec", "-i", CONTAINER, "caddy", "validate",
               "--config", "/dev/stdin", "--adapter", "caddyfile"]
    else:
        cmd = ["docker", "run", "--rm", "-i", "-e", f"DOMAIN={domain}", IMAGE,
               "caddy", "validate", "--config", "/dev/stdin", "--adapter", "caddyfile"]
    rc, out = run(cmd, stdin=text, timeout=60)
    return rc == 0, pretty_logs(out)


def pretty_logs(raw):
    """Convierte líneas JSON de Caddy en texto legible; deja el resto igual."""
    lines = []
    for line in raw.splitlines():
        try:
            j = json.loads(line)
            ts = datetime.fromtimestamp(j.pop("ts")).strftime("%H:%M:%S")
            lvl = str(j.pop("level", "")).upper()
            logger = j.pop("logger", "")
            msg = j.pop("msg", "")
            extra = " ".join(f"{k}={v}" for k, v in j.items() if k in ("error", "file", "host", "uri", "status"))
            lines.append(f"{ts} {lvl:5} {logger} {msg} {extra}".rstrip())
        except (ValueError, KeyError, TypeError):
            lines.append(line)
    return "\n".join(lines)


def backup_caddyfile():
    os.makedirs(BACKUPS, exist_ok=True)
    dest = os.path.join(BACKUPS, "Caddyfile." + datetime.now().strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(CADDYFILE, dest)
    return dest


def write_in_place(text):
    """Escribe sobre el mismo inodo: un bind-mount de fichero único de Docker
    dejaría de ver los cambios si el fichero se reemplazara por otro nuevo."""
    with open(CADDYFILE, "r+", encoding="utf-8") as f:
        f.seek(0)
        f.truncate()
        f.write(text)


# ------------------------------------------------- servicios (asistente) ---
HOST_RE = re.compile(r"^(?:https?://)?[A-Za-z0-9*]([A-Za-z0-9.\-*]*[A-Za-z0-9])?(:\d{1,5})?$|^\{\$[A-Z_]+\}$")


def site_addresses(text):
    """Direcciones de los bloques de nivel superior del Caddyfile."""
    sites, depth = [], 0
    for line in text.splitlines():
        stripped = line.strip()
        if depth == 0 and stripped and not stripped.startswith("#") and stripped.endswith("{"):
            head = stripped[:-1].strip()
            if head:  # el bloque de opciones globales es "{" a secas
                sites += [a.strip().rstrip(",") for a in head.split() if a.strip(",")]
        depth += line.count("{") - line.count("}")
        depth = max(depth, 0)
    return sites


def hash_password(plain):
    rc, out = run(["docker", "run", "--rm", "-i", IMAGE, "caddy", "hash-password"],
                  stdin=plain + "\n", timeout=60)
    return out.strip() if rc == 0 and out.startswith("$") else None


def build_site_block(v, pw_hash=None):
    upstream = v["upstream"].strip()
    if v["https_upstream"] and "://" not in upstream:
        upstream = "https://" + upstream
    lines = [f"# Servicio añadido con caddy-tui ({datetime.now():%Y-%m-%d %H:%M})",
             f"{v['host'].strip()} {{"]
    if v["user"] and pw_hash:
        lines += ["\tbasic_auth {", f"\t\t{v['user'].strip()} {pw_hash}", "\t}"]
    if v["https_upstream"] and v["skip_verify"]:
        lines += [f"\treverse_proxy {upstream} {{", "\t\ttransport http {",
                  "\t\t\ttls_insecure_skip_verify", "\t\t}", "\t}"]
    else:
        lines.append(f"\treverse_proxy {upstream}")
    if v["gzip"]:
        lines.append("\tencode gzip")
    if v["headers"]:
        lines += ["\theader {",
                  '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"',
                  '\t\tX-Content-Type-Options "nosniff"',
                  '\t\tX-Frame-Options "DENY"', "\t}"]
    if v["log"]:
        lines.append("\tlog")
    lines.append("}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------- monitor de tráfico ------
SPARK = "▁▂▃▄▅▆▇█"


def human_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


class TrafficFeed:
    """Lee en segundo plano `docker logs -f` y extrae los accesos HTTP."""

    def __init__(self, preload="15m"):
        self.events = deque(maxlen=50000)  # (ts, host, método, uri, ip, status, bytes, seg)
        self.q = queue.Queue()
        self.alive = True
        self.proc = subprocess.Popen(
            ["docker", "logs", "-f", "--since", preload, CONTAINER],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, cwd=BASE,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if not str(j.get("logger", "")).startswith("http.log.access"):
                continue
            r = j.get("request", {})
            self.q.put((
                float(j.get("ts", time.time())),
                r.get("host", "-"), r.get("method", "-"), r.get("uri", "-"),
                r.get("client_ip") or r.get("remote_ip", "-"),
                int(j.get("status", 0)), int(j.get("size", 0)), float(j.get("duration", 0)),
            ))
        self.alive = False

    def drain(self):
        n = 0
        while True:
            try:
                self.events.append(self.q.get_nowait())
                n += 1
            except queue.Empty:
                return n

    def close(self):
        try:
            self.proc.terminate()
        except OSError:
            pass


# --------------------------------------------------------------------- UI ----
class App:
    def __init__(self, scr):
        self.scr = scr
        self.out = ["Bienvenido. Pulsa una tecla del menú."]
        self.title = "Salida"
        self.scroll = 0
        self.state = ("?", "")
        self.last_refresh = 0
        curses.curs_set(0)
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_GREEN, -1)
        curses.init_pair(2, curses.COLOR_RED, -1)
        curses.init_pair(3, curses.COLOR_YELLOW, -1)
        curses.init_pair(4, curses.COLOR_CYAN, -1)
        scr.timeout(1000)

    # -- salida
    def show(self, title, text):
        self.title = title
        self.out = text.splitlines() or ["(sin salida)"]
        self.scroll = 0

    def refresh_state(self, force=False):
        if force or time.time() - self.last_refresh > 3:
            self.state = container_state()
            self.last_refresh = time.time()

    # -- dibujo
    def draw(self):
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 12 or w < 50:
            scr.addstr(0, 0, "Terminal demasiado pequeña (mín. 50x12)")
            scr.refresh()
            return
        state, started = self.state
        color = {"running": 1, "exited": 2, "no existe": 2}.get(state, 3)
        scr.addstr(0, 0, " Caddy · FileShare ".ljust(w), curses.A_REVERSE)
        scr.addstr(1, 1, "Contenedor: ")
        scr.addstr(f"{CONTAINER} ")
        scr.addstr(f"● {state}", curses.color_pair(color) | curses.A_BOLD)
        if state == "running":
            scr.addstr(f"  (activo {uptime(started)})")
        scr.addstr(2, 1, f"Dominio: {read_env('DOMAIN') or '(DOMAIN no definido en .env)'}")

        # menú en dos columnas
        top = 4
        colw = max(30, min(w // 2, 34))
        rows = (len(MENU) + 1) // 2
        for i, (k, label) in enumerate(MENU):
            y, x = top + i % rows, 1 + (i // rows) * colw
            if y < h - 3 and x + colw <= w + 2:
                scr.addstr(y, x, f"[{k}]", curses.color_pair(4) | curses.A_BOLD)
                scr.addstr(f" {label}"[: colw - 5])

        # panel de salida
        oy = top + rows + 1
        scr.addstr(oy, 0, f" {self.title} ".ljust(w), curses.A_UNDERLINE)
        avail = h - oy - 2
        max_scroll = max(0, len(self.out) - avail)
        self.scroll = max(0, min(self.scroll, max_scroll))
        for i, line in enumerate(self.out[self.scroll : self.scroll + avail]):
            attr = 0
            low = line.lower()
            if "error" in low or "fail" in low or "inválid" in low:
                attr = curses.color_pair(2)
            elif "valid configuration" in low or low.startswith("✔"):
                attr = curses.color_pair(1)
            scr.addstr(oy + 1 + i, 1, line[: w - 2].replace("\t", "    "), attr)
        hint = "↑/↓ PgUp/PgDn desplazar salida"
        if max_scroll:
            hint += f"  [{self.scroll + 1}-{min(self.scroll + avail, len(self.out))}/{len(self.out)}]"
        scr.addstr(h - 1, 0, hint[: w - 1], curses.A_DIM)
        scr.refresh()

    # -- diálogos
    def ask(self, question, default=False):
        h, w = self.scr.getmaxyx()
        suffix = " [S/n] " if default else " [s/N] "
        self.scr.addstr(h - 1, 0, (question + suffix).ljust(w - 1)[: w - 1], curses.A_REVERSE)
        self.scr.refresh()
        self.scr.timeout(-1)
        try:
            while True:
                k = self.scr.getch()
                if k in (ord("s"), ord("S"), ord("y"), ord("Y")):
                    return True
                if k in (ord("n"), ord("N"), 27):
                    return False
                if k in (10, 13, curses.KEY_ENTER):
                    return default
        finally:
            self.scr.timeout(1000)

    def pick(self, title, items):
        """Selector sencillo de lista; devuelve el índice o None."""
        sel = 0
        self.scr.timeout(-1)
        try:
            while True:
                h, w = self.scr.getmaxyx()
                self.scr.erase()
                self.scr.addstr(0, 0, f" {title} ".ljust(w), curses.A_REVERSE)
                for i, it in enumerate(items[: h - 3]):
                    self.scr.addstr(i + 1, 2, it[: w - 4], curses.A_REVERSE if i == sel else 0)
                self.scr.addstr(h - 1, 0, "↑/↓ elegir · Enter aceptar · Esc cancelar"[: w - 1], curses.A_DIM)
                k = self.scr.getch()
                if k == curses.KEY_UP:
                    sel = max(0, sel - 1)
                elif k == curses.KEY_DOWN:
                    sel = min(len(items) - 1, sel + 1)
                elif k in (10, 13, curses.KEY_ENTER):
                    return sel
                elif k == 27:
                    return None
        finally:
            self.scr.timeout(1000)

    def external_editor(self, path):
        editor = os.environ.get("EDITOR") or shutil.which("nano") or "vi"
        curses.def_prog_mode()
        curses.endwin()
        try:
            subprocess.call(f'{editor} "{path}"', shell=True)
        finally:
            curses.reset_prog_mode()
            self.scr.refresh()
            curses.curs_set(0)

    # -- acciones
    def busy(self, msg):
        self.show("Trabajando...", msg)
        self.draw()

    def act_validate(self):
        self.busy("Validando Caddyfile...")
        with open(CADDYFILE, encoding="utf-8") as f:
            ok, out = validate_text(f.read())
        self.show("Validación: " + ("✔ CORRECTA" if ok else "✘ ERRORES"), out)
        return ok

    def act_reload(self):
        state, _ = container_state()
        if state != "running":
            self.show("Recargar", "El contenedor no está en marcha. Usa [s] para arrancarlo.")
            return
        if not self.act_validate():
            return
        self.busy("Recargando configuración...")
        rc, out = run(["docker", "exec", CONTAINER, "caddy", "reload",
                       "--config", CONF_IN_CONTAINER, "--adapter", "caddyfile"], timeout=60)
        out = pretty_logs(out)
        if rc == 0:
            out = "✔ Configuración recargada sin cortes.\n" + out
        self.show("Recargar: " + ("OK" if rc == 0 else "ERROR"), out)

    def act_compose(self, title, *args, confirm=None):
        if confirm and not self.ask(confirm):
            return
        self.busy(f"{title}...")
        rc, out = run(compose(*args), timeout=180)
        self.show(f"{title}: " + ("OK" if rc == 0 else "ERROR"), out or "(hecho)")
        self.refresh_state(True)

    def act_start(self):
        self.act_compose("Arrancar / aplicar", "up", "-d", SERVICE)

    def act_logs(self):
        self.busy("Leyendo logs...")
        rc, out = run(["docker", "logs", "--tail", "200", CONTAINER], timeout=20)
        self.show(f"Logs de {CONTAINER} (últimas 200 líneas)", pretty_logs(out))
        self.scroll = 10**6  # al final

    def act_view(self):
        with open(CADDYFILE, encoding="utf-8") as f:
            self.show("Caddyfile", f.read())

    def act_format(self):
        with open(CADDYFILE, encoding="utf-8") as f:
            text = f.read()
        self.busy("Formateando...")
        rc, out = run(["docker", "run", "--rm", "-i", IMAGE, "caddy", "fmt", "-"], stdin=text, timeout=60)
        if rc != 0:
            self.show("Formatear: ERROR", out)
        elif out.strip() == text.strip():
            self.show("Formatear", "✔ El Caddyfile ya está correctamente formateado.")
        else:
            backup_caddyfile()
            write_in_place(out + "\n")
            self.show("Formatear", "✔ Caddyfile reformateado (copia en .caddy-backups/).")

    def act_edit(self):
        with open(CADDYFILE, encoding="utf-8") as f:
            original = f.read()
        fd, tmp = tempfile.mkstemp(prefix="Caddyfile.", suffix=".edit")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(original)
            while True:
                self.external_editor(tmp)
                with open(tmp, encoding="utf-8") as f:
                    new = f.read()
                if new == original:
                    self.show("Editar", "Sin cambios.")
                    return
                self.busy("Validando cambios...")
                ok, out = validate_text(new)
                if ok:
                    break
                self.show("✘ La configuración NO es válida", out)
                self.draw()
                if not self.ask("¿Volver a editar? (No = descartar cambios)", True):
                    self.show("Editar", "Cambios descartados. El Caddyfile no se ha modificado.\n\n" + out)
                    return
            bk = backup_caddyfile()
            write_in_place(new)
            self.show("Editar", f"✔ Caddyfile guardado y validado.\nCopia anterior: {os.path.relpath(bk, BASE)}")
            self.draw()
            state, _ = container_state()
            if state == "running" and self.ask("¿Recargar Caddy ahora?", True):
                self.act_reload()
        finally:
            os.path.exists(tmp) and os.unlink(tmp)

    def act_backup(self):
        os.makedirs(BACKUPS, exist_ok=True)
        dest = os.path.join(BACKUPS, "full-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".tar.gz")
        names = [n for n in ("Caddyfile", ".env") if os.path.exists(os.path.join(BASE, n))]
        with tarfile.open(dest, "w:gz") as tar:
            for n in names:
                tar.add(os.path.join(BASE, n), arcname=n)
        os.chmod(dest, 0o600)  # .env contiene secretos
        self.show("Backup", f"✔ Backup creado: {os.path.relpath(dest, BASE)}\nContiene: {', '.join(names)}")

    def act_restore(self):
        files = sorted(os.listdir(BACKUPS), reverse=True) if os.path.isdir(BACKUPS) else []
        if not files:
            self.show("Restaurar", "No hay backups todavía. Crea uno con [k] (también se crean copias al editar).")
            return
        labels = [
            f + ("   (Caddyfile + .env)" if f.endswith(".tar.gz") else "   (solo Caddyfile)")
            for f in files
        ]
        i = self.pick("Elige el backup a restaurar", labels)
        if i is None:
            return
        src = os.path.join(BACKUPS, files[i])
        env_text = None
        if src.endswith(".tar.gz"):
            with tarfile.open(src, "r:gz") as tar:
                text = tar.extractfile("Caddyfile").read().decode("utf-8")
                if ".env" in tar.getnames():
                    env_text = tar.extractfile(".env").read().decode("utf-8")
        else:
            with open(src, encoding="utf-8") as f:
                text = f.read()
        self.busy("Validando backup...")
        ok, out = validate_text(text)
        if not ok:
            self.show("El Caddyfile del backup no es válido; no se restaura", out)
            return
        what = "Caddyfile" + (" y .env" if env_text is not None else "")
        if not self.ask(f"¿Restaurar {what}? Se hará backup del estado actual antes"):
            return
        self.act_backup()
        write_in_place(text)
        if env_text is not None:
            with open(ENVFILE, "w", encoding="utf-8") as f:
                f.write(env_text)
        self.show("Restaurar", f"✔ Restaurado {what} desde {files[i]}.\n"
                  "Usa [l] para recargar el Caddyfile" + (" o [s] para aplicar cambios de .env." if env_text is not None else "."))

    # -- formulario modal (asistentes)
    def form(self, title, fields, validator):
        """Formulario a pantalla completa. Devuelve {clave: valor} o None."""
        vals = {f["key"]: f["value"] for f in fields}
        nb, sel, err = len(fields), 0, ""
        self.scr.timeout(-1)
        try:
            while True:
                h, w = self.scr.getmaxyx()
                self.scr.erase()
                self.scr.addstr(0, 0, f" {title} ".ljust(w - 1), curses.A_REVERSE)
                vx = 34
                for i, f in enumerate(fields):
                    v, focused = vals[f["key"]], sel == i
                    if f["kind"] == "bool":
                        shown = "[x] sí" if v else "[ ] no"
                    elif f["kind"] == "secret":
                        shown = "*" * len(v)
                    else:
                        shown = v
                    if focused and f["kind"] != "bool":
                        shown += "▏"
                    self.scr.addstr(2 + i, 2, f["label"][: vx - 4])
                    self.scr.addstr(2 + i, vx, shown[: max(1, w - vx - 2)],
                                    curses.A_REVERSE if focused else curses.A_UNDERLINE)
                by = 3 + nb
                for j, label in enumerate(("[ Aceptar ]", "[ Cancelar ]")):
                    self.scr.addstr(by, 2 + j * 14, label,
                                    curses.A_REVERSE if sel == nb + j else curses.A_BOLD)
                if sel < nb:
                    self.scr.addstr(by + 2, 2, fields[sel].get("hint", "")[: w - 4], curses.A_DIM)
                if err:
                    self.scr.addstr(by + 4, 2, ("✘ " + err)[: w - 4], curses.color_pair(2) | curses.A_BOLD)
                self.scr.addstr(h - 1, 0,
                                "Tab/↑↓ moverse · Espacio marca/desmarca · Ctrl+U borra campo · Esc cancela"[: w - 1],
                                curses.A_DIM)
                try:
                    k = self.scr.get_wch()
                except curses.error:
                    continue
                err = ""
                f = fields[sel] if sel < nb else None
                if k == "\x1b":
                    return None
                if k in (curses.KEY_DOWN, "\t") or (k in ("\n", "\r") and sel < nb):
                    sel = min(sel + 1, nb + 1)
                elif k in (curses.KEY_UP, curses.KEY_BTAB):
                    sel = max(sel - 1, 0)
                elif sel >= nb and k == curses.KEY_RIGHT:
                    sel = nb + 1
                elif sel >= nb and k == curses.KEY_LEFT:
                    sel = nb
                elif sel >= nb and k in ("\n", "\r", curses.KEY_ENTER, " "):
                    if sel == nb + 1:
                        return None
                    err = validator(vals) or ""
                    if not err:
                        return vals
                elif f and f["kind"] == "bool" and k in (" ", curses.KEY_LEFT, curses.KEY_RIGHT):
                    vals[f["key"]] = not vals[f["key"]]
                elif f and f["kind"] != "bool":
                    if k in (curses.KEY_BACKSPACE, "\x7f", "\b"):
                        vals[f["key"]] = vals[f["key"]][:-1]
                    elif k == "\x15":
                        vals[f["key"]] = ""
                    elif isinstance(k, str) and k.isprintable():
                        vals[f["key"]] += k
        finally:
            self.scr.timeout(1000)

    def act_add(self):
        with open(CADDYFILE, encoding="utf-8") as f:
            current = f.read()
        existing = [a.lower() for a in site_addresses(current)]
        fields = [
            dict(key="host", label="Dominio del servicio", kind="text", value="",
                 hint="Ej.: app.midominio.com (debe apuntar por DNS a este servidor)"),
            dict(key="upstream", label="Destino (host:puerto)", kind="text", value="",
                 hint="Ej.: 192.168.1.50:8080 · o nombre-contenedor:3000 si está en la red de Caddy"),
            dict(key="https_upstream", label="El destino usa HTTPS", kind="bool", value=False),
            dict(key="skip_verify", label="  …ignorar su certificado", kind="bool", value=False,
                 hint="Solo si el destino usa un certificado autofirmado (reduce la seguridad)"),
            dict(key="gzip", label="Compresión gzip", kind="bool", value=True),
            dict(key="headers", label="Cabeceras de seguridad", kind="bool", value=True),
            dict(key="log", label="Registrar accesos (monitor)", kind="bool", value=True,
                 hint="Necesario para ver este servicio en el monitor de tráfico"),
            dict(key="user", label="Usuario (autenticación básica)", kind="text", value="",
                 hint="Opcional: deja usuario y contraseña vacíos para no pedir login"),
            dict(key="password", label="Contraseña", kind="secret", value="",
                 hint="Se guarda cifrada (bcrypt) en el Caddyfile"),
        ]

        def check(v):
            host, up = v["host"].strip(), v["upstream"].strip()
            if not HOST_RE.match(host):
                return "Dominio no válido"
            if host.lower() in existing:
                return "Ya existe un bloque para ese dominio en el Caddyfile"
            if not up or any(c.isspace() for c in up):
                return "Indica el destino, p. ej. 192.168.1.50:8080"
            if bool(v["user"].strip()) != bool(v["password"]):
                return "Indica usuario y contraseña, o deja ambos vacíos"
            if any(c.isspace() for c in v["user"].strip()):
                return "El usuario no puede contener espacios"
            return None

        v = self.form("Añadir servicio a Caddy", fields, check)
        if v is None:
            self.show("Añadir servicio", "Cancelado. No se ha modificado nada.")
            return
        self.busy("Generando configuración...")
        pw = hash_password(v["password"]) if v["user"].strip() else None
        if v["user"].strip() and not pw:
            self.show("Añadir servicio: ERROR", "No se pudo cifrar la contraseña (¿Docker disponible?).")
            return
        block = build_site_block(v, pw)
        new = current.rstrip("\n") + "\n\n" + block
        ok, out = validate_text(new)
        if not ok:
            self.show("✘ La configuración generada NO es válida", out + "\n\n" + block)
            return
        self.show("Vista previa del bloque (se añadirá al final del Caddyfile)", block)
        self.draw()
        if not self.ask("¿Guardar en el Caddyfile?", True):
            self.show("Añadir servicio", "Cancelado. No se ha modificado nada.")
            return
        bk = backup_caddyfile()
        write_in_place(new)
        self.show("Añadir servicio",
                  f"✔ Servicio {v['host'].strip()} añadido (copia anterior: {os.path.relpath(bk, BASE)}).\n"
                  "Recuerda: el DNS del dominio debe apuntar a este servidor y, si el destino es otro\n"
                  "contenedor, debe estar en la misma red Docker que Caddy.")
        self.draw()
        state, _ = container_state()
        if state == "running" and self.ask("¿Recargar Caddy ahora?", True):
            self.act_reload()

    # -- monitor de tráfico
    def act_traffic(self):
        state, _ = container_state()
        if state != "running":
            self.show("Monitor de tráfico", "El contenedor de Caddy no está en marcha. Usa [s] para arrancarlo.")
            return
        windows = [(60, "1 min"), (300, "5 min"), (900, "15 min")]
        wi, paused_at = 1, None
        feed = TrafficFeed()
        self.scr.timeout(500)
        try:
            while True:
                if paused_at is None:
                    feed.drain()
                self.draw_traffic(feed, windows[wi], paused_at)
                k = self.scr.getch()
                if k in (ord("q"), ord("Q"), 27):
                    return
                if k == ord("p"):
                    paused_at = None if paused_at else time.time()
                elif k == ord("w"):
                    wi = (wi + 1) % len(windows)
                elif k == ord("c"):
                    feed.events.clear()
        finally:
            feed.close()
            self.scr.timeout(1000)
            self.show("Monitor de tráfico", "Monitor cerrado.")

    def draw_traffic(self, feed, window, paused_at):
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 14 or w < 60:
            scr.addstr(0, 0, "Terminal demasiado pequeña (mín. 60x14)")
            scr.refresh()
            return
        span, label = window
        now = paused_at or time.time()
        ev = [e for e in feed.events if now - span <= e[0] <= now]
        n = len(ev)
        title = f" Monitor de tráfico · {CONTAINER} · ventana {label}" + ("  [EN PAUSA]" if paused_at else "")
        scr.addstr(0, 0, title.ljust(w - 1), curses.A_REVERSE)
        codes = Counter(e[5] // 100 for e in ev)
        avg_ms = (sum(e[7] for e in ev) / n * 1000) if n else 0
        scr.addstr(2, 2, f"Peticiones: {n}  ({n / span:.2f}/s)    Tráfico enviado: {human_bytes(sum(e[6] for e in ev))}"
                         f"    Latencia media: {avg_ms:.0f} ms"[: w - 3])
        x = 2
        for cls, col in ((2, 1), (3, 4), (4, 3), (5, 2)):
            txt = f"{cls}xx {codes.get(cls, 0)}"
            scr.addstr(3, x, txt, curses.color_pair(col) | curses.A_BOLD)
            x += len(txt) + 4

        # sparkline: peticiones por tramo de la ventana
        width = w - 6
        buckets = [0] * width
        start = now - span
        for e in ev:
            buckets[min(width - 1, int((e[0] - start) / span * width))] += 1
        mx = max(buckets) or 1
        line = "".join(" " if c == 0 else SPARK[min(7, int((c - 1) / max(mx - 1, 1) * 7.99))] for c in buckets)
        scr.addstr(5, 2, line, curses.color_pair(1))
        scr.addstr(6, 2, f"-{label}".ljust(width - 6) + "ahora", curses.A_DIM)

        # rankings
        half = w // 2
        for col, (name, idx) in enumerate((("Top dominios", 1), ("Top IPs de cliente", 4))):
            scr.addstr(8, 2 + col * half, name, curses.A_BOLD | curses.A_UNDERLINE)
            for r, (val, cnt) in enumerate(Counter(e[idx] for e in ev).most_common(4)):
                scr.addstr(9 + r, 2 + col * half, f"{cnt:>6}  {val}"[: half - 4])

        # últimas peticiones
        ly = 14
        scr.addstr(ly - 1, 0, " Últimas peticiones ".ljust(w - 1), curses.A_UNDERLINE)
        avail = h - ly - 1
        if not n and not feed.events:
            msg = ["Sin peticiones registradas todavía.",
                   "Los accesos solo se registran si el sitio tiene la directiva `log` en el Caddyfile",
                   "(los servicios creados con el asistente [a] la incluyen por defecto)."]
            for i, m in enumerate(msg[:avail]):
                scr.addstr(ly + i, 2, m[: w - 3], curses.A_DIM)
        for i, e in enumerate(ev[-avail:] if avail > 0 else []):
            ts, host, meth, uri, ip, st, size, dur = e
            col = {2: 1, 3: 4, 4: 3, 5: 2}.get(st // 100, 0)
            scr.addstr(ly + i, 1, time.strftime("%H:%M:%S", time.localtime(ts)))
            scr.addstr(ly + i, 10, f"{st}", curses.color_pair(col) | curses.A_BOLD)
            scr.addstr(ly + i, 14, f"{meth:6} {host}{uri}  ← {ip}  {dur * 1000:.0f}ms {human_bytes(size)}"[: w - 15])
        foot = "[p] pausa · [w] ventana · [c] limpiar · [q] volver"
        if not feed.alive:
            foot = "⚠ Se cerró el flujo de logs (¿contenedor parado?) · " + foot
        scr.addstr(h - 1, 0, foot[: w - 1], curses.A_DIM)
        scr.refresh()

    def act_env(self):
        if not os.path.exists(ENVFILE):
            if not self.ask("No existe .env. ¿Crearlo desde .env.example?"):
                return
            shutil.copy(os.path.join(BASE, ".env.example"), ENVFILE)
        self.external_editor(ENVFILE)
        self.show(".env", "Si has cambiado DOMAIN u otras variables, usa [s] para recrear el contenedor con ellas.")

    # -- bucle
    def loop(self):
        actions = {
            "a": self.act_add, "t": self.act_traffic, "e": self.act_edit, "v": self.act_validate, "l": self.act_reload,
            "s": self.act_start, "g": self.act_logs, "f": self.act_format,
            "c": self.act_view, "b": self.act_restore, "k": self.act_backup, "n": self.act_env,
            "x": lambda: self.act_compose("Parar", "stop", SERVICE, confirm="¿Parar Caddy? El sitio dejará de servirse por HTTPS."),
            "r": lambda: self.act_compose("Reiniciar", "restart", SERVICE, confirm="¿Reiniciar Caddy? Habrá un corte breve."),
        }
        while True:
            self.refresh_state()
            self.draw()
            k = self.scr.getch()
            if k == -1:
                continue
            if k == curses.KEY_RESIZE:
                continue
            if k == curses.KEY_UP:
                self.scroll -= 1
            elif k == curses.KEY_DOWN:
                self.scroll += 1
            elif k == curses.KEY_PPAGE:
                self.scroll -= 10
            elif k == curses.KEY_NPAGE:
                self.scroll += 10
            elif k in (ord("q"), ord("Q")):
                return
            elif 0 <= k < 256 and chr(k).lower() in actions:
                try:
                    actions[chr(k).lower()]()
                except OSError as e:
                    self.show("Error", str(e))
                self.refresh_state(True)


def main():
    if not os.path.exists(CADDYFILE):
        sys.exit(f"No se encuentra {CADDYFILE}")
    if not shutil.which("docker"):
        sys.exit("Docker no está instalado o no está en el PATH.")
    if not sys.stdout.isatty():
        sys.exit("Este programa necesita un terminal interactivo.")
    curses.wrapper(lambda scr: App(scr).loop())


if __name__ == "__main__":
    main()
