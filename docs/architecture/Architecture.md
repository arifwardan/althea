# ALTHEA Architecture

## Overview

ALTHEA is structured as a monorepo containing a desktop application, a web frontend, and a set of backend services. The desktop app is a thin Tauri shell around the Next.js frontend; all business logic lives in backend services.

```
┌────────────────────────────┐
│  apps/desktop (Tauri)      │
│  ┌──────────────────────┐  │
│  │  apps/web (Next.js)  │  │
│  └──────────┬───────────┘  │
└─────────────┼──────────────┘
              │ HTTP (JSON)
   ┌──────────┴──────────────────────────┐
   │                                     │
┌──▼──────────────┐   ┌──────────────┐  ┌▼─────────────┐
│ services/api    │   │ services/    │  │ services/    │
│ (FastAPI)       │   │ scheduler    │  │ ai-engine    │
└──┬─────────┬────┘   └──────┬───────┘  └──────┬───────┘
   │         │               │                 │
┌──▼─────┐ ┌─▼─────┐   ┌─────▼──┐        ┌─────▼──────┐
│Postgres│ │ Redis │   │ Redis  │        │  Ollama    │
└────────┘ └───────┘   └────────┘        └────────────┘
```

## Components

### services/api — Core API

The system of record. Responsibilities:

- HTTP API for the frontend (versioned under `/api/v1`)
- Persistence via SQLAlchemy 2 (async) + PostgreSQL
- Schema migrations via Alembic
- Caching / ephemeral state via Redis
- Health (`/api/v1/health`) and readiness (`/api/v1/ready`) endpoints

Internal structure follows a layered (clean) architecture:

```
app/
  core/    configuration, logging — no framework or I/O coupling
  db/      SQLAlchemy base, engine and session management
  infra/   external infrastructure clients (Redis)
  api/     FastAPI routers and dependency wiring (deps.py)
  main.py  application factory (create_app)
```

Dependency direction: `api → (core, db, infra)`. Domain and service layers will be added between `api` and `db` as features arrive; they are intentionally absent while there is no domain logic (no unnecessary abstractions).

Dependency injection uses FastAPI's `Depends` with typed aliases (`SettingsDep`, `DbSessionDep`, `RedisDep`) defined in `app/api/deps.py`. Long-lived resources (engine, Redis client) are created in the application lifespan and stored on `app.state`, so tests can substitute them without patching globals.

### services/ai-engine — AI Engine

Hosts the LangGraph + Ollama runtime. In v0.1 it exposes only a health endpoint; agent graphs are explicitly out of scope for the foundation.

### services/scheduler — Scheduler

Long-running worker for scheduled and background work. In v0.1 it maintains a Redis heartbeat, establishing the process model (async loop, graceful shutdown on SIGINT/SIGTERM) that future jobs will use.

### apps/web — Frontend

Next.js App Router application, statically exported (`output: "export"`) so the same build is served by the Tauri shell. Route groups:

- `(auth)` — authentication layout (login page; backend wiring pending)
- `(dashboard)` — application shell with sidebar + topbar, desktop-first responsive layout

UI primitives come from shadcn/ui; shared API contracts and the API client come from `packages/types` and `packages/shared`.

### apps/desktop — Desktop Shell

Tauri 2 application. In development it points at the Next.js dev server; in production it bundles the static export from `apps/web/out`.

## Cross-Cutting Concerns

- **Configuration**: pydantic-settings with per-service env prefixes (`ALTHEA_`, `ALTHEA_AI_`, `ALTHEA_SCHEDULER_`); `.env.example` files document every variable.
- **Logging**: structlog with JSON output in production and console output for development, configured per service.
- **Typing**: strict mypy on Python services, strict TypeScript across the frontend workspace.
- **Docker**: each service ships its own Dockerfile; `docker-compose.yml` wires the full stack, with Ollama behind an optional `ai` profile.

## Design Principles

1. **Clean architecture** — framework-independent core, dependencies point inward.
2. **SOLID** — small modules with single responsibilities; injection over globals.
3. **No unnecessary abstractions** — layers are added when features need them, not before.
4. **Production-ready defaults** — health/readiness endpoints, structured logs, migrations, containerization from day one.
