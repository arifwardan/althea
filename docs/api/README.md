# API Documentation

The core API (`services/api`) serves interactive OpenAPI documentation at
`http://localhost:8000/docs` (Swagger UI) and `http://localhost:8000/redoc` when running.

All endpoints are versioned under `/api/v1`.

## Endpoints

### `GET /api/v1/health`

Liveness check. Always returns `200` while the process is running.

```json
{ "status": "ok", "environment": "development", "version": "0.1.0" }
```

### `GET /api/v1/ready`

Readiness check. Verifies connectivity to PostgreSQL and Redis.

```json
{ "status": "ready", "database": true, "redis": true }
```

`status` is `"degraded"` if either dependency is unreachable.

## AI Engine (`services/ai-engine`, port 8001)

### `GET /health`

```json
{ "status": "ok", "service": "ai-engine" }
```

## TypeScript Contracts

Response shapes are mirrored in [`packages/types`](../../packages/types/src/index.ts) and consumed through the typed client in [`packages/shared`](../../packages/shared/src/index.ts).
