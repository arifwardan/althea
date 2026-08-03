---
name: testing-althea
description: How to run and test the Althea monorepo locally (API, web, docker compose)
---

# Testing Althea locally

## Services
- Infra: `docker compose up -d postgres redis` from repo root (postgres althea/althea/althea on 5432, redis 6379).
- Migrations: `cd services/api && .venv/bin/alembic upgrade head` (venv pre-exists at services/api/.venv; default env vars work against compose postgres).
- API: `cd services/api && .venv/bin/uvicorn app.main:app --port 8000`. Endpoints: `/api/v1/health`, `/api/v1/ready` (checks Postgres+Redis; returns `status:"degraded"` with `redis:false` if redis is down — useful adversarial check via `docker compose stop redis`).
- Web: `npm run dev:web` from repo root (port 3000; npm workspaces, `npm install` at root). `/` client-redirects to `/dashboard`.
- Docker api: `docker compose up --build -d api migrations` — note it binds host :8000, so stop any local uvicorn first or the container fails with "address already in use".
- Skip ollama (`ai` profile) and the Tauri desktop build (slow, not required).

## Web UI structure
- Sidebar nav (src/components/layout/sidebar.tsx): Dashboard, Projects, Agents, Workflows, Knowledge, Settings under /dashboard/*; active item styled with `bg-accent`.
- Topbar (topbar.tsx): hamburger Sheet (md:hidden — resize window <768px to show), avatar "AL" dropdown → Founder / Settings / Sign out(→/login). /login "Sign in" links to /dashboard (no real auth).

## ai-engine agent runtime (services/ai-engine)
- Own venv at `services/ai-engine/.venv`: `.venv/bin/pytest -q`, `.venv/bin/ruff check .`, `.venv/bin/mypy app tests`. Root `make lint test typecheck` covers api + ai-engine + web.
- Runtime library lives in `app/runtime/`; exercise it with a script run via the venv with cwd=services/ai-engine (imports are `app.runtime.*`). Inject a fake `ModelProvider` (class with `name` attr and `async generate(request) -> ModelResponse`) into `ProviderRegistry({"fake": ...})`; scripted `ModelResponse(tool_calls=[ToolCall(...)])` drives the tool loop.
- `DefaultContextBuilder` requires a Memory arg: `DefaultContextBuilder(NullMemory())`.
- Filesystem tools take `workspace_root` in constructor; path escape raises "path escapes workspace". PermissionDeniedError message is "agent <id> lacks permission: <perm>" (no word "denied").
- Agent JSON configs in `services/ai-engine/agents/`; load with `AgentRegistry.from_directory("agents")`.
- Live LLM: `docker compose --profile ai up -d ollama`, then `docker exec althea-ollama-1 ollama pull qwen2.5:0.5b` (small/fast) and point `OllamaProvider(base_url="http://localhost:11434")` with agent model `qwen2.5:0.5b`.

## Gotchas
- Semantic Tailwind colors may be broken if tailwind.config.ts wraps CSS vars in `hsl()` while globals.css defines them as `oklch(...)` — check computed styles (`getComputedStyle(el).backgroundColor`) when highlights/backgrounds look missing; screenshots alone can be ambiguous since accent is very light.
- Module pages are placeholders ("Not implemented in v0.1"); auth backend not wired — not bugs.
