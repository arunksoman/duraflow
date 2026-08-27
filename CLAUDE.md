# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout

```
frontend/   SvelteKit app — see frontend/CLAUDE.md
backend/    Go API (Huma + Echo, GORM, SQLite/Postgres) — see backend/CLAUDE.md
```

There is no root-level build tooling — each side is developed and run from within its own folder. Read the relevant subfolder's `CLAUDE.md` before making changes there; this file only covers what spans both.

## Running everything

```sh
cd backend && go run ./cmd/server      # http://localhost:8000, docs at /docs
cd frontend && pnpm install && pnpm dev  # http://localhost:5173
```

The frontend's `API_BASE_URL` (`frontend/src/lib/server/http.ts`) defaults to `http://localhost:8000/api`, matching the backend's default `port`/`basePath` in `backend/config/config.yaml` — no configuration needed to run both together locally. A default admin user is seeded on the backend's first boot (see `backend/config/config.yaml`'s `seedAdmin` section).

## Keeping the two sides in sync

The frontend's domain types (`frontend/src/lib/types/index.ts`) and the backend's GORM models/DTOs (`backend/internal/models`, `backend/internal/api`) are meant to mirror each other field-for-field (camelCase JSON). When changing one, check the other.

The backend currently exposes full CRUD for every domain type (`auth`, `projects`, `workflows`, `executions`, `schedules`, `workers`), but the frontend only calls `auth` and `projects` today — wiring the rest into the frontend (new `src/lib/server/*.ts` wrappers, hooking the builder up to persist the DSL) is a separate, not-yet-done piece of work. See each subfolder's `CLAUDE.md` for detail.
