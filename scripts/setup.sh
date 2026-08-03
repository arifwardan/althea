#!/usr/bin/env bash
# Bootstrap a local development environment.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Starting infrastructure (postgres, redis)"
docker compose up -d postgres redis

echo "==> Setting up services/api"
(
  cd services/api
  uv venv --python 3.12 .venv
  uv pip install -p .venv/bin/python -e ".[dev]"
  [ -f .env ] || cp .env.example .env
  .venv/bin/alembic upgrade head
)

echo "==> Installing frontend workspace"
npm install

echo "==> Done. Run 'make api' and 'make web' in separate terminals."
