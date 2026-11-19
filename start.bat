@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: =============================================================================
:: ClipSniper — Lanzador de 1 clic para Windows (con pantalla de carga CLI)
:: =============================================================================

set "ROOT_DIR=%~dp0"
set "API_DIR=%ROOT_DIR%apps\api"
set "WEB_DIR=%ROOT_DIR%apps\web"
set "RUN_DIR=%ROOT_DIR%.run"
if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"

cls
echo.
echo   ╔══════════════════════════════════════════════════════════╗
echo   ║              ClipSniper · Mandarin Reactor               ║
echo   ║            Iniciando entorno de estudio local            ║
echo   ╚══════════════════════════════════════════════════════════╝
echo.

:: 1. Verificar dependencias en primera ejecución
if not exist "%API_DIR%\.venv\Scripts\uvicorn.exe" (
    echo   [...] Configurando entorno Python por primera vez...
    pushd "%API_DIR%"
    python -m venv .venv
    call .\.venv\Scripts\pip.exe install --upgrade pip -q
    call .\.venv\Scripts\pip.exe install -e . -q
    popd
)

if not exist "%WEB_DIR%\node_modules" (
    echo   [...] Instalando paquetes del frontend por primera vez...
    pushd "%WEB_DIR%"
    call npm install --silent
    popd
)

:: 2. Iniciar Backend en segundo plano si no responde en :8000
curl -s -o nul --max-time 1 http://localhost:8000/api/videos
if !errorlevel! neq 0 (
    echo   [...] Iniciando Backend FastAPI + SQLite + Jieba...
    powershell -NoProfile -Command "Start-Process -FilePath '%API_DIR%\.venv\Scripts\uvicorn.exe' -ArgumentList 'app.main:create_app','--factory','--host','127.0.0.1','--port','8000' -WorkingDirectory '%API_DIR%' -WindowStyle Hidden"
) else (
    echo   [OK]  Backend FastAPI activo en http://localhost:8000
)

:: 3. Iniciar Frontend en segundo plano si no responde en :5173
curl -s -o nul --max-time 1 http://localhost:5173
if !errorlevel! neq 0 (
    echo   [...] Iniciando servidor web Vite ^(:5173^)...
    powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev -- --host 127.0.0.1 --port 5173' -WorkingDirectory '%WEB_DIR%' -WindowStyle Hidden"
) else (
    echo   [OK]  Frontend Vite activo en http://localhost:5173
)

:: 4. Esperar a que ambos respondan
set /a tries=0
:wait_loop
set /a tries+=1
if !tries! gtr 45 (
    echo.
    echo   [ERROR] Tiempo de espera agotado al iniciar los servicios.
    pause
    exit /b 1
)
curl -s -o nul --max-time 1 http://localhost:8000/api/videos
if !errorlevel! neq 0 (
    <nul set /p "=."
    timeout /t 1 /nobreak >nul
    goto wait_loop
)
curl -s -o nul --max-time 1 http://localhost:5173
if !errorlevel! neq 0 (
    <nul set /p "=."
    timeout /t 1 /nobreak >nul
    goto wait_loop
)

echo.
echo   [OK]  ClipSniper esta listo. Abriendo navegador...
start "" "http://localhost:5173"
timeout /t 1 /nobreak >nul
exit /b 0
