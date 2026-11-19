.PHONY: help start stop desktop setup cedict dev dev-api dev-web test lint build

PYTHON ?= python3

help:
	@echo "Comandos disponibles en MandarinReactor:"
	@echo "  make start    - Lanzador de 1 clic: inicia servicios en segundo plano y abre el navegador"
	@echo "  make stop     - Detiene los servicios en segundo plano"
	@echo "  make desktop  - Crea el acceso directo de 1 clic en tu Escritorio y menú de aplicaciones (Linux)"
	@echo "  make setup    - Instala dependencias de backend (.venv) y frontend (npm)"
	@echo "  make cedict   - Descarga e importa el diccionario offline CC-CEDICT en SQLite"
	@echo "  make dev      - Inicia backend (:8000) y frontend (:5173) juntos"
	@echo "  make test     - Ejecuta la suite de tests (pytest + vitest)"
	@echo "  make lint     - Ejecuta linters y verificación de tipos"
	@echo "  make build    - Compila el frontend para producción"

start:
	./start.sh

stop:
	./start.sh --stop

desktop:
	@chmod +x "$(CURDIR)/start.sh"
	@mkdir -p "$(HOME)/.local/share/applications"
	@printf "[Desktop Entry]\nVersion=1.0\nType=Application\nName=ClipSniper (Mandarin Reactor)\nComment=Reproductor de estudio de mandarín\nExec=$(CURDIR)/start.sh\nPath=$(CURDIR)\nIcon=multimedia-video-player\nTerminal=true\nCategories=Education;AudioVideo;Player;\nStartupNotify=true\nActions=Stop;\n\n[Desktop Action Stop]\nName=Detener servicios en segundo plano\nExec=$(CURDIR)/start.sh --stop\nTerminal=true\n" > "$(HOME)/.local/share/applications/clipsniper.desktop"
	@chmod +x "$(HOME)/.local/share/applications/clipsniper.desktop"
	@if [ -d "$(HOME)/Escritorio" ]; then cp "$(HOME)/.local/share/applications/clipsniper.desktop" "$(HOME)/Escritorio/ClipSniper.desktop" && chmod +x "$(HOME)/Escritorio/ClipSniper.desktop"; fi
	@if [ -d "$(HOME)/Desktop" ]; then cp "$(HOME)/.local/share/applications/clipsniper.desktop" "$(HOME)/Desktop/ClipSniper.desktop" && chmod +x "$(HOME)/Desktop/ClipSniper.desktop"; fi
	@echo "✓ Acceso directo 'ClipSniper' creado en tu Escritorio y menú de aplicaciones."

setup:
	cd apps/api && $(PYTHON) -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -e ".[dev]"
	cd apps/web && npm install

cedict:
	cd apps/api && .venv/bin/python -m app.services.dictionary --download --import-db

dev-api:
	cd apps/api && .venv/bin/python -m uvicorn app.main:create_app --factory --reload --host 0.0.0.0 --port 8000

dev-web:
	cd apps/web && npm run dev -- --host 0.0.0.0

dev:
	@trap 'kill 0' INT TERM; \
	(cd apps/api && .venv/bin/python -m uvicorn app.main:create_app --factory --reload --port 8000) & \
	(cd apps/web && npm run dev) & \
	wait

test:
	cd apps/api && .venv/bin/python -m pytest -v
	cd apps/web && npm test

lint:
	cd apps/web && npm run lint && npm run format:check

build:
	cd apps/web && npm run build
