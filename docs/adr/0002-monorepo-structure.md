# ADR 0002: Monorepo with Apps, Services, and Packages

## Status

Accepted

## Context

ALTHEA spans a desktop shell, a web frontend, and multiple backend services that must evolve together. Cross-cutting changes (API contracts, UI, docs) are frequent in the early phase.

## Decision

Use a single monorepo organized by role:

- `apps/` — deployable user-facing applications (desktop, web)
- `services/` — independently runnable backend services (api, ai-engine, scheduler)
- `packages/` — shared TypeScript libraries (types, shared, ui)

TypeScript code shares a workspace (npm workspaces). Python services are isolated projects that share conventions but not code; they communicate over HTTP.

## Consequences

- Atomic cross-cutting changes and a single source of truth for contracts.
- Python services can be extracted or deployed independently later.
- Requires per-service dependency management (one virtualenv per service).
