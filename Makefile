.PHONY: help setup cedict dev dev-api dev-web test lint build

PYTHON ?= python3

help:
	@echo "Comandos disponibles en ClipSniper:"
	@echo "  make setup    - Instala dependencias de backend (.venv) y frontend (npm)"
	@echo "  make cedict   - Descarga e importa el diccionario offline CC-CEDICT en SQLite"
	@echo "  make dev      - Inicia backend (:8000) y frontend (:5173) juntos"
	@echo "  make test     - Ejecuta la suite de tests (pytest + vitest)"
	@echo "  make lint     - Ejecuta linters y verificación de tipos"
	@echo "  make build    - Compila el frontend para producción"

setup:
	cd apps/api && $(PYTHON) -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -e ".[dev]"
	cd apps/web && npm install

cedict:
	cd apps/api && .venv/bin/python -m app.services.dictionary --download --import-db

dev-api:
	cd apps/api && .venv/bin/uvicorn app.main:create_app --factory --reload --host 0.0.0.0 --port 8000

dev-web:
	cd apps/web && npm run dev -- --host 0.0.0.0

dev:
	@trap 'kill 0' INT TERM; \
	(cd apps/api && .venv/bin/uvicorn app.main:create_app --factory --reload --port 8000) & \
	(cd apps/web && npm run dev) & \
	wait

test:
	cd apps/api && .venv/bin/pytest -v
	cd apps/web && npm test

lint:
	cd apps/web && npm run lint && npm run format:check

build:
	cd apps/web && npm run build
