# ClipSniper (Mandarin Reactor)

Reproductor de video local para estudiar **chino mandarín** mediante inmersión, subtítulos interactivos con `<ruby>` (pinyin + color por tono), diccionario offline **CC-CEDICT**, minado de oraciones con corte automático de clips de video/audio (`ffmpeg`) y generación de mazos para **Anki** (`.apkg` y **AnkiConnect**).

> Funciona 100% en tu máquina, sin cuentas ni suscripciones, tanto con archivos de video locales como importando directamente desde **YouTube** o **Bilibili** (`yt-dlp`).

---

## Características principales

- **Videos locales o desde URL:** Subí tus propios archivos (`.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`) o pegá un enlace de YouTube/Bilibili para descargar el video junto con sus subtítulos automáticamente mediante `yt-dlp`.
- **Subtítulos sincronizados de doble pista:** Soporte para `.srt`, `.ass`, `.ssa` y `.vtt` con detección automática de codificación (`UTF-8`, `GB18030`, `Big5`, `UTF-16`) y emparejado automático entre la pista en chino y la pista de traducción (español/inglés).
- **Procesamiento del chino y Pinyin `<ruby>`:** Segmentación de palabras con `jieba`, pinyin contextual con `pypinyin`, soporte para caracteres simplificados y tradicionales (`OpenCC`) y coloreado opcional por tono (1.º a 5.º) en el reproductor y en el panel lateral.
- **Diccionario offline CC-CEDICT:** Consultá cualquier palabra haciendo clic o pasando el mouse por encima (con pausa automática opcional y desglose carácter por carácter).
- **Controles de estudio:** Salto línea por línea (`A` / `D`), repetir línea (`R`), bucle infinito de la frase actual (`L`), pausa automática al terminar cada subtítulo (`P`), ajuste de sincronía (`±100 ms`) y velocidad con preservación de tono (`0.5×` a `1.5×`).
- **Minado de oraciones con clips reales (`ffmpeg`):** Con una tecla (`S`) guardás la oración actual y el backend recorta en segundo plano el fragmento exacto de **video (`.mp4`)**, **audio (`.mp3`)** y **captura (`.jpg`)** con margen configurable (`±300 ms`).
- **Exportación a Anki (`.apkg` y AnkiConnect):** Generá mazos `.apkg` listos para importar en Anki Desktop, AnkiDroid o AnkiMobile con hasta 3 tipos de tarjeta (*Escucha*, *Lectura* y *Producción*), o envialos en un clic a Anki Desktop mediante **AnkiConnect**.

---

## Descarga del proyecto

Elegí cualquiera de las opciones según prefieras usar `git` o descargar un archivo comprimido directamente:

### Opción A — Clonar con Git (recomendado)

```bash
git clone https://github.com/TU_USUARIO/ClipSniper.git
cd ClipSniper
```

### Opción B — Descarga directa (sin Git)

