#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# MandarinReactor (ClipSniper) — Lanzador de 1 clic con pantalla de carga CLI
# - 100% basado en rutas relativas al directorio donde reside este script.
# - Repara automáticamente el .venv si la carpeta del proyecto fue renombrada o movida.
# - Usa `setsid` para que los servidores en segundo plano NO mueran al cerrarse
#   la ventana de terminal del acceso directo (.desktop).
# - Escucha en localhost (IPv4 + IPv6) para evitar "No se puede conectar" en Firefox.
#
# Uso:
#   ./start.sh          -> Inicia (o reutiliza) los servicios y abre el navegador
#   ./start.sh --stop   -> Detiene los servicios en segundo plano
#   ./start.sh --status -> Muestra el estado de los servicios
# ==============================================================================

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
cd "$ROOT_DIR"

API_DIR="./apps/api"
WEB_DIR="./apps/web"
RUN_DIR="./.run"
mkdir -p "$RUN_DIR"

API_PID_FILE="$RUN_DIR/api.pid"
WEB_PID_FILE="$RUN_DIR/web.pid"
API_LOG="$RUN_DIR/api.log"
WEB_LOG="$RUN_DIR/web.log"

API_URL="http://localhost:8000/api/videos"
WEB_URL="http://localhost:5173"

