# ADR 0003: Tauri Shell over a Statically Exported Next.js App

## Status

Accepted

## Context

ALTHEA is a desktop-first product, but the UI should also be runnable in a browser during development, and the team's frontend stack is Next.js/React.

## Decision

The Next.js app (`apps/web`) is built with `output: "export"` and the Tauri shell (`apps/desktop`) bundles the static export (`frontendDist: ../../web/out`). In development, Tauri points at the Next.js dev server (`devUrl: http://localhost:3000`).

All business logic stays in backend services; the frontend talks to them over HTTP. Server-side Next.js features (server actions, dynamic SSR) are therefore not used.

## Consequences

- One frontend codebase serves both browser and desktop.
- No Next.js server is needed in production; the desktop app is self-contained apart from backend services.
- Features requiring SSR must instead be implemented in `services/api`.
