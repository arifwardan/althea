.PHONY: help up down api web test lint typecheck migrate

help:
	@grep -E '^[a-zA-Z_-]+:' Makefile | cut -d: -f1

up:
	docker compose up -d postgres redis

down:
	docker compose down

api:
	cd services/api && .venv/bin/uvicorn app.main:app --reload --port 8000

web:
	npm run dev:web

migrate:
	cd services/api && .venv/bin/alembic upgrade head

test:
	cd services/api && .venv/bin/pytest
	cd services/ai-engine && .venv/bin/pytest

lint:
	cd services/api && .venv/bin/ruff check .
	cd services/ai-engine && .venv/bin/ruff check .
	npm run lint:web

typecheck:
	cd services/api && .venv/bin/mypy app
	cd services/ai-engine && .venv/bin/mypy app tests
	npm run typecheck