# Colores ANSI
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[2m"
C_ACCENT="\033[38;5;223m"
C_GREEN="\033[38;5;78m"
C_RED="\033[38;5;203m"
C_CYAN="\033[38;5;117m"

is_url_ready() {
  local url="$1"
  curl -s -o /dev/null --max-time 1 "$url"
}

stop_services() {
  echo -e "${C_ACCENT}Deteniendo servicios de MandarinReactor...${C_RESET}"
  for pid_file in "$API_PID_FILE" "$WEB_PID_FILE"; do
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        # Matar también al grupo de procesos si fue lanzado con setsid
        kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    fi
  done
  pkill -f "uvicorn app.main:create_app" 2>/dev/null || true
  pkill -f "vite --host" 2>/dev/null || true
  echo -e "${C_GREEN}✓ Servicios detenidos.${C_RESET}"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_services
  exit 0
fi

if [[ "${1:-}" == "--status" ]]; then
  if is_url_ready "$API_URL"; then
    echo -e "${C_GREEN}✓ Backend activo en :8000${C_RESET}"
  else
    echo -e "${C_RED}✗ Backend inactivo${C_RESET}"
  fi
  if is_url_ready "$WEB_URL"; then
    echo -e "${C_GREEN}✓ Frontend activo en :5173${C_RESET}"
  else
    echo -e "${C_RED}✗ Frontend inactivo${C_RESET}"
  fi
  exit 0
fi

clear
echo -e "${C_ACCENT}${C_BOLD}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║              MandarinReactor · ClipSniper                ║"
echo "  ║            Iniciando entorno de estudio local            ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${C_RESET}"

spin_wait() {
  local label="$1"
  local url="$2"
  local timeout_sec="${3:-60}"
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local start_ts
  start_ts="$(date +%s)"
  local i=0

  while ! is_url_ready "$url"; do
    local now_ts
    now_ts="$(date +%s)"
    local elapsed=$((now_ts - start_ts))
    if (( elapsed >= timeout_sec )); then
      printf "\r  ${C_RED}✗${C_RESET} %-46s ${C_RED}[Tiempo agotado]${C_RESET}\n" "$label"
      return 1
    fi
    local frame="${frames[$((i % ${#frames[@]}))]}"
    printf "\r  ${C_CYAN}%s${C_RESET} %-46s ${C_DIM}(%ds)${C_RESET}" "$frame" "$label" "$elapsed"
    sleep 0.15
    i=$((i + 1))
  done

  printf "\r  ${C_GREEN}✓${C_RESET} %-46s ${C_GREEN}[Listo]${C_RESET}     \n" "$label"
  return 0
}

# 1. Asegurar que todos los scripts en .venv/bin usen shebang relativo (#!/usr/bin/env python3)
if [[ ! -x "$API_DIR/.venv/bin/python" ]]; then
  echo -e "  ${C_CYAN}→${C_RESET} Configurando entorno Python por primera vez..."
  (cd "$API_DIR" && python3 -m venv .venv && ./.venv/bin/python -m pip install --upgrade pip -q && ./.venv/bin/python -m pip install -e . -q)
else
  for f in "$API_DIR"/.venv/bin/*; do
    if [[ -f "$f" && ! -L "$f" ]]; then
      sed -i '1s|^#!/.*/bin/python.*|#!/usr/bin/env python3|' "$f" 2>/dev/null || true
    fi
  done
  shopt -s nullglob
  for pth in "$API_DIR"/.venv/lib/python*/site-packages/*mandarin_reactor_api*; do
    if [[ -f "$pth" ]] && grep -q "ClipSniper" "$pth" 2>/dev/null; then
      sed -i "s|/home/[^/\"']*/Proyectos/ClipSniper|$ROOT_DIR|g" "$pth" 2>/dev/null || true
    fi
  done
  shopt -u nullglob
fi

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  echo -e "  ${C_CYAN}→${C_RESET} Instalando paquetes del frontend por primera vez..."
  (cd "$WEB_DIR" && npm install --silent)
fi

# 2. Iniciar Backend desacoplado de la terminal (setsid) si no está vivo el PID actual
api_pid="$(cat "$API_PID_FILE" 2>/dev/null || true)"
if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null && is_url_ready "$API_URL"; then
  printf "  ${C_GREEN}✓${C_RESET} %-46s ${C_GREEN}[Activo]${C_RESET}\n" "Backend FastAPI (http://localhost:8000)"
else
  pkill -f "uvicorn app.main:create_app" 2>/dev/null || true
  sleep 0.3
  (
    cd "$API_DIR"
    export PATH="$PWD/.venv/bin:$PATH"
    export PYTHONPATH="$PWD"
    setsid ./.venv/bin/python -m uvicorn app.main:create_app --factory --reload --host 0.0.0.0 --port 8000 </dev/null >"$ROOT_DIR/$API_LOG" 2>&1 &
    echo $! >"$ROOT_DIR/$API_PID_FILE"
  )
  if ! spin_wait "Iniciando Backend FastAPI + SQLite + Jieba..." "$API_URL" 45; then
    echo -e "\n${C_RED}Error al iniciar el backend. Últimas líneas de $API_LOG:${C_RESET}"
    tail -n 20 "$API_LOG" || true
    read -r -p "Presioná Enter para salir..."
    exit 1
  fi
fi

# 3. Iniciar Frontend desacoplado de la terminal (setsid) si no está vivo el PID actual
web_pid="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null && is_url_ready "$WEB_URL"; then
  printf "  ${C_GREEN}✓${C_RESET} %-46s ${C_GREEN}[Activo]${C_RESET}\n" "Frontend Vite (http://localhost:5173)"
else
  pkill -f "vite" 2>/dev/null || true
  sleep 0.3
  (
    cd "$WEB_DIR"
    setsid ./node_modules/.bin/vite --host --port 5173 </dev/null >"$ROOT_DIR/$WEB_LOG" 2>&1 &
    echo $! >"$ROOT_DIR/$WEB_PID_FILE"
  )
  if ! spin_wait "Iniciando servidor web Vite (:5173)..." "$WEB_URL" 30; then
    echo -e "\n${C_RED}Error al iniciar el frontend. Últimas líneas de $WEB_LOG:${C_RESET}"
    tail -n 20 "$WEB_LOG" || true
    read -r -p "Presioná Enter para salir..."
    exit 1
  fi
fi

# 4. Abrir navegador desacoplado y cerrar pantalla de carga
echo ""
echo -e "  ${C_GREEN}${C_BOLD}✓ MandarinReactor está listo.${C_RESET} Abriendo navegador en ${C_ACCENT}${WEB_URL}${C_RESET}..."
echo -e "  ${C_DIM}(Para detener los servicios más tarde: ./start.sh --stop)${C_RESET}"

if command -v xdg-open >/dev/null 2>&1; then
  setsid xdg-open "$WEB_URL" </dev/null >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$WEB_URL" >/dev/null 2>&1 &
fi

sleep 1.5
exit 0
