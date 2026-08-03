# Folder Structure

```
althea/
├── apps/
│   ├── desktop/                 # Tauri 2 desktop shell
│   │   ├── package.json         # @tauri-apps/cli scripts (dev/build)
│   │   └── src-tauri/
│   │       ├── Cargo.toml
│   │       ├── tauri.conf.json  # devUrl → :3000, frontendDist → ../../web/out
│   │       ├── capabilities/    # Tauri permission capabilities
│   │       ├── icons/
│   │       └── src/             # Rust entrypoint
│   └── web/                     # Next.js frontend
│       ├── src/
│       │   ├── app/
│       │   │   ├── (auth)/      # auth layout + /login
│       │   │   └── (dashboard)/ # app shell + /dashboard/*
│       │   ├── components/
│       │   │   ├── layout/      # Sidebar, Topbar
│       │   │   └── ui/          # shadcn/ui primitives
│       │   └── lib/             # utils, API client instance
│       ├── next.config.mjs      # static export + workspace transpilation
│       └── tailwind.config.ts
├── services/
│   ├── api/                     # Core FastAPI service
│   │   ├── app/
│   │   │   ├── core/            # config (pydantic-settings), logging (structlog)
│   │   │   ├── db/              # SQLAlchemy base + async engine/session
│   │   │   ├── infra/           # Redis client factory
│   │   │   ├── api/             # deps.py (DI) + routes/
│   │   │   └── main.py          # create_app() factory
│   │   ├── alembic/             # migration environment + versions/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── pyproject.toml
│   ├── ai-engine/               # LangGraph + Ollama runtime (health only in v0.1)
│   └── scheduler/               # Redis-heartbeat background worker
├── packages/
│   ├── types/                   # @althea/types — shared API contracts
│   ├── shared/                  # @althea/shared — typed API client
│   └── ui/                      # @althea/ui — shared UI utilities
├── docs/
│   ├── adr/                     # Architecture Decision Records
│   ├── architecture/            # Architecture.md, this file
│   ├── api/                     # API documentation
│   └── workflows/               # Local development guide
├── scripts/                     # Development scripts
├── tests/                       # Cross-service integration tests (none yet)
├── docker-compose.yml
├── Makefile
├── package.json                 # npm workspaces root
└── tsconfig.base.json
```

## Conventions

- **Python services** are independent projects under `services/`, each with its own `pyproject.toml`, virtualenv, and Dockerfile. They share conventions (env prefixes, structlog, ruff/mypy config) but no code — cross-service contracts go over HTTP.
- **TypeScript packages** are npm workspaces. Apps depend on packages via `"@althea/…": "*"`; Next.js transpiles them via `transpilePackages`.
- **Environment variables** are namespaced per service and documented in each service's `.env.example`.
