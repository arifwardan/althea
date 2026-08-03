# Local Development Guide

## Prerequisites

- Python 3.12 (installing via [uv](https://docs.astral.sh/uv/) is recommended)
- Node.js 20+
- Docker + Docker Compose
- Rust toolchain (only for the desktop app)

## 1. Infrastructure

```bash
docker compose up -d postgres redis
```

PostgreSQL is exposed on `localhost:5432` (user/password/db: `althea`), Redis on `localhost:6379`.

## 2. Backend API

```bash
cd services/api
uv venv --python 3.12 .venv
uv pip install -p .venv/bin/python -e ".[dev]"
cp .env.example .env
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Verify:

```bash
curl http://localhost:8000/api/v1/health   # {"status":"ok",...}
curl http://localhost:8000/api/v1/ready    # {"status":"ready","database":true,"redis":true}
```

Interactive API docs: http://localhost:8000/docs

### Migrations

```bash
cd services/api
.venv/bin/alembic revision --autogenerate -m "describe change"
.venv/bin/alembic upgrade head
```

### Tests, lint, types

```bash
cd services/api
.venv/bin/pytest
.venv/bin/ruff check .
.venv/bin/mypy app
```

## 3. Frontend

From the repo root:

```bash
npm install
npm run dev:web      # http://localhost:3000
```

Set `NEXT_PUBLIC_API_URL` (see `.env.example`) if the API is not on `localhost:8000`.

Lint / typecheck / build:

```bash
npm run lint:web
npm run typecheck
npm run build:web
```

## 4. Desktop App (optional)

Requires the Rust toolchain and Tauri Linux system dependencies
(`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` on Ubuntu; see the
[Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```bash
cd apps/desktop
npm install
npm run dev      # starts the web dev server and opens the desktop window
npm run build    # bundles the static web export into a desktop binary
```

## 5. Other Services

```bash
# AI engine (health endpoint only in v0.1)
cd services/ai-engine
uv venv --python 3.12 .venv && uv pip install -p .venv/bin/python -e ".[dev]"
.venv/bin/uvicorn app.main:app --reload --port 8001

# Scheduler
cd services/scheduler
uv venv --python 3.12 .venv && uv pip install -p .venv/bin/python -e ".[dev]"
.venv/bin/python -m app.main
```

## Everything in Docker

```bash
docker compose up --build                 # api, ai-engine, scheduler, postgres, redis
docker compose run --rm migrations        # run alembic upgrade head
docker compose --profile ai up -d ollama  # optional local LLM runtime
```

## Makefile Shortcuts

```bash
make up        # start postgres + redis
make api       # run the API with reload
make web       # run the frontend dev server
make migrate   # apply migrations
make test      # backend tests
make lint      # ruff + eslint
make typecheck # mypy + tsc
```