- **Descargar ZIP:** [`Descargar ClipSniper (main.zip)`](https://github.com/TU_USUARIO/ClipSniper/archive/refs/heads/main.zip)
- **Última versión estable:** [`Ver Releases en GitHub`](https://github.com/TU_USUARIO/ClipSniper/releases)

*(Si descargás el `.zip`, descomprimilo y abrí una terminal dentro de la carpeta resultante).*

---

## Instalación y puesta en marcha

Podés correr **ClipSniper** de dos maneras:
1. **Con Docker Compose** (sin instalar Python, Node ni `ffmpeg` en tu sistema).
2. **Instalación nativa** en **Linux**, **macOS** o **Windows**.

---

### Método 1: Con Docker (Linux / macOS / Windows)

Solo necesitás tener [Docker Desktop](https://www.docker.com/products/docker-desktop/) (o Docker Engine + Compose en Linux) instalado:

```bash
docker compose up --build
```

- Abrí **`http://localhost:5173`** en tu navegador.
- Los videos, clips, diccionario y base de datos SQLite quedan guardados de forma persistente en `./apps/api/data/`.

---

### Método 2: Instalación nativa por sistema operativo

#### Paso 1 — Instalar los requisitos del sistema (`Python 3.11+`, `Node.js 20+` y `ffmpeg`)

<details open>
<summary><b>🐧 Linux (Ubuntu / Debian / Mint / Fedora / Arch)</b></summary>

**Ubuntu / Debian / Linux Mint:**
```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm ffmpeg git
```

**Fedora:**
```bash
sudo dnf install -y python3 python3-pip nodejs npm ffmpeg git
```

**Arch Linux / Manjaro:**
```bash
sudo pacman -S --needed python nodejs npm ffmpeg git
```

</details>

<details>
<summary><b>🍎 macOS (con Homebrew)</b></summary>

Si no tenés Homebrew, instalalo desde [brew.sh](https://brew.sh/) y luego ejecutá:

```bash
brew install python@3.12 node ffmpeg git
```

</details>

<details>
<summary><b>🪟 Windows 10 / 11 (PowerShell con Winget o Chocolatey)</b></summary>

Abrí **PowerShell** y ejecutá con `winget` (incluido en Windows 10/11):

```powershell
winget install -e --id Python.Python.3.12
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Gyan.FFmpeg
winget install -e --id Git.Git
```

*(Alternativa con Chocolatey: `choco install python nodejs-lts ffmpeg git -y`).*
> **Importante en Windows:** Después de instalar `ffmpeg` y `python`, cerrá y volvé a abrir la ventana de PowerShell para que se actualice la variable `PATH`. Verificá que responda ejecutando `ffmpeg -version`.

</details>

---

#### Paso 2 — Instalar dependencias del proyecto y diccionario CC-CEDICT

<details open>
<summary><b>🐧 Linux y 🍎 macOS</b></summary>

Si tenés `make` instalado, podés hacerlo en dos comandos desde la raíz del proyecto:

```bash
# 1. Crear entorno virtual de Python, instalar paquetes de backend/frontend
make setup

# 2. (Opcional pero recomendado) Descargar e importar el diccionario offline CC-CEDICT
make cedict

# 3. Iniciar backend (:8000) y frontend (:5173) juntos
make dev
```

**O paso a paso sin `make`:**

```bash
# Backend
cd apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"

# (Opcional) Descargar diccionario CC-CEDICT por consola (también podés hacerlo desde la UI)
python -m app.services.dictionary --download --import-db
cd ../..

# Frontend
cd apps/web
npm install
```

Para levantarlo manualmente en dos terminales:
- **Terminal 1 (Backend):**
  ```bash
  cd apps/api
  .venv/bin/uvicorn app.main:create_app --factory --reload --port 8000
  ```
- **Terminal 2 (Frontend):**
  ```bash
  cd apps/web
  npm run dev
  ```

</details>

<details>
<summary><b>🪟 Windows (PowerShell)</b></summary>

Ejecutá desde la carpeta raíz del proyecto:

```powershell
# 1. Configurar Backend
cd apps\api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -e ".[dev]"

# (Opcional) Descargar e importar el diccionario offline CC-CEDICT
python -m app.services.dictionary --download --import-db
cd ..\..

# 2. Configurar Frontend
cd apps\web
npm install
cd ..\..
```

Para iniciar la aplicación en Windows, abrí **dos terminales PowerShell**:

- **Terminal 1 (Backend en `http://localhost:8000`):**
  ```powershell
  cd apps\api
  .\.venv\Scripts\uvicorn app.main:create_app --factory --reload --port 8000
  ```
- **Terminal 2 (Frontend en `http://localhost:5173`):**
  ```powershell
  cd apps\web
  npm run dev
  ```

</details>

Una vez iniciado, abrí **`http://localhost:5173`** en tu navegador.

---

## Atajos de teclado en el reproductor

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir / Pausar |
| `←` / `→` | Retroceder / Avanzar 5 segundos |
| `[` / `]` | Reducir / Aumentar velocidad de reproducción (`0.5×` – `1.5×`) |
| `M` | Silenciar / Activar sonido |
| `F` | Pantalla completa (mantiene subtítulos interactivos y diccionario) |
| `A` / `D` | Ir al subtítulo anterior / siguiente |
| `R` | Repetir la línea de subtítulo actual |
| `L` | Activar / Desactivar bucle (`loop`) en la línea actual |
| `P` | Pausar automáticamente al finalizar cada línea |
| `S` | **Guardar frase actual y cortar clip** para Anki |
| `C` | Mostrar / Ocultar subtítulos sobre el video |
| `T` | Mostrar / Ocultar segunda pista (traducción) |
| `Y` | Mostrar / Ocultar pinyin sobre los caracteres |
| `K` | Activar / Desactivar colores por tono |
| `G` / `H` | Ajustar sincronía del subtítulo (`−100 ms` / `+100 ms`) |
| `?` | Abrir guía de atajos de teclado |

---

## Configuración avanzada (`.env` opcional)

El proyecto funciona sin configurar variables de entorno. Si querés personalizar rutas, márgenes de corte de clips o conectar una API externa de traducción (como LibreTranslate), copiá el archivo de ejemplo:

```bash
cp apps/api/.env.example apps/api/.env
```

---

## Estructura del repositorio

```text
ClipSniper/
├── apps/
│   ├── api/                      # Backend en Python (FastAPI + SQLModel + Alembic)
│   │   ├── app/
│   │   │   ├── routers/          # Endpoints REST (videos, subtitles, dictionary, phrases, export)
│   │   │   └── services/         # FFmpeg clipper, yt-dlp, jieba/pypinyin, CC-CEDICT, genanki
│   │   └── tests/                # Suite de pruebas con pytest
│   └── web/                      # Frontend en React + TypeScript + Vite + Tailwind CSS
│       └── src/
│           ├── components/       # Reproductor, overlay arrastrable, panel virtualizado, modales
│           ├── pages/            # Biblioteca, Reproductor (Watch) y Exportación Anki (Phrases)
│           └── store/            # Estado persistido de estudio (Zustand)
├── docker-compose.yml            # Orquestación lista para correr con Docker
├── Makefile                      # Atajos para setup, desarrollo y tests
└── LICENSE                       # Licencia MIT
```

---

## Tests y calidad de código

```bash
# Ejecutar toda la suite (Backend pytest + Frontend vitest)
make test

# Compilar bundle de producción del frontend y verificar tipos TypeScript
make build
```

---

## Licencia

Distribuido bajo la licencia **MIT** (ver [`LICENSE`](./LICENSE)).
Los datos del diccionario **CC-CEDICT** descargados por la aplicación se distribuyen bajo la licencia [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
